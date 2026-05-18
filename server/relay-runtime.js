import crypto from 'node:crypto';
import {
  DEFAULT_RELAY_WS_BUFFERED_BYTES,
  RELAY_PROTOCOL_VERSION,
  createRequestId,
  jsonMessage,
  logRelayEvent,
  safeJsonParse,
  sendWsJson
} from './relay-protocol.js';

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
  const pendingRequests = new Map();
  const realtimeSockets = new Map();
  const validTokenCache = new Map();
  const metrics = {
    relayRequestsTotal: 0,
    relayRequestsFailed: 0,
    relayRequestsTimedOut: 0,
    rateLimitedTotal: 0,
    pendingLimitRejectedTotal: 0,
    authValidationMissTotal: 0,
    macAuthFailuresTotal: 0,
    macConnectsTotal: 0,
    macDisconnectsTotal: 0,
    macHeartbeatMissesTotal: 0,
    multiMacRejectedTotal: 0,
    realtimeTunnelsTotal: 0,
    realtimeTunnelsClosedTotal: 0
  };

  let macSocket = null;
  let macInfo = null;
  let macConnectionEpoch = 0;
  let heartbeatTimer = null;
  const relayStartedAt = new Date().toISOString();

  function tokenCacheKey(token) {
    return crypto.createHash('sha256').update(token).digest('hex');
  }

  function cleanupTokenCache() {
    const now = Date.now();
    for (const [token, entry] of validTokenCache.entries()) {
      if (!entry.expiresAt || entry.expiresAt <= now) {
        validTokenCache.delete(token);
      }
    }
  }

  function hasCachedBrowserToken(token) {
    if (!token) {
      return false;
    }
    cleanupTokenCache();
    const cached = validTokenCache.get(tokenCacheKey(token));
    return Boolean(cached && cached.expiresAt > Date.now());
  }

  function relayState(authenticated) {
    if (!authenticated) {
      return 'pairing_required';
    }
    if (!macSocket || macSocket.readyState !== macSocket.OPEN) {
      return 'mac_offline';
    }
    if (macInfo?.localStatus?.reachable === false) {
      return 'mac_local_offline';
    }
    if (metrics.macHeartbeatMissesTotal > 0 || metrics.relayRequestsTimedOut > 0) {
      return 'degraded';
    }
    return 'ready';
  }

  function isValidRelaySecret(value) {
    return Boolean(value && (value === relaySecret || value === previousRelaySecret));
  }

  function currentRelayStatus(authenticated = false) {
    cleanupTokenCache();
    return {
      mode: 'relay',
      relayState: relayState(authenticated),
      connected: true,
      authenticated,
      requiresPairing: !authenticated,
      macConnected: Boolean(macSocket && macSocket.readyState === macSocket.OPEN),
      macDeviceName: macInfo?.deviceName || '',
      macConnectionEpoch,
      macConnectedAt: macInfo?.connectedAt || '',
      macLastSeenAt: macInfo?.lastSeenAt || '',
      localStatus: macInfo?.localStatus || { reachable: false, checkedAt: '' },
      pendingRelayRequests: pendingRequests.size,
      relayStartedAt,
      limits: {
        pendingRequestsMax,
        browserPendingRequestsMax,
        requestBodyMaxBytes,
        heartbeatMs,
        idleHeartbeatMs
      },
      secrets: {
        previousConfigured: Boolean(previousRelaySecret)
      },
      metrics: {
        ...metrics,
        browserSocketsCurrent: browserSockets.size,
        realtimeSocketsCurrent: realtimeSockets.size,
        pendingRequestsCurrent: pendingRequests.size
      }
    };
  }

  function broadcast(payload) {
    const serialized = JSON.stringify(payload);
    for (const socket of browserSockets) {
      if (socket.readyState === socket.OPEN) {
        socket.send(serialized);
      }
    }
  }

  function failPendingForEpoch(epoch, status, error) {
    for (const [requestId, pending] of pendingRequests.entries()) {
      if (pending.epoch !== epoch) {
        continue;
      }
      clearTimeout(pending.timer);
      deletePendingRequest(requestId);
      pending.reject(Object.assign(new Error(error), { status }));
    }
  }

  function closeRealtimeForEpoch(epoch, reason) {
    for (const session of realtimeSockets.values()) {
      if (session.epoch === epoch) {
        closeRealtimeSession(session, { code: 1011, reason, notifyMac: false });
      }
    }
  }

  function pendingCountForClient(clientKey) {
    if (!clientKey) {
      return 0;
    }
    let count = 0;
    for (const pending of pendingRequests.values()) {
      if (pending.clientKey === clientKey) {
        count += 1;
      }
    }
    return count;
  }

  function pendingLimitError(error) {
    metrics.pendingLimitRejectedTotal += 1;
    metrics.rateLimitedTotal += 1;
    return Object.assign(new Error(error), { status: 429 });
  }

  function assertMacAvailable(envelope, clientKey = '') {
    if (!macSocket || macSocket.readyState !== macSocket.OPEN) {
      throw Object.assign(new Error('mac_offline'), { status: 503 });
    }
    if (macInfo?.localStatus?.reachable === false && envelope.type !== 'auth.validate') {
      throw Object.assign(new Error('mac_local_offline'), { status: 503 });
    }
    if (pendingRequests.size >= pendingRequestsMax) {
      throw pendingLimitError('relay_pending_limit_exceeded');
    }
    if (clientKey && pendingCountForClient(clientKey) >= browserPendingRequestsMax) {
      throw pendingLimitError('relay_client_pending_limit_exceeded');
    }
  }

  function heartbeatInterval() {
    return browserSockets.size > 0 || pendingRequests.size > 0 ? heartbeatMs : idleHeartbeatMs;
  }

  function deletePendingRequest(requestId) {
    const deleted = pendingRequests.delete(requestId);
    if (deleted) {
      scheduleHeartbeat();
    }
    return deleted;
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
    failPendingForEpoch(oldEpoch, 502, 'mac_offline');
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
      failPendingForEpoch(oldEpoch, 502, 'mac_reconnected');
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
    const requestId = envelope.requestId || createRequestId();
    const epoch = macConnectionEpoch;
    const pending = {
      resolve: () => {},
      reject: () => {},
      timer: null,
      epoch,
      clientKey,
      streamHandlers,
      streamSequence: 0,
      streamStarted: false
    };
    const response = new Promise((resolve, reject) => {
      pending.resolve = resolve;
      pending.reject = reject;
    });
    pending.timer = setTimeout(() => {
      deletePendingRequest(requestId);
      metrics.relayRequestsTimedOut += 1;
      pending.reject(Object.assign(new Error('relay_request_timeout'), { status: 502 }));
    }, timeoutMs);

    pendingRequests.set(requestId, pending);
    scheduleHeartbeat();
    return { requestId, epoch, response };
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
    const pending = pendingRequests.get(requestId);
    if (!pending) {
      return;
    }
    clearTimeout(pending.timer);
    deletePendingRequest(requestId);
    pending.reject(Object.assign(new Error(error), { status }));
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
    cleanupTokenCache();
    const cacheKey = tokenCacheKey(token);
    const cached = validTokenCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
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
    validTokenCache.set(cacheKey, { expiresAt: Date.now() + tokenCacheTtlMs });
    return true;
  }

  function handleResponsePayload(payload) {
    const pending = pendingRequests.get(payload.requestId);
    if (!pending || (payload.macConnectionEpoch && payload.macConnectionEpoch !== pending.epoch)) {
      return;
    }
    clearTimeout(pending.timer);
    deletePendingRequest(payload.requestId);
    if (payload.type === 'http.error') {
      pending.reject(Object.assign(new Error(payload.error || 'relay_upstream_error'), {
        status: payload.status || 502
      }));
      return;
    }
    pending.resolve(payload);
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
    clearTimeout(pending.timer);
    deletePendingRequest(payload.requestId);
    if (payload.type === 'http.stream.error') {
      await pending.streamHandlers.onError?.(payload);
      pending.reject(Object.assign(new Error(payload.error || 'relay_stream_error'), { status: payload.status || 502 }));
      return;
    }
    await pending.streamHandlers.onEnd?.(payload);
    pending.resolve(payload);
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
      assertMacAvailable({ type: 'realtime.open' }, `browser:${tokenCacheKey(token)}`);
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
