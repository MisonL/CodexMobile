import { useEffect, useRef, useState } from 'react';
import { spokenReplyText } from '../app-voice-utils.js';
import { useRealtimeVoiceDialog } from './useRealtimeVoiceDialog.js';
import { useRecordedVoiceDialog } from './useRecordedVoiceDialog.js';

export function useVoiceDialogController({
  status,
  selectedProject,
  selectedProjectRef,
  messages,
  runningById,
  rememberRelayOperationLock,
  onVoiceSubmit,
  submitCodexMessage
}) {
  const awaitingTurnRef = useRef(null);
  const lastSpokenRef = useRef('');
  const autoListenRef = useRef(false);
  const openRef = useRef(false);
  const stateRef = useRef('idle');
  const realtimeRef = useRef(false);
  const ideaBufferRef = useRef([]);
  const handoffDraftRef = useRef('');
  const clearRecordedAudioRef = useRef(() => {});
  const [open, setOpen] = useState(false);
  const [state, setState] = useState('idle');
  const [error, setError] = useState('');
  const [transcript, setTranscript] = useState('');
  const [assistantText, setAssistantText] = useState('');
  const [handoffDraft, setHandoffDraft] = useState('');

  function setMode(next) {
    stateRef.current = next;
    setState(next);
  }

  function setHandoffDraftValue(next) {
    const value = String(next || '');
    handoffDraftRef.current = value;
    setHandoffDraft(value);
  }

  function setErrorBriefly(message) {
    setError(message);
    setMode('error');
  }

  const common = {
    status,
    selectedProject,
    selectedProjectRef,
    awaitingTurnRef,
    autoListenRef,
    openRef,
    stateRef,
    realtimeRef,
    ideaBufferRef,
    handoffDraftRef,
    rememberRelayOperationLock,
    onVoiceSubmit,
    setMode,
    setError,
    setErrorBriefly,
    setTranscript,
    setAssistantText,
    setHandoffDraft: setHandoffDraftValue,
    clearRecordedAudio: (...args) => clearRecordedAudioRef.current(...args)
  };
  const realtime = useRealtimeVoiceDialog(common);
  const recorded = useRecordedVoiceDialog(common, realtime);
  clearRecordedAudioRef.current = recorded.clearAudio;

  function continueHandoffCollection() {
    setHandoffDraftValue('');
    setError('');
    setAssistantText('');
    realtime.resumeAssistantAudio();
    setMode('listening');
  }

  function cancelHandoffConfirmation() {
    setHandoffDraftValue('');
    setError('');
    realtime.resumeAssistantAudio();
    setMode('listening');
  }

  async function submitHandoffToCodex() {
    const message = handoffDraftRef.current.trim();
    if (!message) {
      return;
    }
    if (!selectedProjectRef.current && !selectedProject) {
      setError('请先选择项目');
      setMode('handoff');
      return;
    }
    try {
      setError('');
      setMode('sending');
      await submitCodexMessage({ message });
      ideaBufferRef.current = [];
      setHandoffDraftValue('');
      closeDialog();
    } catch (submitError) {
      setError(submitError.message || '发送给 Codex 失败');
      setMode('handoff');
    }
  }

  function openDialog() {
    recorded.unlockAudio();
    openRef.current = true;
    realtimeRef.current = Boolean(status.voiceRealtime?.configured);
    autoListenRef.current = !realtimeRef.current;
    awaitingTurnRef.current = null;
    ideaBufferRef.current = [];
    setHandoffDraftValue('');
    setOpen(true);
    setError('');
    setTranscript('');
    setAssistantText('');
    setMode('idle');
    window.setTimeout(() => {
      if (!openRef.current) {
        return;
      }
      if (realtimeRef.current) {
        realtime.startRealtime();
      } else {
        recorded.startRecording();
      }
    }, 80);
  }

  function closeDialog() {
    autoListenRef.current = false;
    openRef.current = false;
    awaitingTurnRef.current = null;
    ideaBufferRef.current = [];
    setHandoffDraftValue('');
    realtime.stopRealtime();
    recorded.closeRecorded();
    setOpen(false);
    setError('');
    setTranscript('');
    setAssistantText('');
    setMode('idle');
  }

  useEffect(() => () => closeDialog(), []);

  useEffect(() => {
    const awaiting = awaitingTurnRef.current;
    if (!open || !awaiting?.turnId || stateRef.current !== 'waiting') {
      return;
    }
    if (runningById[awaiting.turnId]) {
      return;
    }

    const reversed = [...messages].reverse();
    let reply = reversed.find(
      (message) =>
        message.role === 'assistant' &&
        message.turnId === awaiting.turnId &&
        String(message.content || '').trim()
    );
    if (!reply) {
      let userIndex = -1;
      for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index];
        if (
          message.role === 'user' &&
          (message.turnId === awaiting.turnId || String(message.content || '').trim() === awaiting.message)
        ) {
          userIndex = index;
          break;
        }
      }
      if (userIndex >= 0) {
        reply = [...messages.slice(userIndex + 1)].reverse().find(
          (message) => message.role === 'assistant' && String(message.content || '').trim()
        );
      }
    }

    const speechText = spokenReplyText(reply?.content);
    if (!reply || !speechText) {
      return;
    }
    const speechKey = `${awaiting.turnId}:${reply.id}:${speechText.length}`;
    if (lastSpokenRef.current === speechKey) {
      return;
    }
    lastSpokenRef.current = speechKey;
    awaitingTurnRef.current = null;
    recorded.playReply(reply);
  }, [messages, open, recorded, runningById]);

  return {
    open,
    state,
    error,
    transcript,
    assistantText,
    handoffDraft,
    setHandoffDraft: setHandoffDraftValue,
    submitHandoffToCodex,
    continueHandoffCollection,
    cancelHandoffConfirmation,
    startRecording: recorded.startRecording,
    stopRecording: recorded.stopRecording,
    openDialog,
    closeDialog
  };
}
