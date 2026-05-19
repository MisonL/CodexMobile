import {
  DEFAULT_RELAY_WS_BUFFERED_BYTES,
  RELAY_PROTOCOL_VERSION,
  createRequestId,
  jsonMessage,
  logRelayEvent,
  safeJsonParse,
  sendWsJson
} from './relay-protocol.js';
import { createBrowserTokenCache } from './relay-runtime-token-cache.js';
import { createPendingRequestStore } from './relay-runtime-pending.js';
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
  requestBodyMaxBytes = 0
}) {
  const browserSockets = new Set();
  const realtimeSockets = new Map();
  const browserTokenCache = createBrowserTokenCache({ ttlMs: tokenCacheTtlMs });
  const metrics = createRelayMetrics();
  const pendingRequests = createPendingRequestStore({
    createRequestId,
    metrics,
    onChanged: () => scheduleHeartbeat(),
    pendingRequestsMax,
    browserPendingRequestsMax
  });

  let macSocket = null;
  let macInfo = null;
  let macConnectionEpoch = 0;
  let heartbeatTimer = null;
  const relayStartedAt = new Date().toISOString();

  function hasCachedBrowserToken(token) {
    return browserTokenCache.has(token);
  }

  function isValidRelaySecret(value) {
    return Boolean(value && (value === relaySecret || value === previousRelaySecret));
  }

  function currentRelayStatus(authenticated = false) {
    browserTokenCache.cleanup();
    return buildRelayStatus({
      authenticated,
      browserSocketsCurrent: browserSockets.size,
      heartbeatMs,
      idleHeartbeatMs,
      macConnectionEpoch,
      macConnected: Boolean(macSocket && macSocket.readyState === macSocket.OPEN),
      macInfo,
      metrics,
      pendingRelayRequests: pendingRequests.size,
      pendingRequestsMax,
      browserPendingRequestsMax,
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

  function closeRealtimeForEpoch(epoch, reason) {
    for (const session of realtimeSockets.values()) {
      if (session.epoch === epoch) {
        closeRealtimeSession(session, { code: 1011, reason, notifyMac: false });
      }
    }
  }

  function assertMacAvailable(envelope, clientKey = '') {
    if (!macSocket || macSocket.readyState !== macSocket.OPEN) {
      throw Object.assign(new Error('mac_offline'), { status: 503 });
    }
    if (macInfo?.localStatus?.reachable === false && envelope.type !== 'auth.validate') {
      throw Object.assign(new Error('mac_local_offline'), { status: 503 });
    }
    pendingRequests.assertCapacity(clientKey);
  }

  function heartbeatInterval() {
    return browserSockets.size > 0 || pendingRequests.size > 0 ? heartbeatMs : idleHeartbeatMs;
  }

  function detachMacSocket(ws) {
    if (ws !== macSocket) {
      return;
    }
    const oldEpoch = macConnectionEpoch;
    macSocket = null;
    if (macInfo) {
      macInfo.lastSeenAt = new Date().toISOString();
    }
    metrics.macDisconnectsTotal += 1;
    pendingRequests.failForEpoch(oldEpoch, 502, 'mac_offline');
    closeRealtimeForEpoch(oldEpoch, 'mac_offline');
    broadcast({ type: 'relay-status', ...currentRelayStatus(true) });
    clearTimeout(heartbeatTimer);
    heartbeatTimer = null;
    logRelayEvent('mac.disconnected', { macConnectionEpoch: oldEpoch });
  }

  function scheduleHeartbeat() {
    clearTimeout(heartbeatTimer);
    if (!macSocket || macSocket.readyState !== macSocket.OPEN) {
      return;
    }
    heartbeatTimer = setTimeout(() => {
      if (!macSocket || macSocket.readyState !== macSocket.OPEN) {
        return;
      }
      const sentAt = Date.now();
      const active = heartbeatInterval() === heartbeatMs;
      if (!sendWsJson(macSocket, { type: 'ping', sentAt, active })) {
        return;
      }
      const socketAtPing = macSocket;
      setTimeout(() => {
        const socketOpen = socketAtPing === macSocket && socketAtPing.readyState === socketAtPing.OPEN;
        if (socketOpen && Number(socketAtPing.lastPongAt || 0) < sentAt) {
          metrics.macHeartbeatMissesTotal += 1;
          logRelayEvent('mac.heartbeat_missed', { macConnectionEpoch });
        }
      }, Math.min(heartbeatMs, 10000));
      scheduleHeartbeat();
    }, heartbeatInterval());
  }

  function attachMacSocket(ws, hello = {}) {
    const nextConnectorId = String(hello.connectorInstanceId || '').trim();
    if (!nextConnectorId) {
      ws.close(4002, 'invalid_connector_instance_id');
      logRelayEvent('mac.rejected', { reason: 'invalid_connector_instance_id' }, 'warn');
      return;
    }
    if (macSocket && macSocket.readyState === macSocket.OPEN) {
      if (macInfo?.connectorInstanceId !== nextConnectorId) {
        metrics.multiMacRejectedTotal += 1;
        ws.close(4009, 'ambiguous_mac_route');
        logRelayEvent('mac.rejected', {
          reason: 'ambiguous_mac_route',
          activeConnectorInstanceId: macInfo.connectorInstanceId,
          rejectedConnectorInstanceId: nextConnectorId
        }, 'warn');
        return;
      }
      const oldEpoch = macConnectionEpoch;
      pendingRequests.failForEpoch(oldEpoch, 502, 'mac_reconnected');
      closeRealtimeForEpoch(oldEpoch, 'mac_reconnected');
      try {
        macSocket.close(4000, 'mac_reconnected');
      } catch {
        macSocket.terminate();
      }
    }

    macConnectionEpoch += 1;
    macSocket = ws;
    macInfo = {
      connectorInstanceId: nextConnectorId,
      connectionId: createRequestId(),
      deviceName: hello.deviceName || 'Mac',
      clientVersion: hello.clientVersion || '',
      connectedAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
      localStatus: hello.localStatus || { reachable: false, checkedAt: '' },
      protocolVersion: hello.protocolVersion || RELAY_PROTOCOL_VERSION
    };
    metrics.macConnectsTotal += 1;
    sendWsJson(ws, jsonMessage('relay.hello', {
      connectionId: macInfo.connectionId,
      macConnectionEpoch,
      serverTime: new Date().toISOString(),
      accepted: true
    }));
    broadcast({ type: 'relay-status', ...currentRelayStatus(true) });
    scheduleHeartbeat();
    logRelayEvent('mac.connected', {
      macConnectionEpoch,
      deviceName: macInfo.deviceName,
      connectorInstanceId: macInfo.connectorInstanceId
    });
  }

  function createPendingMacRequest(envelope, timeoutMs = requestTimeoutMs, { clientKey = '', streamHandlers = null } = {}) {
    assertMacAvailable(envelope, clientKey);
    return pendingRequests.create({
      envelope,
      timeoutMs,
      epoch: macConnectionEpoch,
      clientKey,
      streamHandlers
    });
  }

  function requestMac(envelope, timeoutMs = requestTimeoutMs, { clientKey = '' } = {}) {
    const started = createPendingMacRequest(envelope, timeoutMs, { clientKey });
    if (!sendWsJson(macSocket, { ...envelope, requestId: started.requestId, macConnectionEpoch: started.epoch })) {
      failMacRequest(started.requestId, 503, 'mac_offline');
    }
    return started.response;
  }

  function requestMacStream(envelope, handlers, timeoutMs = requestTimeoutMs, { clientKey = '' } = {}) {
    const started = createPendingMacRequest(envelope, timeoutMs, { clientKey, streamHandlers: handlers });
    if (!sendWsJson(macSocket, { ...envelope, requestId: started.requestId, macConnectionEpoch: started.epoch })) {
      failMacRequest(started.requestId, 503, 'mac_offline');
    }
    return started.response;
  }

  function beginMacRequest(envelope, timeoutMs = requestTimeoutMs, { clientKey = '' } = {}) {
    const started = createPendingMacRequest(envelope, timeoutMs, { clientKey });
    if (!sendWsJson(macSocket, { ...envelope, requestId: started.requestId, macConnectionEpoch: started.epoch })) {
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
    if (!macSocket || macSocket.readyState !== macSocket.OPEN || pending.epoch !== macConnectionEpoch) {
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
    return macSocket?.bufferedAmount || 0;
  }

  function sendRealtimeMacFrame(session, patch) {
    if (!realtimeSockets.has(session.requestId)) {
      return false;
    }
    if (!macSocket || macSocket.readyState !== macSocket.OPEN || session.epoch !== macConnectionEpoch) {
      closeRealtimeSession(session, { code: 1011, reason: 'mac_offline', notifyMac: false });
      return false;
    }
    if ((macSocket.bufferedAmount || 0) > DEFAULT_RELAY_WS_BUFFERED_BYTES) {
      closeRealtimeSession(session, { code: 1011, reason: 'relay_realtime_backpressure', notifyMac: true });
      return false;
    }
    return sendWsJson(macSocket, {
      ...patch,
      requestId: session.requestId,
      macConnectionEpoch: session.epoch
    });
  }

  function closeRealtimeSession(session, { code = 1000, reason = 'relay_realtime_closed', notifyMac = true } = {}) {
    if (!realtimeSockets.delete(session.requestId)) {
      return;
    }
    metrics.realtimeTunnelsClosedTotal += 1;
    if (notifyMac && macSocket?.readyState === macSocket.OPEN && session.epoch === macConnectionEpoch) {
      sendWsJson(macSocket, {
        type: 'realtime.close',
        requestId: session.requestId,
        macConnectionEpoch: session.epoch,
        code,
        reason
      });
    }
    if ([session.browserWs.OPEN, session.browserWs.CONNECTING].includes(session.browserWs.readyState)) {
      session.browserWs.close(code, reason);
    }
    scheduleHeartbeat();
  }

  function forwardRealtimeBrowserFrame(session, raw, isBinary) {
    if (!realtimeSockets.has(session.requestId)) {
      return;
    }
    const bytes = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    session.toMacSequence += 1;
    const sent = sendRealtimeMacFrame(session, {
      type: 'realtime.frame',
      sequence: session.toMacSequence,
      encoding: isBinary ? 'base64' : 'text',
      data: isBinary ? bytes.toString('base64') : bytes.toString('utf8'),
      bytes: bytes.length
    });
    if (!sent) {
      closeRealtimeSession(session, { code: 1011, reason: 'mac_offline', notifyMac: false });
    }
  }

  function handleRealtimeMacFrame(session, payload) {
    const expectedSequence = session.toBrowserSequence + 1;
    const bytes = Buffer.from(payload.data || '', payload.encoding === 'base64' ? 'base64' : 'utf8');
    if (Number(payload.sequence) !== expectedSequence || Number(payload.bytes) !== bytes.length) {
      closeRealtimeSession(session, { code: 1011, reason: 'relay_realtime_frame_invalid', notifyMac: true });
      return;
    }
    if ((session.browserWs.bufferedAmount || 0) > DEFAULT_RELAY_WS_BUFFERED_BYTES) {
      closeRealtimeSession(session, { code: 1011, reason: 'relay_realtime_backpressure', notifyMac: true });
      return;
    }
    session.toBrowserSequence = expectedSequence;
    if (session.browserWs.readyState === session.browserWs.OPEN) {
      session.browserWs.send(payload.encoding === 'base64' ? bytes : bytes.toString('utf8'), {
        binary: payload.encoding === 'base64'
      });
    }
  }

  function handleRealtimeMacPayload(payload) {
    const session = realtimeSockets.get(payload.requestId);
    if (!session || (payload.macConnectionEpoch && payload.macConnectionEpoch !== session.epoch)) {
      return;
    }
    if (payload.type === 'realtime.frame') {
      handleRealtimeMacFrame(session, payload);
      return;
    }
    closeRealtimeSession(session, {
      code: payload.code || 1011,
      reason: payload.reason || payload.error || 'relay_realtime_closed',
      notifyMac: false
    });
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

  async function handleStreamResponsePayload(payload) {
    const pending = pendingRequests.get(payload.requestId);
    if (!pending || !pending.streamHandlers || (payload.macConnectionEpoch && payload.macConnectionEpoch !== pending.epoch)) {
      return;
    }
    if (payload.type === 'http.response.start') {
      pending.streamStarted = true;
      await pending.streamHandlers.onStart?.(payload);
      return;
    }
    if (payload.type === 'http.response.chunk') {
      await handleStreamResponseChunk(pending, payload);
      return;
    }
    if (payload.type === 'http.stream.error') {
      const settled = pendingRequests.settle(payload.requestId, () => {});
      await settled.streamHandlers.onError?.(payload);
      settled.reject(Object.assign(new Error(payload.error || 'relay_stream_error'), { status: payload.status || 502 }));
      return;
    }
    const settled = pendingRequests.settle(payload.requestId, () => {});
    await settled.streamHandlers.onEnd?.(payload);
    settled.resolve(payload);
  }

  async function handleStreamResponseChunk(pending, payload) {
    if (!pending.streamStarted) {
      throw Object.assign(new Error('relay_stream_start_missing'), { status: 502 });
    }
    const expectedSequence = pending.streamSequence + 1;
    const bytes = Buffer.from(payload.data || '', payload.encoding === 'base64' ? 'base64' : 'utf8');
    if (Number(payload.sequence) !== expectedSequence || Number(payload.bytes) !== bytes.length) {
      throw Object.assign(new Error('relay_stream_chunk_invalid'), { status: 502 });
    }
    pending.streamSequence = expectedSequence;
    await pending.streamHandlers.onChunk?.(bytes, payload);
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
      attachMacSocket(ws, payload);
      return;
    }
    if (payload.type === 'pong') {
      ws.lastPongAt = Number(payload.sentAt || Date.now());
      if (macInfo) {
        macInfo.lastSeenAt = new Date().toISOString();
      }
      return;
    }
    if (payload.type === 'mac.status' && ws === macSocket && macInfo) {
      macInfo.lastSeenAt = new Date().toISOString();
      macInfo.localStatus = payload.localStatus || macInfo.localStatus;
      logRelayEvent('mac.local_status_changed', {
        macConnectionEpoch,
        reachable: Boolean(macInfo.localStatus?.reachable),
        status: macInfo.localStatus?.status || 0
      });
      broadcast({ type: 'relay-status', ...currentRelayStatus(true) });
      return;
    }
    if (payload.type === 'event' && ws === macSocket && payload.payload) {
      broadcast(payload.payload);
      return;
    }
    if (['http.response.start', 'http.response.chunk', 'http.response.end', 'http.stream.error'].includes(payload.type)) {
      try {
        await handleStreamResponsePayload(payload);
      } catch (error) {
        failMacRequest(payload.requestId, error.status || 502, error.message || 'relay_stream_error');
      }
      return;
    }
    if (['realtime.frame', 'realtime.close', 'realtime.error'].includes(payload.type)) {
      handleRealtimeMacPayload(payload);
      return;
    }
    if (['http.response', 'http.error', 'auth.validate.result'].includes(payload.type)) {
      handleResponsePayload(payload);
    }
  }

  function acceptMacSocket(ws) {
    ws.lastPongAt = Date.now();
    ws.on('message', (message) => {
      handleMacMessage(ws, message).catch((error) => {
        ws.close(4002, error.message || 'invalid_message');
      });
    });
    ws.on('close', () => detachMacSocket(ws));
    ws.on('error', () => detachMacSocket(ws));
  }

  function acceptBrowserSocket(ws) {
    browserSockets.add(ws);
    scheduleHeartbeat();
    logRelayEvent('browser.ws.connected', { browserSocketsCurrent: browserSockets.size });
    ws.on('close', () => {
      browserSockets.delete(ws);
      logRelayEvent('browser.ws.disconnected', { browserSocketsCurrent: browserSockets.size });
      scheduleHeartbeat();
    });
    ws.on('error', () => {
      browserSockets.delete(ws);
      logRelayEvent('browser.ws.disconnected', { browserSocketsCurrent: browserSockets.size });
      scheduleHeartbeat();
    });
    sendWsJson(ws, { type: 'connected', status: currentRelayStatus(true) });
  }

  function acceptRealtimeSocket(ws, token) {
    const requestId = createRequestId();
    const session = {
      requestId,
      browserWs: ws,
      epoch: macConnectionEpoch,
      toMacSequence: 0,
      toBrowserSequence: 0
    };
    try {
      assertMacAvailable({ type: 'realtime.open' }, `browser:${browserTokenCache.key(token)}`);
    } catch (error) {
      ws.send(JSON.stringify({ type: 'voice.realtime.error', error: error.message || 'mac_offline' }));
      ws.close(1011, error.message || 'mac_offline');
      return;
    }
    realtimeSockets.set(requestId, session);
    metrics.realtimeTunnelsTotal += 1;
    scheduleHeartbeat();
    const opened = sendRealtimeMacFrame(session, {
      type: 'realtime.open',
      path: `/ws/realtime?token=${encodeURIComponent(token)}`,
      token
    });
    if (!opened) {
      closeRealtimeSession(session, { code: 1011, reason: 'mac_offline', notifyMac: false });
      return;
    }
    ws.on('message', (raw, isBinary) => forwardRealtimeBrowserFrame(session, raw, isBinary));
    ws.on('close', (code, reason) => {
      closeRealtimeSession(session, {
        code: code || 1000,
        reason: reason?.toString() || 'browser_closed',
        notifyMac: true
      });
    });
    ws.on('error', () => {
      closeRealtimeSession(session, { code: 1011, reason: 'browser_error', notifyMac: true });
    });
    logRelayEvent('realtime.tunnel.opened', { requestId, macConnectionEpoch });
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
    acceptRealtimeSocket
  };
}
