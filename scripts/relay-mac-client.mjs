import {
  DEFAULT_RELAY_HEARTBEAT_MS,
  DEFAULT_RELAY_IDLE_HEARTBEAT_MS,
  DEFAULT_RELAY_REQUEST_TIMEOUT_MS,
  RELAY_PROTOCOL_VERSION,
  browserTokenFromHeaders,
  buildLocalTargetUrl,
  createConnectorInstanceId,
  createRequestId,
  filterRequestHeaders,
  filterResponseHeaders,
  isStrongRelaySecret,
  jsonMessage,
  parsePositiveInt,
  safeJsonParse,
  sendWsJson
} from '../server/relay-protocol.js';
import WebSocket from 'ws';
import { pathToFileURL } from 'node:url';

const INITIAL_RECONNECT_DELAY_MS = 1000;
const ACTIVE_RECONNECT_CAP_MS = 30000;
const STABLE_RECONNECT_RESET_MS = 60000;

const RELAY_URL = String(process.env.CODEXMOBILE_RELAY_URL || '').trim();
const RELAY_SECRET = String(process.env.CODEXMOBILE_RELAY_SECRET || '').trim();
const DEVICE_NAME = String(process.env.CODEXMOBILE_RELAY_DEVICE_NAME || '').trim() || `${process.env.USER || 'mac'}-mac`;
const LOCAL_URL = String(process.env.CODEXMOBILE_RELAY_LOCAL_URL || 'http://127.0.0.1:3321').replace(/\/+$/, '');
const HEARTBEAT_MS = parsePositiveInt(process.env.CODEXMOBILE_RELAY_HEARTBEAT_MS, DEFAULT_RELAY_HEARTBEAT_MS);
const IDLE_HEARTBEAT_MS = parsePositiveInt(process.env.CODEXMOBILE_RELAY_IDLE_HEARTBEAT_MS, DEFAULT_RELAY_IDLE_HEARTBEAT_MS);
const REQUEST_TIMEOUT_MS = parsePositiveInt(process.env.CODEXMOBILE_RELAY_REQUEST_TIMEOUT_MS, DEFAULT_RELAY_REQUEST_TIMEOUT_MS);
const MAX_BODY_BYTES = parsePositiveInt(process.env.CODEXMOBILE_RELAY_SMALL_BODY_BYTES, 2 * 1024 * 1024);
const connectorInstanceId = process.env.CODEXMOBILE_RELAY_CONNECTOR_ID || createConnectorInstanceId();

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

export function nextReconnectDelay(currentDelayMs, { active = false, idleHeartbeatMs = DEFAULT_RELAY_IDLE_HEARTBEAT_MS } = {}) {
  const capMs = active ? ACTIVE_RECONNECT_CAP_MS : idleHeartbeatMs;
  const delayMs = Math.min(Math.max(Number(currentDelayMs) || INITIAL_RECONNECT_DELAY_MS, INITIAL_RECONNECT_DELAY_MS), capMs);
  return {
    delayMs,
    nextDelayMs: Math.min(delayMs * 2, capMs)
  };
}

export function shouldResetReconnectDelay(onlineForMs) {
  return Number(onlineForMs) >= STABLE_RECONNECT_RESET_MS;
}

function requireConfig() {
  if (!RELAY_URL) {
    throw new Error('CODEXMOBILE_RELAY_URL is required.');
  }
  if (!isStrongRelaySecret(RELAY_SECRET)) {
    throw new Error('CODEXMOBILE_RELAY_SECRET must be at least 32 characters.');
  }
}

function logState(state, reason = '') {
  const suffix = reason ? ` reason=${reason}` : '';
  console.log(`[relay:mac] state=${state} relay=${RELAY_URL}${suffix}`);
}

function buildLocalUrl(path) {
  return buildLocalTargetUrl(path, LOCAL_URL);
}

function buildLocalWsUrl(token) {
  const url = new URL(buildLocalUrl(`/ws?token=${encodeURIComponent(token)}`));
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
}

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

function decodeBody(bodyEncoding, body) {
  if (!body) {
    return undefined;
  }
  if (bodyEncoding === 'json') {
    return typeof body === 'string' ? body : JSON.stringify(body);
  }
  if (bodyEncoding === 'base64') {
    return Buffer.from(body, 'base64');
  }
  return String(body);
}

async function encodeResponseBody(response) {
  const contentType = response.headers.get('content-type') || '';
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > MAX_BODY_BYTES) {
    return {
      type: 'http.error',
      status: 501,
      error: 'relay_streaming_required'
    };
  }
  if (/application\/json/i.test(contentType)) {
    const text = buffer.toString('utf8');
    return {
      bodyEncoding: 'json',
      body: safeJsonParse(text) ?? {}
    };
  }
  if (/^text\//i.test(contentType) || /charset=utf-8/i.test(contentType)) {
    return {
      bodyEncoding: 'text',
      body: buffer.toString('utf8')
    };
  }
  return {
    bodyEncoding: 'base64',
    body: buffer.toString('base64')
  };
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
    const body = decodeBody(message.bodyEncoding, message.body);
    const response = await fetch(buildLocalUrl(message.path), {
      method: message.method || 'GET',
      headers: filterRequestHeaders(message.headers || {}),
      body: ['GET', 'HEAD'].includes(String(message.method || 'GET').toUpperCase()) ? undefined : body,
      signal: AbortSignal.timeout(message.timeoutMs || REQUEST_TIMEOUT_MS)
    });
    const encoded = await encodeResponseBody(response);
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
  } catch (error) {
    sendWsJson(ws, {
      type: 'http.error',
      requestId,
      macConnectionEpoch: relayEpoch,
      status: error?.status || 502,
      error: error?.name === 'TimeoutError' ? 'relay_request_timeout' : error?.message || 'local_request_failed'
    });
  }
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
  const encoded = await encodeResponseBody(response);
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

function handleMessage(raw) {
  const message = safeJsonParse(raw.toString());
  if (!message?.type) {
    return;
  }
  if (message.type === 'relay.hello') {
    relayEpoch = Number(message.macConnectionEpoch || 0);
    relayConnectionId = message.connectionId || '';
    onlineSinceMs = Date.now();
    scheduleReconnectDelayReset(ws);
    logState('online', `epoch=${relayEpoch}`);
    sendMacStatus();
    return;
  }
  if (message.macConnectionEpoch && message.macConnectionEpoch !== relayEpoch) {
    return;
  }
  if (message.type === 'ping') {
    if (message.active) {
      noteRelayActive();
    }
    sendWsJson(ws, { type: 'pong', sentAt: message.sentAt || Date.now() });
    return;
  }
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
      capabilities: ['http', 'events']
    }));
    scheduleHeartbeat();
  });
  ws.on('message', handleMessage);
  ws.on('close', (code, reason) => {
    clearTimeout(heartbeatTimer);
    clearTimeout(reconnectStableTimer);
    closeLocalEventSocket();
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
