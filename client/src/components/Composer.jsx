import { useEffect, useRef, useState } from 'react';
import { ArrowUp, Check, ChevronDown, FileText, Headphones, Image, Loader2, Mic, Paperclip, Plus, Square, Trash2 } from 'lucide-react';
import { formatBytes, permissionLabel, PERMISSION_OPTIONS, REASONING_OPTIONS, reasoningLabel, shortModelName } from '../app-core-utils.js';
import { useVoiceInputRecorder } from './useVoiceInputRecorder.js';

export function Composer({
  input,
  setInput,
  onSubmit,
  running,
  onAbort,
  models,
  selectedModel,
  onSelectModel,
  selectedReasoningEffort,
  onSelectReasoningEffort,
  permissionMode,
  onSelectPermission,
  attachments,
  onUploadFiles,
  onRemoveAttachment,
  onRateLimit,
  uploading,
  onVoiceSubmit,
  onOpenVoiceDialog,
  voiceDialogActive,
  disabled,
  disabledReason,
  actionDisabledReasons = {},
  backgroundInert = false
}) {
  const textareaRef = useRef(null);
  const imageInputRef = useRef(null);
  const fileInputRef = useRef(null);
  const [openMenu, setOpenMenu] = useState(null);
  const hasInput = input.trim().length > 0 || attachments.length > 0;
  const modelList = models?.length ? models : [{ value: selectedModel || 'gpt-5.5', label: selectedModel || 'gpt-5.5' }];
  const selectedModelLabel = modelList.find((model) => model.value === selectedModel)?.label || selectedModel || 'gpt-5.5';
  const {
    voiceState,
    voiceError,
    voiceRecording,
    voiceTranscribing,
    voiceSending,
    toggleVoiceInput
  } = useVoiceInputRecorder({
    onVoiceSubmit,
    onRateLimit,
    onBeforeStart: () => setOpenMenu(null)
  });
  const uploadDisabledReason = actionDisabledReasons.upload || disabledReason;
  const sendDisabledReason = actionDisabledReasons.send || disabledReason;
  const voiceDisabledReason = actionDisabledReasons.voice || disabledReason;
  const voiceDialogDisabledReason = actionDisabledReasons.voiceDialog || disabledReason;
  const inertProps = backgroundInert ? { inert: '' } : {};
  const stopOnly = running && !hasInput;
  const sendButtonDisabled = uploading || (stopOnly ? false : Boolean(sendDisabledReason) || !hasInput);
  const actionNotice = [
    sendDisabledReason && `发送：${sendDisabledReason}`,
    uploadDisabledReason && `上传：${uploadDisabledReason}`,
    voiceDisabledReason && `语音：${voiceDisabledReason}`,
    voiceDialogDisabledReason && `对话：${voiceDialogDisabledReason}`
  ].filter(Boolean)[0] || '';

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) {
      return;
    }
    textarea.style.height = '0px';
    textarea.style.height = `${Math.min(textarea.scrollHeight, 132)}px`;
  }, [input]);


  const submit = (event) => {
    event.preventDefault();
    submitMessage();
  };

  const submitMessage = () => {
    if (running && !hasInput) {
      onAbort();
      return;
    }
    if (sendButtonDisabled) {
      return;
    }
    onSubmit();
    setOpenMenu(null);
  };

  const handleKeyDown = (event) => {
    const composing = event.isComposing || event.nativeEvent?.isComposing;
    const modified = event.shiftKey || event.altKey || event.metaKey || event.ctrlKey;
    if (event.key !== 'Enter' || modified || composing) {
      return;
    }
    event.preventDefault();
    submitMessage();
  };

  function toggleMenu(name) {
    setOpenMenu((current) => (current === name ? null : name));
  }

  function handleFiles(event, kind) {
    const files = Array.from(event.target.files || []);
    if (files.length) {
      onUploadFiles(files, kind);
    }
    event.target.value = '';
    setOpenMenu(null);
  }

  return (
    <form className="composer-wrap" onSubmit={submit} {...inertProps}>
      <input
        ref={imageInputRef}
        className="file-input"
        type="file"
        accept="image/*"
        multiple
        onChange={(event) => handleFiles(event, 'image')}
      />
      <input
        ref={fileInputRef}
        className="file-input"
        type="file"
        multiple
        onChange={(event) => handleFiles(event, 'file')}
      />
      {openMenu === 'attach' ? (
        <div className="composer-menu attach-menu">
          <button type="button" onClick={() => imageInputRef.current?.click()} disabled={Boolean(uploadDisabledReason)}>
            <Image size={17} />
            相册
          </button>
          <button type="button" onClick={() => fileInputRef.current?.click()} disabled={Boolean(uploadDisabledReason)}>
            <FileText size={17} />
            文件
          </button>
        </div>
      ) : null}
      {openMenu === 'permission' ? (
        <div className="composer-menu permission-menu">
          {PERMISSION_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              className={`${permissionMode === option.value ? 'is-selected' : ''} ${option.danger ? 'is-danger' : ''}`}
              onClick={() => {
                onSelectPermission(option.value);
                setOpenMenu(null);
              }}
            >
              {permissionMode === option.value ? <Check size={16} /> : <span className="menu-spacer" />}
              {option.label}
            </button>
          ))}
        </div>
      ) : null}
      {openMenu === 'model' ? (
        <div className="composer-menu model-menu">
          <div className="menu-section-label">智能</div>
          {REASONING_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              className={selectedReasoningEffort === option.value ? 'is-selected' : ''}
              onClick={() => {
                onSelectReasoningEffort(option.value);
                setOpenMenu(null);
              }}
            >
              {selectedReasoningEffort === option.value ? <Check size={16} /> : <span className="menu-spacer" />}
              <span>{option.label}</span>
            </button>
          ))}
          <div className="menu-divider" />
          <div className="menu-section-label">模型</div>
          {modelList.map((model) => (
            <button
              key={model.value}
              type="button"
              className={selectedModel === model.value ? 'is-selected' : ''}
              onClick={() => {
                onSelectModel(model.value);
                setOpenMenu(null);
              }}
            >
              {selectedModel === model.value ? <Check size={16} /> : <span className="menu-spacer" />}
              <span>{model.label}</span>
            </button>
          ))}
        </div>
      ) : null}
      {voiceState !== 'idle' || voiceError ? (
        <div className={`voice-popover ${voiceError ? 'is-error' : ''}`}>
          <Mic size={14} />
          <span>{voiceError || (voiceSending ? '正在发送...' : voiceTranscribing ? '正在转写...' : '正在录音...')}</span>
        </div>
      ) : null}
      {actionNotice ? (
        <div className="composer-notice" role="status" aria-live="polite">
          {actionNotice}
        </div>
      ) : null}
      <div className="composer">
        {attachments.length ? (
          <div className="attachment-tray">
            {attachments.map((attachment) => (
              <span key={attachment.id} className="attachment-chip">
                <Paperclip size={14} />
                <span>{attachment.name}</span>
                <small>{formatBytes(attachment.size)}</small>
                <button type="button" onClick={() => onRemoveAttachment(attachment.id)} aria-label="移除附件">
                  <Trash2 size={13} />
                </button>
              </span>
            ))}
          </div>
        ) : null}
        <textarea
          ref={textareaRef}
          rows={1}
          value={input}
          onChange={(event) => setInput(event.target.value)}
          name="message"
          autoComplete="off"
          aria-label="消息"
          placeholder={disabledReason || '给 Codex 发送消息...'}
          disabled={disabled}
          onKeyDown={handleKeyDown}
        />
        <div className="composer-controls">
          <div className="control-left">
            <button
              type="button"
              className="ghost-icon"
              aria-label="添加"
              onClick={() => toggleMenu('attach')}
              disabled={uploading || Boolean(uploadDisabledReason)}
              title={uploadDisabledReason || undefined}
            >
              <Plus size={21} />
            </button>
            <button type="button" className="permission-pill" onClick={() => toggleMenu('permission')}>
              {permissionLabel(permissionMode)}
              <ChevronDown size={15} />
            </button>
          </div>
          <div className="control-right">
            <button type="button" className="model-select" onClick={() => toggleMenu('model')}>
              {shortModelName(selectedModelLabel)} {reasoningLabel(selectedReasoningEffort)}
              <ChevronDown size={15} />
            </button>
            <button
              type="button"
              className={`dialog-button ${voiceDialogActive ? 'is-active' : ''}`}
              onClick={onOpenVoiceDialog}
              disabled={Boolean(voiceDialogDisabledReason)}
              title={voiceDialogDisabledReason || undefined}
              aria-label="语音对话"
            >
              <Headphones size={16} />
              <span>对话</span>
            </button>
            <button
              type="button"
              className={`voice-button ${voiceRecording ? 'is-recording' : ''} ${voiceTranscribing ? 'is-transcribing' : ''} ${voiceSending ? 'is-sending' : ''}`}
              onClick={toggleVoiceInput}
              disabled={voiceTranscribing || voiceSending || Boolean(voiceDisabledReason)}
              title={voiceDisabledReason || undefined}
              aria-label={voiceRecording ? '停止语音输入' : voiceSending ? '正在发送语音' : '开始语音输入'}
            >
              {voiceTranscribing || voiceSending ? <Loader2 className="spin" size={16} /> : <Mic size={17} />}
            </button>
            <button
              type="submit"
              className={`send-button ${running ? 'is-running' : ''}`}
              disabled={sendButtonDisabled}
              title={sendDisabledReason || undefined}
              aria-label={running && !hasInput ? '停止生成' : uploading ? '正在上传' : '发送消息'}
            >
              {running && !hasInput ? <Square size={16} /> : uploading ? <Loader2 className="spin" size={16} /> : <ArrowUp size={19} />}
            </button>
          </div>
        </div>
      </div>
    </form>
  );
}
