import { VOICE_DIALOG_SILENCE_AUDIO } from '../app-core-utils.js';

export function ensureVoiceDialogAudio(audioRef) {
  if (!audioRef.current) {
    const audio = new Audio();
    audio.preload = 'auto';
    audio.playsInline = true;
    audioRef.current = audio;
  }
  return audioRef.current;
}

export function unlockVoiceDialogAudio(ctx) {
  if (ctx.audioUnlockedRef.current) {
    return;
  }
  try {
    const audio = ensureVoiceDialogAudio(ctx.audioRef);
    audio.muted = true;
    audio.src = VOICE_DIALOG_SILENCE_AUDIO;
    const playPromise = audio.play();
    playPromise
      ?.then?.(() => {
        audio.pause();
        audio.muted = false;
        audio.removeAttribute('src');
        audio.load?.();
        ctx.audioUnlockedRef.current = true;
      })
      ?.catch?.(() => {
        audio.muted = false;
      });
  } catch {
    ctx.audioUnlockedRef.current = false;
  }
}

export function clearVoiceDialogAudio(ctx, { release = false } = {}) {
  const audio = ctx.audioRef.current;
  if (audio) {
    audio.pause();
    audio.onended = null;
    audio.onerror = null;
    audio.removeAttribute('src');
    audio.load?.();
    if (release) {
      ctx.audioRef.current = null;
      ctx.audioUnlockedRef.current = false;
    }
  }
  if (ctx.audioUrlRef.current) {
    URL.revokeObjectURL(ctx.audioUrlRef.current);
    ctx.audioUrlRef.current = '';
  }
  window.speechSynthesis?.cancel?.();
}

export function playAudioBlob(ctx, blob) {
  return new Promise((resolve, reject) => {
    clearVoiceDialogAudio(ctx);
    const url = URL.createObjectURL(blob);
    const audio = ensureVoiceDialogAudio(ctx.audioRef);
    ctx.audioUrlRef.current = url;
    audio.muted = false;
    audio.src = url;
    audio.playsInline = true;
    audio.onended = () => {
      ctx.audioUnlockedRef.current = true;
      resolve();
    };
    audio.onerror = () => reject(new Error('播放失败'));
    audio.load?.();
    audio.play().catch(reject);
  });
}

export function speakWithBrowser(text) {
  return new Promise((resolve, reject) => {
    if (!window.speechSynthesis || !window.SpeechSynthesisUtterance) {
      reject(new Error('当前浏览器不支持朗读'));
      return;
    }
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = 'zh-CN';
    utterance.rate = 1;
    utterance.pitch = 1;
    utterance.onend = resolve;
    utterance.onerror = () => reject(new Error('朗读失败'));
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(utterance);
  });
}
