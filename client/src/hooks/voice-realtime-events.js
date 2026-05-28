import { isBenignRealtimeCancelError, isVoiceHandoffCommand } from '../voice-utils.js';

const REALTIME_ERROR_MESSAGES = {
  realtime_audio_frame_too_large: '实时语音数据过大',
  realtime_pending_queue_overflow: '实时语音请求积压过多，请稍后重试'
};

export function realtimeVoiceErrorMessage(error) {
  const value = typeof error === 'object' && error !== null ? error.message : error;
  const message = String(value || '').trim();
  return REALTIME_ERROR_MESSAGES[message] || message || '实时语音连接失败';
}

export function handleRealtimeVoiceEvent(ctx, payload) {
  if (!ctx.openRef.current || !ctx.realtimeRef.current) {
    return;
  }
  if (payload.type === 'voice.realtime.connecting') {
    ctx.setMode('waiting');
    return;
  }
  if (payload.type === 'voice.realtime.ready') {
    const socket = ctx.socketRef.current;
    if (!socket || ctx.streamRef.current) {
      ctx.setMode('listening');
      return;
    }
    ctx.startMicrophone(socket)
      .then(() => {
        ctx.setError('');
        ctx.setMode('listening');
      })
      .catch((error) => {
        ctx.setErrorBriefly(error.message || '实时语音启动失败');
        ctx.stopRealtime({ keepPanel: true });
      });
    return;
  }
  if (payload.type === 'voice.realtime.cancel_ignored') {
    ctx.awaitingResponseRef.current = false;
    ctx.bargeInStartedAtRef.current = 0;
    ctx.setError('');
    ctx.setMode('listening');
    return;
  }
  if (payload.type === 'voice.handoff.summarizing') {
    ctx.stopPlayback();
    ctx.suppressAssistantAudioRef.current = true;
    ctx.assistantTextRef.current = '';
    ctx.setAssistantText('');
    ctx.setError('');
    ctx.setMode('summarizing');
    return;
  }
  if (payload.type === 'voice.handoff.summary_delta') {
    return;
  }
  if (payload.type === 'voice.handoff.summary_done') {
    const draft = String(payload.message || payload.rawText || '').trim();
    if (!draft) {
      ctx.setErrorBriefly('没有整理出可交给 Codex 的任务');
      return;
    }
    ctx.setHandoffDraft(draft);
    ctx.setAssistantText('');
    ctx.setError(payload.parsed ? '' : '整理结果不是标准 JSON，已作为草稿保留');
    ctx.setMode('handoff');
    return;
  }
  if (payload.type === 'voice.handoff.summary_error') {
    ctx.suppressAssistantAudioRef.current = false;
    ctx.setErrorBriefly(payload.error || '语音任务整理失败');
    return;
  }
  if (payload.type === 'response.created') {
    if (ctx.stateRef.current === 'summarizing' || ctx.stateRef.current === 'handoff') {
      return;
    }
    ctx.suppressAssistantAudioRef.current = false;
    ctx.awaitingResponseRef.current = true;
    return;
  }
  if (payload.type === 'voice.realtime.error' || payload.type === 'error') {
    if (isBenignRealtimeCancelError(payload)) {
      ctx.awaitingResponseRef.current = false;
      ctx.bargeInStartedAtRef.current = 0;
      ctx.setError('');
      ctx.setMode('listening');
      return;
    }
    const message = realtimeVoiceErrorMessage(payload.error);
    ctx.awaitingResponseRef.current = false;
    ctx.setErrorBriefly(message);
    ctx.stopRealtime({ keepPanel: true });
    ctx.setMode('idle');
    return;
  }
  if (payload.type === 'input_audio_buffer.speech_started') {
    ctx.stopPlayback();
    ctx.assistantTextRef.current = '';
    ctx.awaitingResponseRef.current = false;
    ctx.setAssistantText('');
    ctx.setMode('listening');
    return;
  }
  if (payload.type === 'input_audio_buffer.speech_stopped') {
    ctx.setMode('waiting');
    return;
  }
  if (payload.type === 'conversation.item.input_audio_transcription.completed' && payload.transcript) {
    const transcript = String(payload.transcript || '').trim();
    ctx.setTranscript(transcript);
    if (isVoiceHandoffCommand(transcript)) {
      ctx.requestHandoffSummary(transcript);
      return;
    }
    ctx.appendIdeaTranscript(transcript);
    return;
  }
  if (
    (payload.type === 'response.audio_transcript.delta' ||
      payload.type === 'response.output_audio_transcript.delta') &&
    payload.delta
  ) {
    if (ctx.suppressAssistantAudioRef.current) {
      return;
    }
    ctx.assistantTextRef.current += payload.delta;
    ctx.setAssistantText(ctx.assistantTextRef.current.trim());
    return;
  }
  if ((payload.type === 'response.audio.delta' || payload.type === 'response.output_audio.delta') && payload.delta) {
    if (ctx.suppressAssistantAudioRef.current) {
      return;
    }
    ctx.awaitingResponseRef.current = true;
    ctx.setMode('speaking');
    ctx.playAudioDelta(payload.delta);
    return;
  }
  if (
    payload.type === 'response.done' &&
    ctx.stateRef.current !== 'summarizing' &&
    ctx.stateRef.current !== 'handoff' &&
    ctx.playbackSourcesRef.current.size === 0
  ) {
    ctx.suppressAssistantAudioRef.current = false;
    ctx.awaitingResponseRef.current = false;
    ctx.setMode('listening');
  }
}
