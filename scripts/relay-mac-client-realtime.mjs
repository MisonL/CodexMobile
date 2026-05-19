import WebSocket from 'ws';
import { sendWsJson } from '../server/relay-protocol.js';
import { buildLocalRealtimeWsUrl } from './relay-mac-client-config.mjs';
import { waitForSocketBackpressure } from './relay-mac-client-backpressure.mjs';

export function createRealtimeTunnelClient({
  getRelaySocket,
  getRelayEpoch,
  waitForRelayBackpressure
}) {
  const realtimeTunnels = new Map();

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

  function sendError(requestId, error) {
    sendRelayMessage({
      type: 'realtime.error',
      requestId,
      code: error?.code || 1011,
      error: error?.message || 'relay_realtime_failed'
    });
  }

  function closeTunnel(requestId, { code = 1000, reason = 'relay_realtime_closed', notifyRelay = true } = {}) {
    const tunnel = realtimeTunnels.get(requestId);
    if (!tunnel) {
      return;
    }
    realtimeTunnels.delete(requestId);
    if (notifyRelay) {
      sendRelayMessage({
        type: 'realtime.close',
        requestId,
        code,
        reason
      });
    }
    if ([tunnel.socket.OPEN, tunnel.socket.CONNECTING].includes(tunnel.socket.readyState)) {
      tunnel.socket.close(code, reason);
    }
  }

  function closeAll() {
    for (const requestId of realtimeTunnels.keys()) {
      closeTunnel(requestId, { code: 1001, reason: 'relay_disconnected', notifyRelay: false });
    }
  }

  async function forwardLocalFrame(requestId, raw, isBinary) {
    const tunnel = realtimeTunnels.get(requestId);
    if (!tunnel) {
      return;
    }
    const bytes = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    tunnel.toRelaySequence += 1;
    await waitForRelayBackpressure();
    sendRelayMessage({
      type: 'realtime.frame',
      requestId,
      sequence: tunnel.toRelaySequence,
      encoding: isBinary ? 'base64' : 'text',
      data: isBinary ? bytes.toString('base64') : bytes.toString('utf8'),
      bytes: bytes.length
    });
  }

  function handleOpen(message) {
    const requestId = message.requestId;
    const token = String(message.token || '').trim();
    if (!token) {
      sendError(requestId, new Error('relay_realtime_token_missing'));
      return;
    }
    closeTunnel(requestId, { notifyRelay: false });
    const socket = new WebSocket(buildLocalRealtimeWsUrl(token));
    realtimeTunnels.set(requestId, { socket, toRelaySequence: 0, fromRelaySequence: 0 });
    socket.on('message', (raw, isBinary) => {
      forwardLocalFrame(requestId, raw, isBinary).catch((error) => {
        closeTunnel(requestId, { code: 1011, reason: error.message, notifyRelay: true });
      });
    });
    socket.on('close', (code, reason) => {
      closeTunnel(requestId, { code: code || 1000, reason: reason?.toString() || 'local_realtime_closed' });
    });
    socket.on('unexpected-response', () => {
      sendError(requestId, Object.assign(new Error('local_realtime_rejected'), { code: 1011 }));
      closeTunnel(requestId, { code: 1011, reason: 'local_realtime_rejected', notifyRelay: false });
    });
    socket.on('error', (error) => {
      sendError(requestId, error);
      closeTunnel(requestId, { code: 1011, reason: 'local_realtime_error', notifyRelay: false });
    });
  }

  async function handleFrame(message) {
    const tunnel = realtimeTunnels.get(message.requestId);
    if (!tunnel || tunnel.socket.readyState !== tunnel.socket.OPEN) {
      sendError(message.requestId, new Error('relay_realtime_socket_missing'));
      return;
    }
    const expectedSequence = tunnel.fromRelaySequence + 1;
    const bytes = Buffer.from(message.data || '', message.encoding === 'base64' ? 'base64' : 'utf8');
    if (Number(message.sequence) !== expectedSequence || Number(message.bytes) !== bytes.length) {
      closeTunnel(message.requestId, { code: 1011, reason: 'relay_realtime_frame_invalid' });
      return;
    }
    await waitForSocketBackpressure(tunnel.socket);
    tunnel.fromRelaySequence = expectedSequence;
    tunnel.socket.send(message.encoding === 'base64' ? bytes : bytes.toString('utf8'), {
      binary: message.encoding === 'base64'
    });
  }

  function handleClose(message) {
    closeTunnel(message.requestId, {
      code: message.code || 1000,
      reason: message.reason || 'relay_realtime_closed',
      notifyRelay: false
    });
  }

  return {
    closeAll,
    handleClose,
    handleFrame,
    handleOpen,
    sendError
  };
}
