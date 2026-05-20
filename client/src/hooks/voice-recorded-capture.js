import {
  VOICE_DIALOG_LEVEL_THRESHOLD,
  VOICE_DIALOG_MIN_RECORDING_MS,
  VOICE_DIALOG_SILENCE_MS,
  VOICE_MAX_RECORDING_MS,
  VOICE_MAX_UPLOAD_BYTES,
  VOICE_MIME_CANDIDATES
} from '../app-core-utils.js';
import { apiFetch } from '../api.js';
import { clearVoiceDialogAudio, unlockVoiceDialogAudio } from './voice-recorded-audio.js';

export function clearVoiceDialogTimer(timerRef) {
  if (timerRef.current) {
    window.clearTimeout(timerRef.current);
    timerRef.current = null;
  }
}

export function clearVoiceDialogSilenceDetection(ctx) {
  if (ctx.silenceFrameRef.current) {
    window.cancelAnimationFrame(ctx.silenceFrameRef.current);
    ctx.silenceFrameRef.current = null;
  }
  ctx.audioSourceRef.current?.disconnect?.();
  ctx.audioSourceRef.current = null;
  const context = ctx.audioContextRef.current;
  ctx.audioContextRef.current = null;
  if (context && context.state !== 'closed') {
    const closePromise = context.close?.();
    closePromise?.catch?.(() => null);
  }
  ctx.speechStartedRef.current = false;
  ctx.lastSoundAtRef.current = 0;
}

export function stopVoiceDialogStream(ctx) {
  clearVoiceDialogSilenceDetection(ctx);
  ctx.streamRef.current?.getTracks?.().forEach((track) => track.stop());
  ctx.streamRef.current = null;
}

export function setupVoiceDialogSilenceDetection(ctx, stream, recorder) {
  clearVoiceDialogSilenceDetection(ctx);
  const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextCtor) {
    return;
  }

  try {
    const context = new AudioContextCtor();
    const source = context.createMediaStreamSource(stream);
    const analyser = context.createAnalyser();
    analyser.fftSize = 1024;
    source.connect(analyser);
    ctx.audioContextRef.current = context;
    ctx.audioSourceRef.current = source;
    ctx.speechStartedRef.current = false;

    const samples = new Uint8Array(analyser.fftSize);
    const startedAt = performance.now();
    ctx.lastSoundAtRef.current = startedAt;

    const tick = (now) => {
      if (!ctx.openRef.current || recorder.state !== 'recording') {
        return;
      }

      analyser.getByteTimeDomainData(samples);
      let total = 0;
      for (let index = 0; index < samples.length; index += 1) {
        const value = (samples[index] - 128) / 128;
        total += value * value;
      }
      const level = Math.sqrt(total / samples.length);
      if (level >= VOICE_DIALOG_LEVEL_THRESHOLD) {
        ctx.speechStartedRef.current = true;
        ctx.lastSoundAtRef.current = now;
      }

      const heardSpeech = ctx.speechStartedRef.current;
      const recordingLongEnough = now - startedAt >= VOICE_DIALOG_MIN_RECORDING_MS;
      const silentLongEnough = now - ctx.lastSoundAtRef.current >= VOICE_DIALOG_SILENCE_MS;
      if (heardSpeech && recordingLongEnough && silentLongEnough) {
        ctx.setMode('transcribing');
        recorder.stop();
        return;
      }

      ctx.silenceFrameRef.current = window.requestAnimationFrame(tick);
    };

    const resumePromise = context.resume?.();
    resumePromise?.catch?.(() => null);
    ctx.silenceFrameRef.current = window.requestAnimationFrame(tick);
  } catch {
    clearVoiceDialogSilenceDetection(ctx);
  }
}

export function voiceDialogMimeType() {
  if (!window.MediaRecorder?.isTypeSupported) {
    return '';
  }
  return VOICE_MIME_CANDIDATES.find((type) => window.MediaRecorder.isTypeSupported(type)) || '';
}

export async function transcribeVoiceDialogBlob(blob) {
  if (!blob?.size) {
    throw new Error('没有录到声音');
  }
  if (blob.size > VOICE_MAX_UPLOAD_BYTES) {
    throw new Error('录音超过 10MB');
  }

  const formData = new FormData();
  const extension = blob.type.includes('mp4') ? 'm4a' : 'webm';
  formData.append('audio', blob, `voice-dialog.${extension}`);
  const result = await apiFetch('/api/voice/transcribe', {
    method: 'POST',
    body: formData
  });
  const text = String(result.text || '').trim();
  if (!text) {
    throw new Error('没有识别到文字');
  }
  return text;
}

export async function startVoiceDialogCapture(ctx) {
  if (!ctx.openRef.current) {
    return;
  }
  if (['transcribing', 'sending', 'waiting', 'speaking'].includes(ctx.stateRef.current)) {
    return;
  }
  clearVoiceDialogTimer(ctx.timerRef);
  clearVoiceDialogAudio(ctx.audio);
  unlockVoiceDialogAudio(ctx.audio);
  ctx.setError('');
  ctx.setTranscript('');
  ctx.setAssistantText('');

  if (!ctx.selectedProjectRef.current && !ctx.selectedProject) {
    ctx.setErrorBriefly('请先选择项目');
    return;
  }
  if (!window.isSecureContext) {
    ctx.setErrorBriefly('请使用 HTTPS 地址');
    return;
  }
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
    ctx.setErrorBriefly('当前浏览器不支持录音');
    return;
  }

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mimeType = voiceDialogMimeType();
    const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    ctx.streamRef.current = stream;
    ctx.chunksRef.current = [];
    ctx.recorderRef.current = recorder;
    setupVoiceDialogSilenceDetection(ctx, stream, recorder);

    recorder.ondataavailable = (event) => {
      if (event.data?.size) {
        ctx.chunksRef.current.push(event.data);
      }
    };
    recorder.onerror = () => {
      clearVoiceDialogTimer(ctx.timerRef);
      stopVoiceDialogStream(ctx);
      ctx.recorderRef.current = null;
      ctx.setErrorBriefly('录音失败');
    };
    recorder.onstop = () => ctx.handleRecorderStop(recorder, mimeType);

    recorder.start();
    ctx.setMode('listening');
    ctx.timerRef.current = window.setTimeout(() => {
      if (ctx.recorderRef.current?.state === 'recording') {
        ctx.setMode('transcribing');
        ctx.recorderRef.current.stop();
      }
    }, VOICE_MAX_RECORDING_MS);
  } catch (error) {
    clearVoiceDialogTimer(ctx.timerRef);
    stopVoiceDialogStream(ctx);
    ctx.recorderRef.current = null;
    const denied = error?.name === 'NotAllowedError' || error?.name === 'SecurityError';
    ctx.setErrorBriefly(denied ? '麦克风权限被拒绝' : '录音启动失败');
  }
}
