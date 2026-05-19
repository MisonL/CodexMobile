import WebSocket from 'ws';
import {
  createRequestId,
  safeJsonParse,
  sendWsJson
} from '../server/relay-protocol.js';
import {
  buildLocalUrl,
  buildLocalWsUrl,
  logState
} from './relay-mac-client-config.mjs';

export function createLocalServiceMonitor({
  getRelaySocket,
  getRelayEpoch,
  getRelayConnectionId = () => ''
}) {
  let localEventWs = null;
  let localEventToken = '';
  let localStatus = { reachable: false, checkedAt: '' };

  function sendRelayMessage(payload) {
    const socket = getRelaySocket();
    if (!socket || socket.readyState !== socket.OPEN) {
      return false;
    }
    return sendWsJson(socket, {
      ...payload,
      macConnectionEpoch: getRelayEpoch()
    });
  }

  function getStatus() {
    return localStatus;
  }

  function closeEventSocket() {
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
    sendRelayMessage({
      type: 'event',
      eventId: payload.eventId || createRequestId(),
      payload
    });
  }

  function ensureEventSocket(token) {
    const nextToken = String(token || '').trim();
    if (!nextToken) {
      return Promise.resolve(false);
    }
    if (localEventWs?.readyState === WebSocket.OPEN && localEventToken === nextToken) {
      return Promise.resolve(true);
    }
    closeEventSocket();
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

  async function checkStatus() {
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

  function sendStatus() {
    sendRelayMessage({
      type: 'mac.status',
      connectionId: getRelayConnectionId(),
      localStatus
    });
  }

  async function startStatusLoop() {
    await checkStatus();
    sendStatus();
    setTimeout(startStatusLoop, localStatus.reachable ? 30000 : 5000).unref?.();
  }

  return {
    checkStatus,
    closeEventSocket,
    ensureEventSocket,
    getStatus,
    sendStatus,
    startStatusLoop
  };
}
