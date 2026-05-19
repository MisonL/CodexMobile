import {
  RELAY_PROTOCOL_VERSION,
  jsonMessage,
  logRelayEvent,
  sendWsJson
} from './relay-protocol.js';

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

  function detachSocket(ws) {
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
  }

  function scheduleHeartbeat() {
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

  function attachSocket(ws, hello = {}) {
    const nextConnectorId = String(hello.connectorInstanceId || '').trim();
    if (!nextConnectorId) {
      ws.close(4002, 'invalid_connector_instance_id');
      logRelayEvent('mac.rejected', { reason: 'invalid_connector_instance_id' }, 'warn');
      return;
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
  }

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
