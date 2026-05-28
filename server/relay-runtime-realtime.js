import {
  DEFAULT_RELAY_WS_BUFFERED_BYTES,
  DEFAULT_RELAY_REALTIME_FRAME_BYTES,
  logRelayEvent,
  sendWsJson
} from './relay-protocol.js';

function rawFrameByteLength(raw) {
  if (Buffer.isBuffer(raw)) {
    return raw.length;
  }
  if (typeof raw === 'string') {
    return Buffer.byteLength(raw);
  }
  if (raw instanceof ArrayBuffer) {
    return raw.byteLength;
  }
  if (ArrayBuffer.isView(raw)) {
    return raw.byteLength;
  }
  if (Array.isArray(raw)) {
    return raw.reduce((total, item) => total + rawFrameByteLength(item), 0);
  }
  return Buffer.byteLength(String(raw ?? ''));
}

function rawFrameBuffer(raw) {
  if (Buffer.isBuffer(raw)) {
    return raw;
  }
  if (typeof raw === 'string') {
    return Buffer.from(raw);
  }
  if (raw instanceof ArrayBuffer) {
    return Buffer.from(raw);
  }
  if (ArrayBuffer.isView(raw)) {
    return Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength);
  }
  if (Array.isArray(raw)) {
    return Buffer.concat(raw.map((item) => rawFrameBuffer(item)));
  }
  return Buffer.from(String(raw ?? ''));
}

export function createRealtimeTunnelManager({
  realtimeSockets,
  createRequestId,
  getMacSocket,
  getMacConnectionEpoch,
  assertMacAvailable,
  browserTokenKey,
  metrics,
  scheduleHeartbeat,
  maxFrameBytes = DEFAULT_RELAY_REALTIME_FRAME_BYTES
}) {
  function sendRealtimeMacFrame(session, patch) {
    if (!realtimeSockets.has(session.requestId)) {
      return false;
    }
    const macSocket = getMacSocket();
    const macConnectionEpoch = getMacConnectionEpoch();
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
    const macSocket = getMacSocket();
    if (notifyMac && macSocket?.readyState === macSocket.OPEN && session.epoch === getMacConnectionEpoch()) {
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

  const closeForEpoch = (epoch, reason) => {
    for (const session of realtimeSockets.values()) {
      if (session.epoch === epoch) {
        closeRealtimeSession(session, { code: 1011, reason, notifyMac: false });
      }
    }
  };

  const forwardBrowserFrame = (session, raw, isBinary) => {
    if (!realtimeSockets.has(session.requestId)) {
      return;
    }
    const byteLength = rawFrameByteLength(raw);
    if (byteLength > maxFrameBytes) {
      closeRealtimeSession(session, { code: 1009, reason: 'relay_realtime_frame_too_large', notifyMac: true });
      return;
    }
    const bytes = rawFrameBuffer(raw);
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
  };

  const handleMacFrame = (session, payload) => {
    const expectedSequence = session.toBrowserSequence + 1;
    if (Number(payload.bytes) > maxFrameBytes) {
      closeRealtimeSession(session, { code: 1009, reason: 'relay_realtime_frame_too_large', notifyMac: true });
      return;
    }
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
  };

  function handleMacPayload(payload) {
    const session = realtimeSockets.get(payload.requestId);
    if (!session || (payload.macConnectionEpoch && payload.macConnectionEpoch !== session.epoch)) {
      return;
    }
    if (payload.type === 'realtime.frame') {
      handleMacFrame(session, payload);
      return;
    }
    closeRealtimeSession(session, {
      code: payload.code || 1011,
      reason: payload.reason || payload.error || 'relay_realtime_closed',
      notifyMac: false
    });
  }

  function acceptSocket(ws, token) {
    const requestId = createRequestId();
    const session = {
      requestId,
      browserWs: ws,
      epoch: getMacConnectionEpoch(),
      toMacSequence: 0,
      toBrowserSequence: 0
    };
    try {
      assertMacAvailable({ type: 'realtime.open' }, `browser:${browserTokenKey(token)}`);
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
      path: '/ws/realtime',
      token
    });
    if (!opened) {
      closeRealtimeSession(session, { code: 1011, reason: 'mac_offline', notifyMac: false });
      return;
    }
    ws.on('message', (raw, isBinary) => forwardBrowserFrame(session, raw, isBinary));
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
    logRelayEvent('realtime.tunnel.opened', { requestId, macConnectionEpoch: session.epoch });
  }

  return {
    acceptSocket,
    closeForEpoch,
    handleMacPayload
  };
}
