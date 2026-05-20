import { useCallback, useRef } from 'react';
import { apiBlobFetch } from '../api.js';
import { spokenReplyText } from '../app-voice-utils.js';
import { clearVoiceDialogAudio, playAudioBlob, speakWithBrowser, unlockVoiceDialogAudio } from './voice-recorded-audio.js';
import {
  clearVoiceDialogTimer,
  startVoiceDialogCapture,
  stopVoiceDialogStream,
  transcribeVoiceDialogBlob
} from './voice-recorded-capture.js';

export function useRecordedVoiceDialog(common, realtime) {
  const recorderRef = useRef(null);
  const chunksRef = useRef([]);
  const streamRef = useRef(null);
  const timerRef = useRef(null);
  const silenceFrameRef = useRef(null);
  const audioContextRef = useRef(null);
  const audioSourceRef = useRef(null);
  const speechStartedRef = useRef(false);
  const lastSoundAtRef = useRef(0);
  const audioRef = useRef(null);
  const audioUnlockedRef = useRef(false);
  const audioUrlRef = useRef('');

  const audio = { audioRef, audioUnlockedRef, audioUrlRef };

  const clearAudio = useCallback((options = {}) => {
    clearVoiceDialogAudio(audio, options);
  }, [audio]);

  const unlockAudio = useCallback(() => {
    unlockVoiceDialogAudio(audio);
  }, [audio]);

  const scheduleNextTurn = useCallback(() => {
    if (!common.openRef.current || !common.autoListenRef.current) {
      common.setMode('idle');
      return;
    }
    common.setMode('idle');
    window.setTimeout(() => {
      if (common.openRef.current && common.autoListenRef.current) {
        startRecording();
      }
    }, 220);
  }, [common]);

  const playReply = useCallback(async (message) => {
    const text = spokenReplyText(message?.content);
    if (!text) {
      scheduleNextTurn();
      return;
    }

    common.setAssistantText(text);
    common.setError('');
    common.setMode('speaking');

    try {
      const blob = await apiBlobFetch('/api/voice/speech', {
        method: 'POST',
        body: { text }
      });
      await playAudioBlob(audio, blob);
    } catch (error) {
      common.rememberRelayOperationLock('voiceDialog', error);
      try {
        await speakWithBrowser(text);
      } catch {
        common.setError(error.message || '朗读失败');
      }
    } finally {
      clearAudio();
      scheduleNextTurn();
    }
  }, [audio, clearAudio, common, scheduleNextTurn]);

  const handleRecorderStop = useCallback(async (recorder, mimeType) => {
    clearVoiceDialogTimer(timerRef);
    stopVoiceDialogStream(captureContext);
    const recordedType = recorder.mimeType || mimeType || 'audio/webm';
    const blob = new Blob(chunksRef.current, { type: recordedType });
    chunksRef.current = [];
    recorderRef.current = null;

    try {
      common.setMode('transcribing');
      const transcript = await transcribeVoiceDialogBlob(blob);
      common.setTranscript(transcript);
      common.setMode('sending');
      const turn = await common.onVoiceSubmit(transcript);
      common.awaitingTurnRef.current = {
        turnId: turn?.turnId,
        message: transcript,
        startedAt: Date.now()
      };
      common.setMode('waiting');
    } catch (error) {
      common.awaitingTurnRef.current = null;
      common.rememberRelayOperationLock('voiceDialog', error);
      common.setErrorBriefly(error.message || '语音对话失败');
    }
  }, [common]);

  const captureContext = {
    ...common,
    selectedProject: common.selectedProject,
    selectedProjectRef: common.selectedProjectRef,
    recorderRef,
    chunksRef,
    streamRef,
    timerRef,
    silenceFrameRef,
    audioContextRef,
    audioSourceRef,
    speechStartedRef,
    lastSoundAtRef,
    audio,
    handleRecorderStop
  };

  function startRecording() {
    if (common.realtimeRef.current) {
      realtime.startRealtime();
      return;
    }
    startVoiceDialogCapture(captureContext);
  }

  function stopRecording() {
    if (common.realtimeRef.current) {
      realtime.stopRealtime({ keepPanel: true });
      common.setMode('idle');
      return;
    }
    if (recorderRef.current?.state === 'recording') {
      common.setError('');
      common.setMode('transcribing');
      recorderRef.current.stop();
      return;
    }
    clearVoiceDialogTimer(timerRef);
    stopVoiceDialogStream(captureContext);
    common.setMode('idle');
  }

  function closeRecorded() {
    if (recorderRef.current?.state === 'recording') {
      recorderRef.current.onstop = null;
      recorderRef.current.stop();
    }
    recorderRef.current = null;
    clearVoiceDialogTimer(timerRef);
    stopVoiceDialogStream(captureContext);
    clearAudio({ release: true });
  }

  return {
    clearAudio,
    unlockAudio,
    playReply,
    startRecording,
    stopRecording,
    closeRecorded
  };
}
