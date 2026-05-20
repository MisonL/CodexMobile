import { useCallback, useRef } from 'react';
import { realtimeVoiceWebsocketUrl } from '../api.js';
import { handleRealtimeVoiceEvent } from './voice-realtime-events.js';
import { startRealtimeMicrophone } from './voice-realtime-microphone.js';
import { playRealtimeAudioDelta, stopRealtimePlayback } from './voice-realtime-playback.js';

export function useRealtimeVoiceDialog(common) {
  const socketRef = useRef(null);
  const streamRef = useRef(null);
  const audioContextRef = useRef(null);
  const audioSourceRef = useRef(null);
  const processorRef = useRef(null);
  const playbackContextRef = useRef(null);
  const playbackSourcesRef = useRef(new Set());
  const playheadRef = useRef(0);
  const assistantTextRef = useRef('');
  const speechStartedRef = useRef(false);
  const turnStartedAtRef = useRef(0);
  const lastSoundAtRef = useRef(0);
  const awaitingResponseRef = useRef(false);
  const bargeInStartedAtRef = useRef(0);
  const suppressAssistantAudioRef = useRef(false);

  const appendIdeaTranscript = useCallback((transcript) => {
    const text = String(transcript || '').replace(/\s+/g, ' ').trim();
    if (!text) {
      return;
    }
    const buffer = common.ideaBufferRef.current;
    if (buffer[buffer.length - 1] === text) {
      return;
    }
    buffer.push(text);
    if (buffer.length > 30) {
      buffer.splice(0, buffer.length - 30);
    }
  }, [common.ideaBufferRef]);

  const stopPlayback = useCallback((options = {}) => {
    stopRealtimePlayback({ playbackSourcesRef, playbackContextRef, playheadRef }, options);
  }, []);

  const playAudioDelta = useCallback((delta) => {
    playRealtimeAudioDelta({
      ...common,
      playbackSourcesRef,
      playbackContextRef,
      playheadRef
    }, delta);
  }, [common]);

  const stopRealtime = useCallback(({ keepPanel = false } = {}) => {
    const socket = socketRef.current;
    socketRef.current = null;
    if (socket) {
      socket.onopen = null;
      socket.onmessage = null;
      socket.onerror = null;
      socket.onclose = null;
      try {
        socket.send(JSON.stringify({ type: 'close' }));
      } catch {
        // Socket may already be closed.
      }
      try {
        socket.close();
      } catch {
        // Socket may already be closed.
      }
    }

    processorRef.current?.disconnect?.();
    processorRef.current = null;
    audioSourceRef.current?.disconnect?.();
    audioSourceRef.current = null;
    streamRef.current?.getTracks?.().forEach((track) => track.stop());
    streamRef.current = null;
    const context = audioContextRef.current;
    audioContextRef.current = null;
    if (context && context.state !== 'closed') {
      context.close?.().catch?.(() => null);
    }
    assistantTextRef.current = '';
    speechStartedRef.current = false;
    turnStartedAtRef.current = 0;
    lastSoundAtRef.current = 0;
    awaitingResponseRef.current = false;
    bargeInStartedAtRef.current = 0;
    suppressAssistantAudioRef.current = false;
    stopPlayback({ release: true });
    if (!keepPanel) {
      common.realtimeRef.current = false;
    }
  }, [common, stopPlayback]);

  const requestHandoffSummary = useCallback((triggerText = '') => {
    const socket = socketRef.current;
    const transcripts = common.ideaBufferRef.current.filter(Boolean);
    if (!transcripts.length) {
      common.setErrorBriefly('还没有可整理的语音内容');
      return;
    }
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      common.setErrorBriefly('实时语音连接不可用');
      return;
    }
    stopPlayback();
    suppressAssistantAudioRef.current = true;
    awaitingResponseRef.current = false;
    bargeInStartedAtRef.current = 0;
    assistantTextRef.current = '';
    common.setAssistantText('');
    common.setHandoffDraft('');
    common.setError('');
    common.setMode('summarizing');
    socket.send(JSON.stringify({
      type: 'voice.handoff.summarize',
      transcripts,
      trigger: triggerText
    }));
  }, [common, stopPlayback]);

  const resumeAssistantAudio = useCallback(() => {
    suppressAssistantAudioRef.current = false;
  }, []);

  const runtimeContext = {
    ...common,
    socketRef,
    streamRef,
    audioContextRef,
    audioSourceRef,
    processorRef,
    playbackContextRef,
    playbackSourcesRef,
    playheadRef,
    assistantTextRef,
    speechStartedRef,
    turnStartedAtRef,
    lastSoundAtRef,
    awaitingResponseRef,
    bargeInStartedAtRef,
    suppressAssistantAudioRef,
    appendIdeaTranscript,
    requestHandoffSummary,
    stopPlayback,
    playAudioDelta,
    stopRealtime,
    startMicrophone: (socket) => startRealtimeMicrophone(runtimeContext, socket)
  };

  const startRealtime = useCallback(() => {
    if (!common.status.voiceRealtime?.configured) {
      common.setErrorBriefly('未配置实时语音');
      return;
    }
    if (socketRef.current) {
      return;
    }
    common.clearRecordedAudio();
    stopRealtime({ keepPanel: true });
    common.realtimeRef.current = true;
    assistantTextRef.current = '';
    common.setError('');
    common.setTranscript('');
    common.setAssistantText('');
    common.setMode('waiting');

    const socket = new WebSocket(realtimeVoiceWebsocketUrl());
    socketRef.current = socket;
    socket.onopen = () => {
      common.setMode('waiting');
    };
    socket.onmessage = (event) => {
      try {
        handleRealtimeVoiceEvent(runtimeContext, JSON.parse(event.data));
      } catch {
        // Ignore malformed proxy events.
      }
    };
    socket.onerror = () => {
      common.setErrorBriefly('实时语音连接失败');
      stopRealtime({ keepPanel: true });
    };
    socket.onclose = () => {
      if (common.openRef.current && common.realtimeRef.current) {
        stopRealtime({ keepPanel: true });
        common.setMode('idle');
      }
    };
  }, [common, runtimeContext, stopRealtime]);

  return {
    startRealtime,
    stopRealtime,
    stopPlayback,
    requestHandoffSummary,
    resumeAssistantAudio
  };
}
