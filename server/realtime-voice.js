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
  const pending = [];
  let closed = false;
  let upstreamReady = false;
  let upstreamResponseActive = false;

  const sendClient = (payload) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(payload));
    }
  };

  const sendUpstream = (payload) => {
    const serialized = JSON.stringify(payload);
    if (upstream.readyState === WebSocket.OPEN && upstreamReady) {
      upstream.send(serialized);
      return;
    }
    pending.push(serialized);
  };

  const flushPending = () => {
    if (upstream.readyState !== WebSocket.OPEN || !upstreamReady) {
      return;
    }
    while (pending.length) {
      upstream.send(pending.shift());
    }
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
    let payload = null;
    try {
      payload = JSON.parse(Buffer.isBuffer(data) ? data.toString('utf8') : String(data));
    } catch {
      return;
    }

    if (payload.type === 'input_audio.append' && typeof payload.audio === 'string') {
      sendUpstream({ type: 'input_audio_buffer.append', audio: payload.audio });
      return;
    }
    if (payload.type === 'input_audio.clear') {
      sendUpstream({ type: 'input_audio_buffer.clear' });
      return;
    }
    if (payload.type === 'input_audio.commit') {
      sendUpstream({ type: 'input_audio_buffer.commit' });
      sendUpstream(realtimeResponseCreatePayload(provider));
      upstreamResponseActive = true;
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
