import crypto from 'node:crypto';
import {
  RELAY_PROTOCOL_VERSION,
  createRequestId,
  jsonMessage,
  logRelayEvent,
  safeJsonParse,
  sendWsJson
} from './relay-protocol.js';

export function createRelayRuntime({
  relaySecret,
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
    macHeartbeatMissesTotal: 0
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
      metrics: {
        ...metrics,
        browserSocketsCurrent: browserSockets.size,
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
    if (macSocket && macSocket.readyState === macSocket.OPEN) {
      const oldEpoch = macConnectionEpoch;
      failPendingForEpoch(oldEpoch, 502, 'mac_reconnected');
      try {
        macSocket.close(4000, 'mac_reconnected');
      } catch {
        macSocket.terminate();
      }
    }

    macConnectionEpoch += 1;
    macSocket = ws;
    macInfo = {
      connectorInstanceId: hello.connectorInstanceId || '',
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

  function requestMac(envelope, timeoutMs = requestTimeoutMs, { clientKey = '' } = {}) {
    return new Promise((resolve, reject) => {
      if (!macSocket || macSocket.readyState !== macSocket.OPEN) {
        reject(Object.assign(new Error('mac_offline'), { status: 503 }));
        return;
      }
      if (macInfo?.localStatus?.reachable === false && envelope.type !== 'auth.validate') {
        reject(Object.assign(new Error('mac_local_offline'), { status: 503 }));
        return;
      }
      if (pendingRequests.size >= pendingRequestsMax) {
        reject(pendingLimitError('relay_pending_limit_exceeded'));
        return;
      }
      if (clientKey && pendingCountForClient(clientKey) >= browserPendingRequestsMax) {
        reject(pendingLimitError('relay_client_pending_limit_exceeded'));
        return;
      }
      const requestId = envelope.requestId || createRequestId();
      const epoch = macConnectionEpoch;
      const timer = setTimeout(() => {
        deletePendingRequest(requestId);
        metrics.relayRequestsTimedOut += 1;
        reject(Object.assign(new Error('relay_request_timeout'), { status: 502 }));
      }, timeoutMs);

      pendingRequests.set(requestId, { resolve, reject, timer, epoch, clientKey });
      scheduleHeartbeat();
      sendWsJson(macSocket, { ...envelope, requestId, macConnectionEpoch: epoch });
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

  function handleMacMessage(ws, message) {
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
    if (['http.response', 'http.error', 'auth.validate.result'].includes(payload.type)) {
      handleResponsePayload(payload);
    }
  }

  function acceptMacSocket(ws) {
    ws.lastPongAt = Date.now();
    ws.on('message', (message) => handleMacMessage(ws, message));
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

  return {
    relaySecret,
    metrics,
    currentRelayStatus,
    requestMac,
    validateBrowserToken,
    acceptMacSocket,
    acceptBrowserSocket
  };
}
