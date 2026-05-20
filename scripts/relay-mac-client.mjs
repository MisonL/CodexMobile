import {
  RELAY_PROTOCOL_VERSION,
  jsonMessage,
  safeJsonParse,
  sendWsJson
} from '../server/relay-protocol.js';
import WebSocket from 'ws';
import { pathToFileURL } from 'node:url';
import {
  DEVICE_NAME,
  HEARTBEAT_MS,
  IDLE_HEARTBEAT_MS,
  RELAY_KEEPALIVE_MS,
  RELAY_SECRET,
  RELAY_URL,
  connectorInstanceId,
  logState,
  requireConfig
} from './relay-mac-client-config.mjs';
import {
  ACTIVE_RECONNECT_CAP_MS,
  INITIAL_RECONNECT_DELAY_MS,
  STABLE_RECONNECT_RESET_MS,
  nextReconnectDelay,
  shouldResetReconnectDelay
} from './relay-mac-client-reconnect.mjs';
import { createHttpForwarder } from './relay-mac-client-http.mjs';
import { createLocalServiceMonitor } from './relay-mac-client-local.mjs';
import { createRealtimeTunnelClient } from './relay-mac-client-realtime.mjs';
import { waitForSocketBackpressure } from './relay-mac-client-backpressure.mjs';
import { createRelayKeepalive } from './relay-mac-client-keepalive.mjs';

let ws = null;
let relayEpoch = 0;
let relayConnectionId = '';
let reconnectDelayMs = INITIAL_RECONNECT_DELAY_MS;
let heartbeatTimer = null;
let reconnectStableTimer = null;
let closing = false;
let onlineSinceMs = 0;
let relayActiveUntilMs = 0;
const localService = createLocalServiceMonitor({
  getRelaySocket: () => ws,
  getRelayEpoch: () => relayEpoch,
  getRelayConnectionId: () => relayConnectionId
});
const httpForwarder = createHttpForwarder({
  getRelaySocket: () => ws,
  getRelayEpoch: () => relayEpoch,
  getLocalStatus: localService.getStatus,
  checkLocalStatus: localService.checkStatus,
  ensureLocalEventSocket: localService.ensureEventSocket,
  waitForRelayBackpressure: waitForConnectorBackpressure
});
const realtime = createRealtimeTunnelClient({
  getRelaySocket: () => ws,
  getRelayEpoch: () => relayEpoch,
  waitForRelayBackpressure: waitForConnectorBackpressure
});
let relayKeepalive = null;

function noteRelayActive() {
  relayActiveUntilMs = Date.now() + ACTIVE_RECONNECT_CAP_MS;
}

function scheduleReconnectDelayReset(socket) {
  clearTimeout(reconnectStableTimer);
  reconnectStableTimer = setTimeout(() => {
    const stillOnline = socket === ws && socket?.readyState === WebSocket.OPEN;
    if (stillOnline && shouldResetReconnectDelay(Date.now() - onlineSinceMs)) {
      reconnectDelayMs = INITIAL_RECONNECT_DELAY_MS;
    }
  }, STABLE_RECONNECT_RESET_MS);
  reconnectStableTimer.unref?.();
}

async function waitForConnectorBackpressure(maxBufferedBytes) {
  await waitForSocketBackpressure(ws, {
    maxBufferedBytes,
    errorMessage: 'relay_stream_backpressure_timeout'
  });
}

function handleMessage(raw) {
  const message = safeJsonParse(raw.toString());
  if (!message?.type) {
    return;
  }
  if (message.type === 'relay.hello') {
    handleRelayHello(message);
    return;
  }
  if (message.macConnectionEpoch && message.macConnectionEpoch !== relayEpoch) {
    return;
  }
  if (message.type === 'ping') {
    handleRelayPing(message);
    return;
  }
  dispatchRelayMessage(message);
}

function handleRelayHello(message) {
  relayEpoch = Number(message.macConnectionEpoch || 0);
  relayConnectionId = message.connectionId || '';
  onlineSinceMs = Date.now();
  scheduleReconnectDelayReset(ws);
  logState('online', `epoch=${relayEpoch}`);
  localService.sendStatus();
}

function handleRelayPing(message) {
  if (message.active) {
    noteRelayActive();
  }
  sendWsJson(ws, { type: 'pong', sentAt: message.sentAt || Date.now() });
}

function dispatchRelayMessage(message) {
  if (message.type === 'auth.validate') {
    noteRelayActive();
    httpForwarder.handleAuthValidate(message);
    return;
  }
  if (message.type === 'http.request') {
    noteRelayActive();
    httpForwarder.handleHttpRequest(message);
    return;
  }
  if (message.type === 'http.stream.request') {
    noteRelayActive();
    httpForwarder.handleHttpStreamRequest(message);
    return;
  }
  if (message.type === 'http.request.start') {
    noteRelayActive();
    httpForwarder.handleHttpRequestStart(message);
    return;
  }
  if (message.type === 'http.request.chunk') {
    noteRelayActive();
    httpForwarder.handleHttpRequestChunk(message);
    return;
  }
  if (message.type === 'http.request.end') {
    noteRelayActive();
    httpForwarder.handleHttpRequestEnd(message);
    return;
  }
  if (message.type === 'http.request.error') {
    noteRelayActive();
    httpForwarder.handleHttpRequestError(message);
    return;
  }
  if (message.type === 'realtime.open') {
    noteRelayActive();
    realtime.handleOpen(message);
    return;
  }
  if (message.type === 'realtime.frame') {
    noteRelayActive();
    realtime.handleFrame(message).catch((error) => realtime.sendError(message.requestId, error));
    return;
  }
  if (message.type === 'realtime.close') {
    noteRelayActive();
    realtime.handleClose(message);
  }
}

function scheduleHeartbeat(interval = HEARTBEAT_MS) {
  clearTimeout(heartbeatTimer);
  heartbeatTimer = setTimeout(() => {
    localService.sendStatus();
    scheduleHeartbeat(localService.getStatus().reachable ? HEARTBEAT_MS : Math.min(IDLE_HEARTBEAT_MS, 60000));
  }, interval);
  heartbeatTimer.unref?.();
}

function connect() {
  logState('connecting');
  ws = new WebSocket(RELAY_URL, {
    headers: {
      authorization: `Bearer ${RELAY_SECRET}`
    }
  });
  ws.on('open', async () => {
    logState('authenticating');
    await localService.checkStatus();
    sendWsJson(ws, jsonMessage('mac.hello', {
      connectorInstanceId,
      deviceName: DEVICE_NAME,
      startedAt: new Date().toISOString(),
      clientVersion: '0.1.0',
      localStatus: localService.getStatus(),
      capabilities: ['http', 'events', 'realtime']
    }));
    scheduleHeartbeat();
  });
  ws.on('message', handleMessage);
  ws.on('close', (code, reason) => {
    clearTimeout(heartbeatTimer);
    clearTimeout(reconnectStableTimer);
    localService.closeEventSocket();
    realtime.closeAll();
    logState('reconnecting', `${code}:${reason || ''}`);
    if (!closing) {
      if (shouldResetReconnectDelay(Date.now() - onlineSinceMs)) {
        reconnectDelayMs = INITIAL_RECONNECT_DELAY_MS;
      }
      const delay = nextReconnectDelay(reconnectDelayMs, {
        active: Date.now() < relayActiveUntilMs,
        idleHeartbeatMs: IDLE_HEARTBEAT_MS
      });
      reconnectDelayMs = delay.nextDelayMs;
      onlineSinceMs = 0;
      setTimeout(connect, delay.delayMs);
    }
  });
  ws.on('error', (error) => {
    logState('error', error.message);
  });
}

function main() {
  process.on('SIGINT', () => {
    closing = true;
    relayKeepalive?.stop();
    ws?.close();
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    closing = true;
    relayKeepalive?.stop();
    ws?.close();
    process.exit(0);
  });

  requireConfig();
  relayKeepalive = createRelayKeepalive({
    relayUrl: RELAY_URL,
    intervalMs: RELAY_KEEPALIVE_MS,
    logState
  });
  relayKeepalive.start();
  localService.startStatusLoop();
  connect();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
