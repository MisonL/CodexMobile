import {
  RELAY_PROTOCOL_VERSION,
  jsonMessage,
  logRelayEvent,
  sendWsJson
} from './relay-protocol.js';

const MAX_HEARTBEAT_MISS_CHECK_MS = 10000;
const STALE_SOCKET_TERMINATE_DELAY_MS = 250;

export function createMacConnectionManager({
  createRequestId,
  heartbeatMs,
  idleHeartbeatMs,
  metrics,
  pendingRequests,
  hasActiveBrowserWork,
  broadcastStatus,
  closeRealtimeForEpoch
}) {
  let macSocket = null;
  let macInfo = null;
  let macConnectionEpoch = 0;
  let heartbeatTimer = null;
  let pinnedConnectorInstanceId = '';

  function getSocket() {
    return macSocket;
  }

  function getInfo() {
    return macInfo;
  }

  function getEpoch() {
    return macConnectionEpoch;
  }

  function isConnected() {
    return Boolean(macSocket && macSocket.readyState === macSocket.OPEN);
  }

  function bufferedAmount() {
    return macSocket?.bufferedAmount || 0;
  }

  function assertAvailable(envelope, clientKey = '') {
    if (!isConnected()) {
      throw Object.assign(new Error('mac_offline'), { status: 503 });
    }
    if (macInfo?.localStatus?.reachable === false && envelope.type !== 'auth.validate') {
      throw Object.assign(new Error('mac_local_offline'), { status: 503 });
    }
    pendingRequests.assertCapacity(clientKey);
  }

  function heartbeatInterval() {
    return hasActiveBrowserWork() || pendingRequests.size > 0 ? heartbeatMs : idleHeartbeatMs;
  }

  const hasActiveRelayWork = () => {
    return hasActiveBrowserWork() || pendingRequests.size > 0;
  };

  const closeStaleSocket = (ws, reason) => {
    try {
      ws.close(4000, reason);
      if (typeof ws.terminate === 'function') {
        const terminateTimer = setTimeout(() => {
          if (ws.readyState !== ws.CLOSED) {
            ws.terminate();
          }
        }, STALE_SOCKET_TERMINATE_DELAY_MS);
        terminateTimer.unref?.();
      }
    } catch {
      ws.terminate?.();
    }
  };

  const detachSocket = (ws) => {
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
    broadcastStatus();
    clearTimeout(heartbeatTimer);
    heartbeatTimer = null;
    logRelayEvent('mac.disconnected', { macConnectionEpoch: oldEpoch });
  };

  const scheduleHeartbeat = () => {
    clearTimeout(heartbeatTimer);
    if (!isConnected()) {
      return;
    }
    heartbeatTimer = setTimeout(() => {
      if (!isConnected()) {
        return;
      }
      const sentAt = Date.now();
      const active = heartbeatInterval() === heartbeatMs;
      if (!sendWsJson(macSocket, { type: 'ping', sentAt, active })) {
        return;
      }
      const socketAtPing = macSocket;
      const missedTimer = setTimeout(() => {
        const socketOpen = socketAtPing === macSocket && socketAtPing.readyState === socketAtPing.OPEN;
        if (socketOpen && Number(socketAtPing.lastPongAt || 0) < sentAt) {
          metrics.macHeartbeatMissesTotal += 1;
          logRelayEvent('mac.heartbeat_missed', { macConnectionEpoch });
          detachSocket(socketAtPing);
          closeStaleSocket(socketAtPing, 'mac_heartbeat_missed');
        }
      }, Math.min(heartbeatMs, MAX_HEARTBEAT_MISS_CHECK_MS));
      missedTimer.unref?.();
      scheduleHeartbeat();
    }, heartbeatInterval());
    heartbeatTimer.unref?.();
  };

  const attachSocket = (ws, hello = {}) => {
    const nextConnectorId = String(hello.connectorInstanceId || '').trim();
    if (!nextConnectorId) {
      ws.close(4002, 'invalid_connector_instance_id');
      logRelayEvent('mac.rejected', { reason: 'invalid_connector_instance_id' }, 'warn');
      return;
    }
    if (pinnedConnectorInstanceId && pinnedConnectorInstanceId !== nextConnectorId) {
      if (isConnected() || hasActiveRelayWork()) {
        metrics.multiMacRejectedTotal += 1;
        ws.close(4009, 'ambiguous_mac_route');
        logRelayEvent('mac.rejected', {
          reason: 'ambiguous_mac_route',
          pinnedConnectorInstanceId,
          rejectedConnectorInstanceId: nextConnectorId
        }, 'warn');
        return;
      }
      logRelayEvent('mac.connector_identity_rotated', {
        previousConnectorInstanceId: pinnedConnectorInstanceId,
        nextConnectorInstanceId: nextConnectorId
      });
      pinnedConnectorInstanceId = nextConnectorId;
    }
    if (isConnected()) {
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
    pinnedConnectorInstanceId = pinnedConnectorInstanceId || nextConnectorId;
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
    broadcastStatus();
    scheduleHeartbeat();
    logRelayEvent('mac.connected', {
      macConnectionEpoch,
      deviceName: macInfo.deviceName,
      connectorInstanceId: macInfo.connectorInstanceId
    });
  };

  function recordPong(ws, sentAt) {
    ws.lastPongAt = Number(sentAt || Date.now());
    if (macInfo) {
      macInfo.lastSeenAt = new Date().toISOString();
    }
  }

  function updateLocalStatus(ws, localStatus) {
    if (ws !== macSocket || !macInfo) {
      return false;
    }
    macInfo.lastSeenAt = new Date().toISOString();
    macInfo.localStatus = localStatus || macInfo.localStatus;
    logRelayEvent('mac.local_status_changed', {
      macConnectionEpoch,
      reachable: Boolean(macInfo.localStatus?.reachable),
      status: macInfo.localStatus?.status || 0
    });
    broadcastStatus();
    return true;
  }

  function acceptSocket(ws, handleMessage) {
    ws.lastPongAt = Date.now();
    ws.on('message', (message) => {
      handleMessage(ws, message).catch((error) => {
        ws.close(4002, error.message || 'invalid_message');
      });
    });
    ws.on('close', () => detachSocket(ws));
    ws.on('error', () => detachSocket(ws));
  }

  return {
    acceptSocket,
    assertAvailable,
    attachSocket,
    bufferedAmount,
    getEpoch,
    getInfo,
    getSocket,
    isConnected,
    recordPong,
    scheduleHeartbeat,
    updateLocalStatus
  };
}
