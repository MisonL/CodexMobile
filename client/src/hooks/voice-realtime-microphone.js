import {
  REALTIME_VOICE_BARGE_IN_LEVEL_THRESHOLD,
  REALTIME_VOICE_BARGE_IN_SUSTAIN_MS,
  REALTIME_VOICE_BUFFER_SIZE,
  REALTIME_VOICE_MIN_TURN_MS,
  REALTIME_VOICE_SAMPLE_RATE,
  VOICE_DIALOG_LEVEL_THRESHOLD,
  VOICE_DIALOG_SILENCE_MS
} from '../app-core-utils.js';
import { audioLevel, downsampleAudio, floatToPcm16Base64 } from '../app-voice-utils.js';

export async function startRealtimeMicrophone(ctx, socket) {
  if (!window.isSecureContext) {
    throw new Error('请使用 HTTPS 地址');
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('当前浏览器不支持录音');
  }
  const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextCtor) {
    throw new Error('当前浏览器不支持实时音频');
  }

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true
    }
  });
  const context = new AudioContextCtor();
  await context.resume?.().catch?.(() => null);
  const source = context.createMediaStreamSource(stream);
  const processor = context.createScriptProcessor(REALTIME_VOICE_BUFFER_SIZE, 1, 1);
  const inputSampleRate = Number(ctx.status.voiceRealtime?.inputSampleRate) || REALTIME_VOICE_SAMPLE_RATE;
  const useClientVad = Boolean(ctx.status.voiceRealtime?.clientTurnDetection);
  const silenceMs = Number(ctx.status.voiceRealtime?.clientVadSilenceMs) || VOICE_DIALOG_SILENCE_MS;

  const commitCurrentTurn = () => {
    if (!ctx.speechStartedRef.current || socket.readyState !== WebSocket.OPEN) {
      return;
    }
    ctx.speechStartedRef.current = false;
    ctx.bargeInStartedAtRef.current = 0;
    ctx.awaitingResponseRef.current = true;
    ctx.suppressAssistantAudioRef.current = false;
    ctx.setMode('waiting');
    socket.send(JSON.stringify({ type: 'input_audio.commit' }));
  };

  const beginBargeIn = () => {
    ctx.suppressAssistantAudioRef.current = true;
    socket.send(JSON.stringify({ type: 'response.cancel' }));
    socket.send(JSON.stringify({ type: 'input_audio.clear' }));
    ctx.stopPlayback();
    ctx.awaitingResponseRef.current = false;
    ctx.bargeInStartedAtRef.current = 0;
    ctx.assistantTextRef.current = '';
    ctx.setAssistantText('');
    ctx.setMode('listening');
  };

  processor.onaudioprocess = (event) => {
    const output = event.outputBuffer.getChannelData(0);
    output.fill(0);
    if (!ctx.openRef.current || !ctx.realtimeRef.current || socket.readyState !== WebSocket.OPEN) {
      return;
    }
    if (ctx.stateRef.current === 'summarizing' || ctx.stateRef.current === 'handoff') {
      return;
    }
    const input = event.inputBuffer.getChannelData(0);
    const downsampled = downsampleAudio(input, context.sampleRate, inputSampleRate);
    if (!useClientVad) {
      socket.send(JSON.stringify({ type: 'input_audio.append', audio: floatToPcm16Base64(downsampled) }));
      return;
    }

    const now = performance.now();
    const level = audioLevel(downsampled);
    const hasSound = level >= VOICE_DIALOG_LEVEL_THRESHOLD;
    if (ctx.awaitingResponseRef.current) {
      const playbackActive = ctx.playbackSourcesRef.current.size > 0 || ctx.stateRef.current === 'speaking';
      if (playbackActive) {
        const bargeInCandidate = level >= REALTIME_VOICE_BARGE_IN_LEVEL_THRESHOLD;
        if (!bargeInCandidate) {
          ctx.bargeInStartedAtRef.current = 0;
          return;
        }
        if (!ctx.bargeInStartedAtRef.current) {
          ctx.bargeInStartedAtRef.current = now;
          return;
        }
        if (now - ctx.bargeInStartedAtRef.current < REALTIME_VOICE_BARGE_IN_SUSTAIN_MS) {
          return;
        }
        beginBargeIn();
      } else if (hasSound) {
        beginBargeIn();
      } else {
        ctx.bargeInStartedAtRef.current = 0;
        return;
      }
    }

    if (hasSound) {
      if (!ctx.speechStartedRef.current) {
        ctx.speechStartedRef.current = true;
        ctx.turnStartedAtRef.current = now;
        ctx.setMode('listening');
      }
      ctx.lastSoundAtRef.current = now;
    }
    if (!ctx.speechStartedRef.current) {
      return;
    }

    socket.send(JSON.stringify({ type: 'input_audio.append', audio: floatToPcm16Base64(downsampled) }));
    const turnLongEnough = now - ctx.turnStartedAtRef.current >= REALTIME_VOICE_MIN_TURN_MS;
    const silentLongEnough = now - ctx.lastSoundAtRef.current >= silenceMs;
    if (turnLongEnough && silentLongEnough) {
      commitCurrentTurn();
    }
  };

  source.connect(processor);
  processor.connect(context.destination);
  ctx.streamRef.current = stream;
  ctx.audioContextRef.current = context;
  ctx.audioSourceRef.current = source;
  ctx.processorRef.current = processor;
}
