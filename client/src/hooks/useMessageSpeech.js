import { useCallback, useEffect, useRef, useState } from 'react';
import { apiBlobFetch } from '../api.js';
import { spokenReplyText, splitSpeechSegments } from '../app-voice-utils.js';

const DEFAULT_SPEECH_LANG = 'zh-CN';
const DEFAULT_SPEECH_RATE = 1;
const DEFAULT_SPEECH_PITCH = 1;

function ensureMessageSpeechAudio(audioRef) {
  if (!audioRef.current) {
    const audio = new Audio();
    audio.preload = 'auto';
    audio.playsInline = true;
    audioRef.current = audio;
  }
  return audioRef.current;
}

function clearMessageSpeechAudio(ctx, { release = false, abortRequest = false } = {}) {
  if (abortRequest) {
    ctx.abortRef.current?.abort?.();
    ctx.abortRef.current = null;
  }
  ctx.stopPlaybackRef.current?.();
  const audio = ctx.audioRef.current;
  if (audio) {
    audio.pause();
    audio.onended = null;
    audio.onerror = null;
    audio.removeAttribute('src');
    audio.load?.();
    if (release) {
      ctx.audioRef.current = null;
    }
  }
  if (ctx.audioUrlRef.current) {
    URL.revokeObjectURL(ctx.audioUrlRef.current);
    ctx.audioUrlRef.current = '';
  }
  window.speechSynthesis?.cancel?.();
}

function stopMessageSpeech(ctx, { release = false, resetState = true } = {}) {
  ctx.runRef.current += 1;
  clearMessageSpeechAudio(ctx, { release, abortRequest: true });
  if (resetState) {
    ctx.setSpeakingMessageId('');
    ctx.setSpeechLoadingMessageId('');
  }
}

function speakWithBrowser(text, stopPlaybackRef, options = {}) {
  return new Promise((resolve, reject) => {
    if (!window.speechSynthesis || !window.SpeechSynthesisUtterance) {
      reject(new Error('Browser speech synthesis is not supported'));
      return;
    }
    const utterance = new SpeechSynthesisUtterance(text);
    let settled = false;
    const finish = (error) => {
      if (settled) {
        return;
      }
      settled = true;
      if (stopPlaybackRef.current === stopBrowserSpeech) {
        stopPlaybackRef.current = null;
      }
      utterance.onend = null;
      utterance.onerror = null;
      error ? reject(error) : resolve();
    };
    function stopBrowserSpeech() {
      window.speechSynthesis.cancel();
      finish();
    }
    utterance.lang = options.lang || DEFAULT_SPEECH_LANG;
    utterance.rate = Number.isFinite(options.rate) ? options.rate : DEFAULT_SPEECH_RATE;
    utterance.pitch = Number.isFinite(options.pitch) ? options.pitch : DEFAULT_SPEECH_PITCH;
    utterance.onend = () => finish();
    utterance.onerror = () => finish(new Error('Browser speech synthesis failed'));
    stopPlaybackRef.current = stopBrowserSpeech;
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(utterance);
  });
}

function playMessageAudioBlob(ctx, blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const audio = ensureMessageSpeechAudio(ctx.audioRef);
    let settled = false;
    const finish = (error) => {
      if (settled) {
        return;
      }
      settled = true;
      if (ctx.stopPlaybackRef.current === finish) {
        ctx.stopPlaybackRef.current = null;
      }
      audio.onended = null;
      audio.onerror = null;
      error ? reject(error) : resolve();
    };
    clearMessageSpeechAudio(ctx);
    ctx.audioUrlRef.current = url;
    ctx.stopPlaybackRef.current = finish;
    audio.muted = false;
    audio.src = url;
    audio.playsInline = true;
    audio.onended = () => finish();
    audio.onerror = () => finish(new Error('Message speech playback failed'));
    audio.load?.();
    audio.play().catch(finish);
  });
}

async function fetchMessageSpeechBlob(ctx, text, runId) {
  if (ctx.runRef.current !== runId) {
    throw new Error('Message speech was stopped');
  }
  const controller = new AbortController();
  ctx.abortRef.current = controller;
  try {
    return await apiBlobFetch('/api/voice/speech', {
      method: 'POST',
      body: { text },
      signal: controller.signal
    });
  } finally {
    if (ctx.abortRef.current === controller) {
      ctx.abortRef.current = null;
    }
  }
}

function messageSpeechProviderError(error, fallbackStartIndex) {
  const wrappedError = new Error(error?.message || String(error || 'Message speech failed'));
  wrappedError.name = error?.name || 'MessageSpeechProviderError';
  wrappedError.fallbackStartIndex = fallbackStartIndex;
  return wrappedError;
}

async function playProviderSegments(ctx, { messageId, segments, runId }) {
  let blob = await fetchMessageSpeechBlob(ctx, segments[0], runId);
  if (ctx.runRef.current !== runId) {
    return { stopped: true, fallbackStartIndex: 0 };
  }
  ctx.setSpeechLoadingMessageId('');
  ctx.setSpeakingMessageId(messageId);
  let fallbackStartIndex = 0;

  try {
    for (let index = 0; index < segments.length; index += 1) {
      fallbackStartIndex = index;
      const nextIndex = index + 1;
      const nextBlobPromise = nextIndex < segments.length
        ? fetchMessageSpeechBlob(ctx, segments[nextIndex], runId)
          .then((nextBlob) => ({ blob: nextBlob }))
          .catch((error) => ({ error }))
        : null;
      await playMessageAudioBlob(ctx, blob);
      fallbackStartIndex = index + 1;
      if (ctx.runRef.current !== runId || !nextBlobPromise) {
        break;
      }
      ctx.setSpeechLoadingMessageId(messageId);
      const next = await nextBlobPromise;
      if (next.error) {
        throw next.error;
      }
      blob = next.blob;
      ctx.setSpeechLoadingMessageId('');
      ctx.setSpeakingMessageId(messageId);
    }
  } catch (error) {
    throw messageSpeechProviderError(error, fallbackStartIndex);
  }
  return { stopped: ctx.runRef.current !== runId, fallbackStartIndex };
}

async function fallbackMessageSpeech(ctx, { messageId, segments, fallbackStartIndex, runId }) {
  const startIndex = Math.max(0, Number(fallbackStartIndex) || 0);
  const fallbackText = segments.slice(startIndex).join(' ');
  try {
    ctx.setSpeechLoadingMessageId('');
    ctx.setSpeakingMessageId(messageId);
    if (fallbackText) {
      await speakWithBrowser(fallbackText, ctx.stopPlaybackRef);
    }
  } catch (fallbackError) {
    if (ctx.runRef.current === runId) {
      console.warn('[voice] browser message speech failed:', fallbackError.message || fallbackError);
    }
  }
}

async function speakMessageFromContext(ctx, message) {
  const messageId = String(message?.id || '');
  if (!messageId || message?.role !== 'assistant') {
    return;
  }
  if (ctx.speakingMessageId === messageId || ctx.speechLoadingMessageId === messageId) {
    stopMessageSpeech(ctx);
    return;
  }
  const segments = splitSpeechSegments(spokenReplyText(message.content));
  if (!segments.length) {
    return;
  }

  ctx.runRef.current += 1;
  const runId = ctx.runRef.current;
  clearMessageSpeechAudio(ctx, { abortRequest: true });
  ctx.setSpeechLoadingMessageId(messageId);
  ctx.setSpeakingMessageId('');

  try {
    const result = await playProviderSegments(ctx, { messageId, segments, runId });
    if (result.stopped) {
      return;
    }
  } catch (error) {
    if (error?.name === 'AbortError' || ctx.runRef.current !== runId) {
      return;
    }
    console.warn('[voice] message speech failed, using browser fallback:', error.message || error);
    await fallbackMessageSpeech(ctx, { messageId, segments, runId, fallbackStartIndex: error?.fallbackStartIndex });
  } finally {
    if (ctx.runRef.current === runId) {
      clearMessageSpeechAudio(ctx);
      ctx.setSpeakingMessageId('');
      ctx.setSpeechLoadingMessageId('');
    }
  }
}

export function useMessageSpeech(selectedSessionId) {
  const [speakingMessageId, setSpeakingMessageId] = useState('');
  const [speechLoadingMessageId, setSpeechLoadingMessageId] = useState('');
  const ctxRef = useRef({});
  ctxRef.current = {
    speakingMessageId,
    speechLoadingMessageId,
    setSpeakingMessageId,
    setSpeechLoadingMessageId,
    audioRef: ctxRef.current.audioRef || { current: null },
    audioUrlRef: ctxRef.current.audioUrlRef || { current: '' },
    abortRef: ctxRef.current.abortRef || { current: null },
    stopPlaybackRef: ctxRef.current.stopPlaybackRef || { current: null },
    runRef: ctxRef.current.runRef || { current: 0 }
  };

  const stopSpeech = useCallback((options) => {
    stopMessageSpeech(ctxRef.current, options);
  }, []);
  const speakMessage = useCallback((message) => {
    speakMessageFromContext(ctxRef.current, message);
  }, []);

  useEffect(() => () => stopSpeech({ release: true, resetState: false }), [stopSpeech]);
  useEffect(() => {
    stopSpeech();
  }, [selectedSessionId, stopSpeech]);

  return {
    speakingMessageId,
    speechLoadingMessageId,
    speakMessage,
    stopSpeech
  };
}
