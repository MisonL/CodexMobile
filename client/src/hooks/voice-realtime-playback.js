import { REALTIME_VOICE_SAMPLE_RATE } from '../app-core-utils.js';
import { pcm16Base64ToFloat } from '../app-voice-utils.js';

export function stopRealtimePlayback(ctx, { release = false } = {}) {
  for (const source of ctx.playbackSourcesRef.current) {
    try {
      source.stop();
    } catch {
      // Already stopped.
    }
  }
  ctx.playbackSourcesRef.current.clear();
  const context = ctx.playbackContextRef.current;
  ctx.playheadRef.current = context?.currentTime || 0;
  if (release && context && context.state !== 'closed') {
    context.close?.().catch?.(() => null);
    ctx.playbackContextRef.current = null;
    ctx.playheadRef.current = 0;
  }
}

export function playRealtimeAudioDelta(ctx, delta) {
  if (!delta) {
    return;
  }
  const samples = pcm16Base64ToFloat(delta);
  if (!samples.length) {
    return;
  }
  const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextCtor) {
    return;
  }
  let context = ctx.playbackContextRef.current;
  if (!context || context.state === 'closed') {
    context = new AudioContextCtor();
    ctx.playbackContextRef.current = context;
    ctx.playheadRef.current = context.currentTime;
  }
  context.resume?.().catch?.(() => null);
  const outputSampleRate = Number(ctx.status.voiceRealtime?.outputSampleRate) || REALTIME_VOICE_SAMPLE_RATE;
  const buffer = context.createBuffer(1, samples.length, outputSampleRate);
  buffer.copyToChannel(samples, 0);
  const source = context.createBufferSource();
  source.buffer = buffer;
  source.connect(context.destination);
  ctx.playbackSourcesRef.current.add(source);
  source.onended = () => {
    ctx.playbackSourcesRef.current.delete(source);
    if (
      ctx.openRef.current &&
      ctx.realtimeRef.current &&
      ctx.playbackSourcesRef.current.size === 0 &&
      ctx.stateRef.current === 'speaking'
    ) {
      ctx.awaitingResponseRef.current = false;
      ctx.setMode('listening');
    }
  };
  const startAt = Math.max(ctx.playheadRef.current, context.currentTime + 0.03);
  source.start(startAt);
  ctx.playheadRef.current = startAt + buffer.duration;
}
