import {
  RELAY_PROTOCOL_VERSION,
  createRequestId,
  logRelayEvent,
  safeJsonParse,
  sendWsJson,
  timingSafeTextEqual
} from './relay-protocol.js';
import { createBrowserTokenCache } from './relay-runtime-token-cache.js';
import { createMacConnectionManager } from './relay-runtime-mac.js';
import { createPendingRequestStore } from './relay-runtime-pending.js';
import { createRealtimeTunnelManager } from './relay-runtime-realtime.js';
import { createStreamResponseHandler } from './relay-runtime-stream-response.js';
import {
  buildRelayStatus,
  createRelayMetrics
} from './relay-runtime-status.js';

export function createRelayRuntime({
  relaySecret,
  previousRelaySecret = '',
  requestTimeoutMs,
  heartbeatMs,
  idleHeartbeatMs = heartbeatMs,
  tokenCacheTtlMs,
  pendingRequestsMax = 64,
  browserPendingRequestsMax = 6,
  browserTokenRequestsPerMinute = 120,
  browserTokenRequestWindowMs = 60000,
  requestBodyMaxBytes = 0
}) {
  const browserSockets = new Set();
  const realtimeSockets = new Map();
  const browserTokenCache = createBrowserTokenCache({ ttlMs: tokenCacheTtlMs });
  const metrics = createRelayMetrics();
  let mac = null;
  const pendingRequests = createPendingRequestStore({
    createRequestId,
    metrics,
    onChanged: () => mac?.scheduleHeartbeat(),
    pendingRequestsMax,
    browserPendingRequestsMax
  });

  const relayStartedAt = new Date().toISOString();
  mac = createMacConnectionManager({
    createRequestId,
    heartbeatMs,
    idleHeartbeatMs,
    metrics,
    pendingRequests,
    hasActiveBrowserWork: () => browserSockets.size > 0,
    broadcastStatus: () => broadcast({ type: 'relay-status', ...currentRelayStatus(true) }),
    closeRealtimeForEpoch: (epoch, reason) => realtime.closeForEpoch(epoch, reason)
  });
  const streamResponseHandler = createStreamResponseHandler({ pendingRequests });
  const realtime = createRealtimeTunnelManager({
    realtimeSockets,
    createRequestId,
    getMacSocket: () => mac.getSocket(),
    getMacConnectionEpoch: () => mac.getEpoch(),
    assertMacAvailable: (...args) => mac.assertAvailable(...args),
    browserTokenKey: (token) => browserTokenCache.key(token),
    metrics,
    scheduleHeartbeat: () => mac.scheduleHeartbeat()
  });

  const hasCachedBrowserToken = (token) => {
    return browserTokenCache.has(token);
  };

  const isValidRelaySecret = (value) => {
    if (!value) {
      return false;
    }
    return (
      timingSafeTextEqual(value, relaySecret) ||
      (Boolean(previousRelaySecret) && timingSafeTextEqual(value, previousRelaySecret))
    );
  };

  function currentRelayStatus(authenticated = false) {
    browserTokenCache.cleanup();
    return buildRelayStatus({
      authenticated,
      browserSocketsCurrent: browserSockets.size,
      heartbeatMs,
      idleHeartbeatMs,
      macConnectionEpoch: mac.getEpoch(),
      macConnected: mac.isConnected(),
      macInfo: mac.getInfo(),
      metrics,
      pendingRelayRequests: pendingRequests.size,
      pendingRequestsMax,
      browserPendingRequestsMax,
      browserTokenRequestsPerMinute,
      browserTokenRequestWindowMs,
      requestBodyMaxBytes,
      previousRelaySecret,
      realtimeSocketsCurrent: realtimeSockets.size,
      relayStartedAt
    });
  }

  function broadcast(payload) {
    const serialized = JSON.stringify(payload);
    for (const socket of browserSockets) {
      if (socket.readyState === socket.OPEN) {
        socket.send(serialized);
      }
    }
  }

  function createPendingMacRequest(envelope, timeoutMs = requestTimeoutMs, { clientKey = '', streamHandlers = null } = {}) {
    mac.assertAvailable(envelope, clientKey);
    return pendingRequests.create({
      envelope,
      timeoutMs,
      epoch: mac.getEpoch(),
      clientKey,
      streamHandlers
    });
  }

  function requestMac(envelope, timeoutMs = requestTimeoutMs, { clientKey = '' } = {}) {
    const started = createPendingMacRequest(envelope, timeoutMs, { clientKey });
    if (!sendWsJson(mac.getSocket(), { ...envelope, requestId: started.requestId, macConnectionEpoch: started.epoch })) {
      failMacRequest(started.requestId, 503, 'mac_offline');
    }
    return started.response;
  }

  function requestMacStream(envelope, handlers, timeoutMs = requestTimeoutMs, { clientKey = '' } = {}) {
    const started = createPendingMacRequest(envelope, timeoutMs, { clientKey, streamHandlers: handlers });
    if (!sendWsJson(mac.getSocket(), { ...envelope, requestId: started.requestId, macConnectionEpoch: started.epoch })) {
      failMacRequest(started.requestId, 503, 'mac_offline');
    }
    return started.response;
  }

  function beginMacRequest(envelope, timeoutMs = requestTimeoutMs, { clientKey = '' } = {}) {
    const started = createPendingMacRequest(envelope, timeoutMs, { clientKey });
    if (!sendWsJson(mac.getSocket(), { ...envelope, requestId: started.requestId, macConnectionEpoch: started.epoch })) {
      failMacRequest(started.requestId, 503, 'mac_offline');
      throw Object.assign(new Error('mac_offline'), { status: 503 });
    }
    return {
      requestId: started.requestId,
      macConnectionEpoch: started.epoch,
      response: started.response
    };
  }

  function sendMacRequestFrame(requestId, frame) {
    const pending = pendingRequests.get(requestId);
    if (!pending) {
      throw Object.assign(new Error('relay_request_missing'), { status: 502 });
    }
    const macSocket = mac.getSocket();
    if (!macSocket || macSocket.readyState !== macSocket.OPEN || pending.epoch !== mac.getEpoch()) {
      throw Object.assign(new Error('mac_offline'), { status: 503 });
    }
    const sent = sendWsJson(macSocket, {
      ...frame,
      requestId,
      macConnectionEpoch: pending.epoch
    });
    if (!sent) {
      throw Object.assign(new Error('mac_offline'), { status: 503 });
    }
    return macSocket.bufferedAmount || 0;
  }

  function failMacRequest(requestId, status, error) {
    pendingRequests.fail(requestId, status, error);
  }

  function macBufferedAmount() {
    return mac.bufferedAmount();
  }

  async function validateBrowserToken(token) {
    if (!token) {
      return false;
    }
    browserTokenCache.cleanup();
    if (browserTokenCache.has(token)) {
      return true;
    }
    const timeoutMs = Math.min(requestTimeoutMs, 30000);
    const response = await requestMac({ type: 'auth.validate', token, timeoutMs }, timeoutMs);
    if (response?.error) {
      throw Object.assign(new Error(response.error), { status: response.status || 503 });
    }
    if (!response?.valid) {
      metrics.authValidationMissTotal += 1;
      return false;
    }
    browserTokenCache.setValid(token);
    return true;
  }

  function handleResponsePayload(payload) {
    const pending = pendingRequests.get(payload.requestId);
    if (!pending || (payload.macConnectionEpoch && payload.macConnectionEpoch !== pending.epoch)) {
      return;
    }
    if (payload.type === 'http.error') {
      pendingRequests.settle(payload.requestId, (settled) => settled.reject(Object.assign(new Error(payload.error || 'relay_upstream_error'), {
        status: payload.status || 502
      })));
      return;
    }
    pendingRequests.settle(payload.requestId, (settled) => settled.resolve(payload));
  }

  async function handleMacMessage(ws, message) {
    const payload = safeJsonParse(message.toString());
    if (!payload?.type) {
      ws.close(4002, 'invalid_message');
      return;
    }
    if (payload.type === 'mac.hello') {
      if (payload.protocolVersion !== RELAY_PROTOCOL_VERSION) {
        ws.close(4003, 'unsupported_protocol');
        return;
      }
      mac.attachSocket(ws, payload);
      return;
    }
    if (payload.type === 'pong') {
      mac.recordPong(ws, payload.sentAt);
      return;
    }
    if (payload.type === 'mac.status') {
      mac.updateLocalStatus(ws, payload.localStatus);
      return;
    }
    if (payload.type === 'event' && ws === mac.getSocket() && payload.payload) {
      broadcast(payload.payload);
      return;
    }
    if (['http.response.start', 'http.response.chunk', 'http.response.end', 'http.stream.error'].includes(payload.type)) {
      try {
        await streamResponseHandler.handle(payload);
      } catch (error) {
        failMacRequest(payload.requestId, error.status || 502, error.message || 'relay_stream_error');
      }
      return;
    }
    if (['realtime.frame', 'realtime.close', 'realtime.error'].includes(payload.type)) {
      realtime.handleMacPayload(payload);
      return;
    }
    if (['http.response', 'http.error', 'auth.validate.result'].includes(payload.type)) {
      handleResponsePayload(payload);
    }
  }

  function acceptMacSocket(ws) {
    mac.acceptSocket(ws, handleMacMessage);
  }

  function acceptBrowserSocket(ws) {
    browserSockets.add(ws);
    mac.scheduleHeartbeat();
    logRelayEvent('browser.ws.connected', { browserSocketsCurrent: browserSockets.size });
    ws.on('close', () => {
      browserSockets.delete(ws);
      logRelayEvent('browser.ws.disconnected', { browserSocketsCurrent: browserSockets.size });
      mac.scheduleHeartbeat();
    });
    ws.on('error', () => {
      browserSockets.delete(ws);
      logRelayEvent('browser.ws.disconnected', { browserSocketsCurrent: browserSockets.size });
      mac.scheduleHeartbeat();
    });
    sendWsJson(ws, { type: 'connected', status: currentRelayStatus(true) });
  }

  return {
    relaySecret,
    isValidRelaySecret,
    metrics,
    currentRelayStatus,
    requestMac,
    requestMacStream,
    beginMacRequest,
    sendMacRequestFrame,
    failMacRequest,
    macBufferedAmount,
    hasCachedBrowserToken,
    validateBrowserToken,
    acceptMacSocket,
    acceptBrowserSocket,
    acceptRealtimeSocket: realtime.acceptSocket
  };
}
