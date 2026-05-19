import {
  DEFAULT_RELAY_STREAM_CHUNK_BYTES,
  RELAY_PROTOCOL_VERSION,
  browserTokenFromHeaders,
  createRequestId,
  filterRequestHeaders,
  filterResponseHeaders,
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
  MAX_BODY_BYTES,
  RELAY_SECRET,
  RELAY_URL,
  REQUEST_TIMEOUT_MS,
  buildLocalRealtimeWsUrl,
  buildLocalUrl,
  buildLocalWsUrl,
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
import {
  decodeBody,
  encodeResponseBody,
  streamRequestBody
} from './relay-mac-client-body.mjs';
import { waitForSocketBackpressure } from './relay-mac-client-backpressure.mjs';

let ws = null;
let relayEpoch = 0;
let relayConnectionId = '';
let reconnectDelayMs = INITIAL_RECONNECT_DELAY_MS;
let heartbeatTimer = null;
let reconnectStableTimer = null;
let localEventWs = null;
let localEventToken = '';
let localStatus = { reachable: false, checkedAt: '' };
let closing = false;
let onlineSinceMs = 0;
let relayActiveUntilMs = 0;
const requestStreams = new Map();
const realtimeTunnels = new Map();

function closeLocalEventSocket() {
  const socket = localEventWs;
  localEventWs = null;
  localEventToken = '';
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.close();
  } else if (socket && socket.readyState === WebSocket.CONNECTING) {
    socket.terminate();
  }
}

function closeRealtimeTunnel(requestId, { code = 1000, reason = 'relay_realtime_closed', notifyRelay = true } = {}) {
  const tunnel = realtimeTunnels.get(requestId);
  if (!tunnel) {
    return;
  }
  realtimeTunnels.delete(requestId);
  if (notifyRelay && ws?.readyState === ws?.OPEN) {
    sendWsJson(ws, {
      type: 'realtime.close',
      requestId,
      macConnectionEpoch: relayEpoch,
      code,
      reason
    });
  }
  if ([tunnel.socket.OPEN, tunnel.socket.CONNECTING].includes(tunnel.socket.readyState)) {
    tunnel.socket.close(code, reason);
  }
}

function closeRealtimeTunnels() {
  for (const requestId of realtimeTunnels.keys()) {
    closeRealtimeTunnel(requestId, { code: 1001, reason: 'relay_disconnected', notifyRelay: false });
  }
}

function forwardLocalEvent(raw) {
  const payload = safeJsonParse(raw.toString());
  if (!payload?.type || payload.type === 'connected') {
    return;
  }
  sendWsJson(ws, {
    type: 'event',
    eventId: payload.eventId || createRequestId(),
    payload
  });
}

function ensureLocalEventSocket(token) {
  const nextToken = String(token || '').trim();
  if (!nextToken) {
    return Promise.resolve(false);
  }
  if (localEventWs?.readyState === WebSocket.OPEN && localEventToken === nextToken) {
    return Promise.resolve(true);
  }
  closeLocalEventSocket();
  localEventToken = nextToken;
  localEventWs = new WebSocket(buildLocalWsUrl(nextToken));
  const socket = localEventWs;
  socket.on('message', forwardLocalEvent);
  socket.on('close', () => {
    if (localEventWs === socket) {
      localEventWs = null;
      localEventToken = '';
    }
  });
  socket.on('error', (error) => {
    logState('local-ws-error', error.message);
  });
  return new Promise((resolve) => {
    socket.once('open', () => resolve(true));
    socket.once('unexpected-response', () => resolve(false));
    socket.once('error', () => resolve(false));
  });
}

async function checkLocalStatus() {
  const checkedAt = new Date().toISOString();
  try {
    const response = await fetch(buildLocalUrl('/api/status'), {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(10000)
    });
    localStatus = {
      reachable: response.ok,
      status: response.status,
      checkedAt
    };
  } catch (error) {
    localStatus = {
      reachable: false,
      error: error?.name === 'TimeoutError' ? 'timeout' : 'unreachable',
      checkedAt
    };
  }
  return localStatus;
}

function sendMacStatus() {
  if (!ws || ws.readyState !== ws.OPEN) {
    return;
  }
  sendWsJson(ws, {
    type: 'mac.status',
    macConnectionEpoch: relayEpoch,
    connectionId: relayConnectionId,
    localStatus
  });
}

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

async function startLocalStatusLoop() {
  await checkLocalStatus();
  sendMacStatus();
  setTimeout(startLocalStatusLoop, localStatus.reachable ? 30000 : 5000).unref?.();
}

async function waitForConnectorBackpressure(maxBufferedBytes) {
  await waitForSocketBackpressure(ws, {
    maxBufferedBytes,
    errorMessage: 'relay_stream_backpressure_timeout'
  });
}

async function handleAuthValidate(message) {
  const requestId = message.requestId;
  try {
    const status = await checkLocalStatus();
    if (!status.reachable) {
      sendWsJson(ws, {
        type: 'auth.validate.result',
        requestId,
        macConnectionEpoch: relayEpoch,
        valid: false,
        error: 'mac_local_offline'
      });
      return;
    }
    const response = await fetch(buildLocalUrl('/api/status'), {
      headers: {
        authorization: `Bearer ${message.token || ''}`,
        accept: 'application/json'
      },
      signal: AbortSignal.timeout(10000)
    });
    const data = await response.json().catch(() => ({}));
    sendWsJson(ws, {
      type: 'auth.validate.result',
      requestId,
      macConnectionEpoch: relayEpoch,
      valid: Boolean(response.ok && data?.auth?.authenticated)
    });
    if (response.ok && data?.auth?.authenticated) {
      await ensureLocalEventSocket(message.token);
    }
  } catch {
    sendWsJson(ws, {
      type: 'auth.validate.result',
      requestId,
      macConnectionEpoch: relayEpoch,
      valid: false,
      error: 'mac_local_offline'
    });
  }
}

async function handleHttpRequest(message) {
  const requestId = message.requestId;
  if (!localStatus.reachable) {
    await checkLocalStatus();
  }
  if (!localStatus.reachable) {
    sendHttpError(requestId, Object.assign(new Error('mac_local_offline'), { status: 503 }));
    return;
  }
  try {
    const response = await fetchLocalHttp(message);
    await sendBufferedHttpResponse(requestId, response);
  } catch (error) {
    sendHttpError(requestId, error);
  }
}

async function fetchLocalHttp(message) {
  const browserToken = browserTokenFromHeaders(message.headers || {});
  if (browserToken) {
    await ensureLocalEventSocket(browserToken);
  }
  const method = String(message.method || 'GET').toUpperCase();
  return fetch(buildLocalUrl(message.path), {
    method,
    headers: filterRequestHeaders(message.headers || {}),
    body: ['GET', 'HEAD'].includes(method) ? undefined : decodeBody(message.bodyEncoding, message.body),
    signal: AbortSignal.timeout(message.timeoutMs || REQUEST_TIMEOUT_MS)
  });
}

async function sendBufferedHttpResponse(requestId, response) {
  const encoded = await encodeResponseBody(response, { maxBodyBytes: MAX_BODY_BYTES });
  if (encoded.type === 'http.error') {
    sendWsJson(ws, { ...encoded, requestId, macConnectionEpoch: relayEpoch });
    return;
  }
  sendWsJson(ws, {
    type: 'http.response',
    requestId,
    macConnectionEpoch: relayEpoch,
    status: response.status,
    headers: filterResponseHeaders(response.headers),
    ...encoded
  });
}

function sendHttpError(requestId, error) {
  sendWsJson(ws, {
    type: 'http.error',
    requestId,
    macConnectionEpoch: relayEpoch,
    status: error?.status || 502,
    error: error?.name === 'TimeoutError' ? 'relay_request_timeout' : error?.message || 'local_request_failed'
  });
}

async function handleHttpStreamRequest(message) {
  const requestId = message.requestId;
  if (!localStatus.reachable) {
    await checkLocalStatus();
  }
  if (!localStatus.reachable) {
    sendStreamError(requestId, Object.assign(new Error('mac_local_offline'), { status: 503 }));
    return;
  }
  try {
    const browserToken = browserTokenFromHeaders(message.headers || {});
    if (browserToken) {
      await ensureLocalEventSocket(browserToken);
    }
    const response = await fetch(buildLocalUrl(message.path), {
      method: message.method || 'GET',
      headers: filterRequestHeaders(message.headers || {}),
      body: streamRequestBody(message),
      signal: AbortSignal.timeout(message.timeoutMs || REQUEST_TIMEOUT_MS)
    });
    await sendStreamingHttpResponse(requestId, response);
  } catch (error) {
    sendStreamError(requestId, error);
  }
}

async function sendStreamingHttpResponse(requestId, response) {
  sendWsJson(ws, {
    type: 'http.response.start',
    requestId,
    macConnectionEpoch: relayEpoch,
    status: response.status,
    headers: filterResponseHeaders(response.headers)
  });
  let sequence = 0;
  let totalBytes = 0;
  if (response.body) {
    for await (const chunk of response.body) {
      const buffer = Buffer.from(chunk);
      for (let offset = 0; offset < buffer.length; offset += DEFAULT_RELAY_STREAM_CHUNK_BYTES) {
        const slice = buffer.subarray(offset, offset + DEFAULT_RELAY_STREAM_CHUNK_BYTES);
        sequence += 1;
        totalBytes += slice.length;
        sendWsJson(ws, {
          type: 'http.response.chunk',
          requestId,
          macConnectionEpoch: relayEpoch,
          sequence,
          encoding: 'base64',
          data: slice.toString('base64'),
          bytes: slice.length
        });
        await waitForConnectorBackpressure();
      }
    }
  }
  sendWsJson(ws, {
    type: 'http.response.end',
    requestId,
    macConnectionEpoch: relayEpoch,
    chunks: sequence,
    totalBytes
  });
}

function createStreamController() {
  let controller;
  const stream = new ReadableStream({
    start(nextController) {
      controller = nextController;
    }
  });
  return { stream, controller };
}

function closeRequestStream(requestId, error) {
  const entry = requestStreams.get(requestId);
  if (!entry) {
    return;
  }
  requestStreams.delete(requestId);
  try {
    if (error) {
      entry.controller.error(error);
    } else {
      entry.controller.close();
    }
  } catch {}
}

async function handleHttpRequestStart(message) {
  const requestId = message.requestId;
  const { stream, controller } = createStreamController();
  requestStreams.set(requestId, { controller, sequence: 0 });
  if (!localStatus.reachable) {
    await checkLocalStatus();
  }
  if (!localStatus.reachable) {
    closeRequestStream(requestId, new Error('mac_local_offline'));
    sendWsJson(ws, {
      type: 'http.error',
      requestId,
      macConnectionEpoch: relayEpoch,
      status: 503,
      error: 'mac_local_offline'
    });
    return;
  }
  try {
    const browserToken = browserTokenFromHeaders(message.headers || {});
    if (browserToken) {
      await ensureLocalEventSocket(browserToken);
    }
    forwardStreamRequest(message, stream);
  } catch (error) {
    closeRequestStream(requestId, error);
    sendStreamError(requestId, error);
  }
}

function forwardStreamRequest(message, stream) {
  fetch(buildLocalUrl(message.path), {
    method: message.method || 'POST',
    headers: filterRequestHeaders(message.headers || {}),
    body: stream,
    duplex: 'half',
    signal: AbortSignal.timeout(message.timeoutMs || REQUEST_TIMEOUT_MS)
  })
    .then((response) => sendStreamResponse(message.requestId, response))
    .catch((error) => sendStreamError(message.requestId, error))
    .finally(() => requestStreams.delete(message.requestId));
}

function sendStreamError(requestId, error) {
  sendWsJson(ws, {
    type: 'http.error',
    requestId,
    macConnectionEpoch: relayEpoch,
    status: error?.status || 502,
    error: error?.name === 'TimeoutError' ? 'relay_request_timeout' : error?.message || 'local_request_failed'
  });
}

function handleHttpRequestChunk(message) {
  const entry = requestStreams.get(message.requestId);
  if (!entry) {
    sendStreamError(message.requestId, Object.assign(new Error('relay_stream_missing'), { status: 502 }));
    return;
  }
  try {
    const chunk = message.encoding === 'base64'
      ? Buffer.from(message.data || '', 'base64')
      : Buffer.from(String(message.data || ''));
    const expectedSequence = entry.sequence + 1;
    if (Number(message.sequence) !== expectedSequence) {
      throw Object.assign(new Error('relay_stream_sequence_mismatch'), { status: 502 });
    }
    if (Number(message.bytes) !== chunk.length) {
      throw Object.assign(new Error('relay_stream_chunk_size_mismatch'), { status: 502 });
    }
    entry.sequence = expectedSequence;
    entry.controller.enqueue(chunk);
  } catch (error) {
    closeRequestStream(message.requestId, error);
    sendStreamError(message.requestId, error);
  }
}

function handleHttpRequestEnd(message) {
  if (!requestStreams.has(message.requestId)) {
    sendStreamError(message.requestId, Object.assign(new Error('relay_stream_missing'), { status: 502 }));
    return;
  }
  closeRequestStream(message.requestId);
}

function handleHttpRequestError(message) {
  closeRequestStream(message.requestId, new Error(message.error || 'relay_stream_aborted'));
}

async function sendStreamResponse(requestId, response) {
  const encoded = await encodeResponseBody(response, { maxBodyBytes: MAX_BODY_BYTES });
  if (encoded.type === 'http.error') {
    sendWsJson(ws, {
      ...encoded,
      requestId,
      macConnectionEpoch: relayEpoch
    });
    return;
  }
  sendWsJson(ws, {
    type: 'http.response',
    requestId,
    macConnectionEpoch: relayEpoch,
    status: response.status,
    headers: filterResponseHeaders(response.headers),
    ...encoded
  });
}

function sendRealtimeError(requestId, error) {
  sendWsJson(ws, {
    type: 'realtime.error',
    requestId,
    macConnectionEpoch: relayEpoch,
    code: error?.code || 1011,
    error: error?.message || 'relay_realtime_failed'
  });
}

async function forwardRealtimeLocalFrame(requestId, raw, isBinary) {
  const tunnel = realtimeTunnels.get(requestId);
  if (!tunnel) {
    return;
  }
  const bytes = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
  tunnel.toRelaySequence += 1;
  await waitForConnectorBackpressure();
  sendWsJson(ws, {
    type: 'realtime.frame',
    requestId,
    macConnectionEpoch: relayEpoch,
    sequence: tunnel.toRelaySequence,
    encoding: isBinary ? 'base64' : 'text',
    data: isBinary ? bytes.toString('base64') : bytes.toString('utf8'),
    bytes: bytes.length
  });
}

function handleRealtimeOpen(message) {
  const requestId = message.requestId;
  const token = String(message.token || '').trim();
  if (!token) {
    sendRealtimeError(requestId, new Error('relay_realtime_token_missing'));
    return;
  }
  closeRealtimeTunnel(requestId, { notifyRelay: false });
  const socket = new WebSocket(buildLocalRealtimeWsUrl(token));
  realtimeTunnels.set(requestId, { socket, toRelaySequence: 0, fromRelaySequence: 0 });
  socket.on('message', (raw, isBinary) => {
    forwardRealtimeLocalFrame(requestId, raw, isBinary).catch((error) => {
      closeRealtimeTunnel(requestId, { code: 1011, reason: error.message, notifyRelay: true });
    });
  });
  socket.on('close', (code, reason) => {
    closeRealtimeTunnel(requestId, { code: code || 1000, reason: reason?.toString() || 'local_realtime_closed' });
  });
  socket.on('unexpected-response', () => {
    sendRealtimeError(requestId, Object.assign(new Error('local_realtime_rejected'), { code: 1011 }));
    closeRealtimeTunnel(requestId, { code: 1011, reason: 'local_realtime_rejected', notifyRelay: false });
  });
  socket.on('error', (error) => {
    sendRealtimeError(requestId, error);
    closeRealtimeTunnel(requestId, { code: 1011, reason: 'local_realtime_error', notifyRelay: false });
  });
}

async function handleRealtimeFrame(message) {
  const tunnel = realtimeTunnels.get(message.requestId);
  if (!tunnel || tunnel.socket.readyState !== tunnel.socket.OPEN) {
    sendRealtimeError(message.requestId, new Error('relay_realtime_socket_missing'));
    return;
  }
  const expectedSequence = tunnel.fromRelaySequence + 1;
  const bytes = Buffer.from(message.data || '', message.encoding === 'base64' ? 'base64' : 'utf8');
  if (Number(message.sequence) !== expectedSequence || Number(message.bytes) !== bytes.length) {
    closeRealtimeTunnel(message.requestId, { code: 1011, reason: 'relay_realtime_frame_invalid' });
    return;
  }
  await waitForSocketBackpressure(tunnel.socket);
  tunnel.fromRelaySequence = expectedSequence;
  tunnel.socket.send(message.encoding === 'base64' ? bytes : bytes.toString('utf8'), {
    binary: message.encoding === 'base64'
  });
}

function handleRealtimeClose(message) {
  closeRealtimeTunnel(message.requestId, {
    code: message.code || 1000,
    reason: message.reason || 'relay_realtime_closed',
    notifyRelay: false
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
  sendMacStatus();
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
    handleAuthValidate(message);
    return;
  }
  if (message.type === 'http.request') {
    noteRelayActive();
    handleHttpRequest(message);
    return;
  }
  if (message.type === 'http.stream.request') {
    noteRelayActive();
    handleHttpStreamRequest(message);
    return;
  }
  if (message.type === 'http.request.start') {
    noteRelayActive();
    handleHttpRequestStart(message);
    return;
  }
  if (message.type === 'http.request.chunk') {
    noteRelayActive();
    handleHttpRequestChunk(message);
    return;
  }
  if (message.type === 'http.request.end') {
    noteRelayActive();
    handleHttpRequestEnd(message);
    return;
  }
  if (message.type === 'http.request.error') {
    noteRelayActive();
    handleHttpRequestError(message);
    return;
  }
  if (message.type === 'realtime.open') {
    noteRelayActive();
    handleRealtimeOpen(message);
    return;
  }
  if (message.type === 'realtime.frame') {
    noteRelayActive();
    handleRealtimeFrame(message).catch((error) => sendRealtimeError(message.requestId, error));
    return;
  }
  if (message.type === 'realtime.close') {
    noteRelayActive();
    handleRealtimeClose(message);
  }
}

function scheduleHeartbeat(interval = HEARTBEAT_MS) {
  clearTimeout(heartbeatTimer);
  heartbeatTimer = setTimeout(() => {
    sendMacStatus();
    scheduleHeartbeat(localStatus.reachable ? HEARTBEAT_MS : Math.min(IDLE_HEARTBEAT_MS, 60000));
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
    await checkLocalStatus();
    sendWsJson(ws, jsonMessage('mac.hello', {
      connectorInstanceId,
      deviceName: DEVICE_NAME,
      startedAt: new Date().toISOString(),
      clientVersion: '0.1.0',
      localStatus,
      capabilities: ['http', 'events', 'realtime']
    }));
    scheduleHeartbeat();
  });
  ws.on('message', handleMessage);
  ws.on('close', (code, reason) => {
    clearTimeout(heartbeatTimer);
    clearTimeout(reconnectStableTimer);
    closeLocalEventSocket();
    closeRealtimeTunnels();
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
    ws?.close();
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    closing = true;
    ws?.close();
    process.exit(0);
  });

  requireConfig();
  startLocalStatusLoop();
  connect();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
