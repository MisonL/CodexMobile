import { Headphones, Loader2, Mic, Volume2, X } from 'lucide-react';
import { voiceDialogStatusLabel } from '../app-voice-utils.js';

export function VoiceDialogPanel({
  open,
  state,
  error,
  transcript,
  assistantText,
  handoffDraft,
  onHandoffDraftChange,
  onHandoffSubmit,
  onHandoffContinue,
  onHandoffCancel,
  onStart,
  onStop,
  onClose
}) {
  if (!open) {
    return null;
  }

  const listening = state === 'listening';
  const confirmingHandoff = state === 'handoff';
  const busy = ['transcribing', 'sending', 'waiting', 'speaking', 'summarizing'].includes(state);
  const statusIcon = state === 'speaking'
    ? <Volume2 size={28} />
    : busy
      ? <Loader2 className="spin" size={28} />
      : <Mic size={28} />;

  return (
    <div className="voice-dialog-backdrop">
      <section className="voice-dialog-panel" role="dialog" aria-modal="true" aria-label="语音对话">
        <div className="voice-dialog-header">
          <span>
            <Headphones size={17} />
            语音对话
          </span>
          <button type="button" onClick={onClose} aria-label="关闭语音对话">
            <X size={18} />
          </button>
        </div>
        <div className={`voice-dialog-orb is-${state}`}>
          {statusIcon}
        </div>
        <div className={`voice-dialog-status ${error ? 'is-error' : ''}`}>
          {error || voiceDialogStatusLabel(state)}
        </div>
        {transcript ? <p className="voice-dialog-line is-user">{transcript}</p> : null}
        {assistantText ? <p className="voice-dialog-line is-assistant">{assistantText}</p> : null}
        {confirmingHandoff ? (
          <div className="voice-dialog-handoff">
            <textarea
              value={handoffDraft}
              onChange={(event) => onHandoffDraftChange(event.target.value)}
              rows={8}
              aria-label="交给 Codex 的任务"
            />
            <div className="voice-dialog-actions voice-dialog-handoff-actions">
              <button type="button" className="voice-dialog-secondary" onClick={onHandoffContinue}>
                继续补充
              </button>
              <button type="button" className="voice-dialog-secondary" onClick={onHandoffCancel}>
                取消
              </button>
              <button
                type="button"
                className="voice-dialog-primary"
                onClick={onHandoffSubmit}
                disabled={!String(handoffDraft || '').trim()}
              >
                交给 Codex
              </button>
            </div>
          </div>
        ) : (
          <div className="voice-dialog-actions">
          <button
            type="button"
            className={`voice-dialog-primary ${listening ? 'is-listening' : ''}`}
            onClick={listening ? onStop : onStart}
            disabled={busy}
          >
            {listening ? '停止' : '开始'}
          </button>
          <button type="button" className="voice-dialog-secondary" onClick={onClose}>
            结束
          </button>
          </div>
        )}
      </section>
    </div>
  );
}
