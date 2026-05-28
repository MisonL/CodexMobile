import WebSocket from 'ws';
import {
  REALTIME_TIMEOUT_MS,
  isBenignRealtimeCancelError,
  publicVoiceRealtimeStatus,
  realtimeApiKey,
  realtimeBaseUrl,
  realtimeErrorMessage,
  realtimeHeaders,
  realtimeModel,
  realtimeProvider,
  realtimeResponseCreatePayload,
  realtimeSessionPayload,
  realtimeWebSocketUrl,
  safeMessage
} from './realtime-voice-config.js';
import { createRealtimeHandoffController } from './realtime-voice-handoff.js';

export { publicVoiceRealtimeStatus };

const REALTIME_PENDING_MAX_MESSAGES = 128;
const REALTIME_PENDING_MAX_BYTES = 2 * 1024 * 1024;
const REALTIME_INPUT_AUDIO_MAX_CHARS = 512 * 1024;
const REALTIME_CLIENT_FRAME_MAX_BYTES = REALTIME_PENDING_MAX_BYTES;

export function realtimeClientFrameByteLength(data) {
  if (Buffer.isBuffer(data)) {
    return data.length;
  }
  if (typeof data === 'string') {
    return Buffer.byteLength(data);
  }
  if (data instanceof ArrayBuffer) {
    return data.byteLength;
  }
  if (ArrayBuffer.isView(data)) {
    return data.byteLength;
  }
  if (Array.isArray(data)) {
    return data.reduce((total, item) => total + realtimeClientFrameByteLength(item), 0);
  }
  return Buffer.byteLength(String(data ?? ''));
}

function realtimeClientFrameText(data) {
  if (Buffer.isBuffer(data)) {
    return data.toString('utf8');
  }
  if (typeof data === 'string') {
    return data;
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(data).toString('utf8');
  }
  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('utf8');
  }
  if (Array.isArray(data)) {
    return Buffer.concat(data.map((item) => Buffer.from(realtimeClientFrameText(item)))).toString('utf8');
  }
  return String(data ?? '');
}

export function createPendingRealtimeQueue({
  maxMessages = REALTIME_PENDING_MAX_MESSAGES,
  maxBytes = REALTIME_PENDING_MAX_BYTES
} = {}) {
  const items = [];
  let bytes = 0;
  return {
    get size() {
      return items.length;
    },
    get bytes() {
      return bytes;
    },
    push(value) {
      const text = String(value || '');
      const nextBytes = bytes + Buffer.byteLength(text);
      if (items.length >= maxMessages || nextBytes > maxBytes) {
        throw new Error('realtime_pending_queue_overflow');
      }
      items.push(text);
      bytes = nextBytes;
    },
    flush(send) {
      while (items.length) {
        const value = items.shift();
        bytes -= Buffer.byteLength(value);
        send(value);
      }
    }
  };
}

export function createRealtimeSender({
  upstream,
  pending,
  isUpstreamReady,
  sendClient,
  closeBoth
}) {
  return (payload) => {
    const serialized = JSON.stringify(payload);
    if (upstream.readyState === WebSocket.OPEN && isUpstreamReady()) {
      upstream.send(serialized);
      return true;
    }
    try {
      pending.push(serialized);
      return true;
    } catch (error) {
      sendClient({ type: 'voice.realtime.error', error: error.message || 'realtime_pending_queue_overflow' });
      closeBoth();
      return false;
    }
  };
}

export function startVoiceRealtimeProxy(client, { remoteAddress = '' } = {}) {
  const apiKey = realtimeApiKey();
  const status = publicVoiceRealtimeStatus();
  const provider = status.providerId || realtimeProvider();
  if (!status.configured) {
    client.send(JSON.stringify({
      type: 'voice.realtime.error',
      error: status.disabled ? '实时语音已禁用' : '未配置实时语音 API Key'
    }));
    client.close(1011, 'Realtime voice is not configured');
    return;
  }

  const upstreamUrl = realtimeWebSocketUrl(realtimeBaseUrl(), realtimeModel());
  const upstream = new WebSocket(upstreamUrl, {
    handshakeTimeout: REALTIME_TIMEOUT_MS,
    headers: realtimeHeaders(provider, apiKey)
  });
  const pending = createPendingRealtimeQueue();
  let closed = false;
  let upstreamReady = false;
  let upstreamResponseActive = false;

  const sendClient = (payload) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(payload));
    }
  };

  const flushPending = () => {
    if (upstream.readyState !== WebSocket.OPEN || !upstreamReady) {
      return;
    }
    pending.flush((value) => upstream.send(value));
  };

  const closeBoth = () => {
    if (closed) {
      return;
    }
    closed = true;
    try {
      upstream.close();
    } catch {
      // Socket may already be gone.
    }
    try {
      client.close();
    } catch {
      // Socket may already be gone.
    }
  };

  const sendUpstream = createRealtimeSender({
    upstream,
    pending,
    isUpstreamReady: () => upstreamReady,
    sendClient,
    closeBoth
  });

  const handoff = createRealtimeHandoffController({
    provider,
    sendClient,
    sendUpstream,
    getResponseActive: () => upstreamResponseActive,
    setResponseActive: (value) => {
      upstreamResponseActive = value;
    }
  });

  upstream.on('open', () => {
    upstream.send(JSON.stringify(realtimeSessionPayload(provider)));
    sendClient({
      type: 'voice.realtime.connecting',
      status
    });
  });

  upstream.on('message', (data) => {
    const text = Buffer.isBuffer(data) ? data.toString('utf8') : String(data);
    let event = null;
    try {
      event = JSON.parse(text);
    } catch {
      sendClient({ type: 'voice.realtime.raw', data: text });
      return;
    }

    if (event.type === 'session.updated') {
      upstreamReady = true;
      sendClient({
        type: 'voice.realtime.ready',
        status
      });
      flushPending();
    }

    if (event.type === 'response.created') {
      upstreamResponseActive = true;
    }
    if (event.type === 'error' && isBenignRealtimeCancelError(event)) {
      upstreamResponseActive = false;
      if (!handoff.beginPending()) {
        sendClient({ type: 'voice.realtime.cancel_ignored' });
      }
      return;
    }
    if (handoff.handleEvent(event)) {
      return;
    }
    if (event.type === 'response.done') {
      upstreamResponseActive = false;
      if (handoff.beginPending()) {
        return;
      }
    }

    sendClient(event);
  });

  upstream.on('unexpected-response', (req, res) => {
    let body = '';
    res.on('data', (chunk) => {
      body += chunk.toString();
    });
    res.on('end', () => {
      console.warn(`[realtime] upstream rejected status=${res.statusCode} remote=${remoteAddress} body=${safeMessage(body)}`);
      sendClient({
        type: 'voice.realtime.error',
        error: safeMessage(body || `Realtime upstream rejected: ${res.statusCode}`)
      });
      closeBoth();
    });
  });

  upstream.on('error', (error) => {
    console.warn(`[realtime] upstream error remote=${remoteAddress} message=${safeMessage(error.message)}`);
    sendClient({
      type: 'voice.realtime.error',
      error: safeMessage(error.message || '实时语音连接失败')
    });
    closeBoth();
  });

  upstream.on('close', () => {
    sendClient({ type: 'voice.realtime.closed' });
    closeBoth();
  });

  client.on('message', (data) => {
    if (realtimeClientFrameByteLength(data) > REALTIME_CLIENT_FRAME_MAX_BYTES) {
      sendClient({ type: 'voice.realtime.error', error: 'realtime_client_frame_too_large' });
      closeBoth();
      return;
    }
    let payload = null;
    try {
      payload = JSON.parse(realtimeClientFrameText(data));
    } catch {
      return;
    }

    if (payload.type === 'input_audio.append' && typeof payload.audio === 'string') {
      if (payload.audio.length > REALTIME_INPUT_AUDIO_MAX_CHARS) {
        sendClient({ type: 'voice.realtime.error', error: 'realtime_audio_frame_too_large' });
        closeBoth();
        return;
      }
      sendUpstream({ type: 'input_audio_buffer.append', audio: payload.audio });
      return;
    }
    if (payload.type === 'input_audio.clear') {
      sendUpstream({ type: 'input_audio_buffer.clear' });
      return;
    }
    if (payload.type === 'input_audio.commit') {
      if (sendUpstream({ type: 'input_audio_buffer.commit' }) && sendUpstream(realtimeResponseCreatePayload(provider))) {
        upstreamResponseActive = true;
      }
      return;
    }
    if (payload.type === 'response.cancel') {
      sendUpstream({ type: 'response.cancel' });
      return;
    }
    if (payload.type === 'voice.handoff.summarize') {
      handoff.request(payload.transcripts);
      return;
    }
    if (payload.type === 'close') {
      closeBoth();
    }
  });

  client.on('close', closeBoth);
  client.on('error', closeBoth);
}
