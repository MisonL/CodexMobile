import {
  compactStatusLabel,
  contentFromItem,
  detailFromItem,
  emitStatus,
  eventItem,
  eventStatus,
  statusLabel
} from './codex-runner-event-format.js';

const ACTIVITY_KINDS = new Set([
  'command_execution',
  'file_change',
  'mcp_tool_call',
  'web_search',
  'todo_list',
  'image_generation_call',
  'custom_tool_call',
  'function_call',
  'function_call_output',
  'exec_command_begin',
  'exec_command_end'
]);

export { emitStatus };

export function isNonFatalCodexItemError(message) {
  return /^Under-development features enabled:/i.test(String(message || '').trim());
}

function emitActivity(emit, { sessionId, turnId, messageId, item, kind, status }) {
  const detail = detailFromItem(item);
  emit({
    type: 'activity-update',
    sessionId,
    turnId,
    messageId,
    kind,
    label: statusLabel(kind, status),
    status,
    detail,
    command: item?.command || '',
    output: item?.aggregated_output || item?.output || '',
    fileChanges: Array.isArray(item?.changes) ? item.changes : [],
    toolName: item?.tool || item?.name || '',
    error: item?.error?.message || item?.message || '',
    timestamp: new Date().toISOString()
  });
}

function emitThreadEvent(event, sessionId, turnId, emit, state) {
  const threadId = event.thread_id || event.id || event.payload?.id;
  if (event.type === 'thread.started' && threadId) {
    emit({ type: 'thread-started', sessionId: threadId, turnId });
    return true;
  }

  if (event.type === 'turn.started' || event.payload?.type === 'task_started') {
    emitStatus(emit, { sessionId, turnId, kind: 'reasoning', status: 'running', label: '正在思考' });
    return true;
  }

  if (event.type === 'turn.completed') {
    state.usage = event.usage || null;
    emitStatus(emit, { sessionId, turnId, kind: 'turn', status: 'completed', label: '任务已完成' });
    emit({ type: 'turn-complete', sessionId, turnId, usage: event.usage || null });
    return true;
  }

  if (event.type === 'turn.failed') {
    const error = event.error?.message || event.error || 'Codex turn failed';
    state.failed = true;
    emitStatus(emit, { sessionId, turnId, kind: 'turn', status: 'failed', label: '任务失败', detail: error });
    emit({ type: 'turn-failed', sessionId, turnId, error });
    emit({ type: 'chat-error', sessionId, turnId, error });
    console.error('[codex] Turn failed:', error);
    return true;
  }

  if (event.type === 'error') {
    const error = event.message || 'Codex stream error';
    emitStatus(emit, { sessionId, turnId, kind: 'error', status: 'failed', detail: error });
    emit({ type: 'chat-error', sessionId, turnId, error });
    console.error('[codex] Stream error:', error);
    return true;
  }

  return false;
}

function emitAssistantItem({ item, kind, status, done, messageId, sessionId, turnId, emit, state }) {
  if (kind === 'agent_message') {
    const content = contentFromItem(item);
    if (!content.trim()) {
      return true;
    }
    state.hadAssistantText = true;
    emitStatus(emit, {
      sessionId,
      turnId,
      kind,
      status: 'running',
      label: compactStatusLabel(content)
    });
    emit({
      type: 'assistant-update',
      sessionId,
      turnId,
      messageId,
      role: 'assistant',
      kind,
      phase: item.phase || 'final_answer',
      content,
      done: done || status === 'completed'
    });
    return true;
  }

  if (item.phase === 'commentary') {
    const content = contentFromItem(item);
    if (content.trim()) {
      emitStatus(emit, {
        sessionId,
        turnId,
        kind: kind === 'message' ? 'agent_message' : kind,
        status: 'running',
        label: compactStatusLabel(content)
      });
    }
    return true;
  }

  if (kind !== 'message' || item.role !== 'assistant') {
    return false;
  }

  const content = contentFromItem(item);
  if (!content.trim()) {
    return true;
  }
  state.hadAssistantText = true;
  emitStatus(emit, { sessionId, turnId, kind, status: 'running', label: '正在回复' });
  emit({
    type: 'assistant-update',
    sessionId,
    turnId,
    messageId,
    role: 'assistant',
    kind,
    phase: item.phase || 'final_answer',
    content,
    done: done || status === 'completed'
  });
  return true;
}

function emitErrorItem({ item, messageId, sessionId, turnId, emit }) {
  const error = item.message || 'Codex item error';
  if (isNonFatalCodexItemError(error)) {
    emitActivity(emit, { sessionId, turnId, messageId, item, kind: 'error', status: 'completed' });
    console.warn('[codex] Non-fatal item warning:', error);
    return;
  }

  emitStatus(emit, { sessionId, turnId, kind: 'error', status: 'failed', detail: error });
  emit({ type: 'chat-error', sessionId, turnId, error });
  console.error('[codex] Item error:', error);
}

function emitActivityItem({ item, kind, status, messageId, sessionId, turnId, emit }) {
  const normalizedKind =
    kind === 'exec_command_begin' || kind === 'exec_command_end' ? 'command_execution' : kind;
  const normalizedStatus = kind === 'function_call_output' ? 'completed' : status;
  emitStatus(emit, {
    sessionId,
    turnId,
    kind: normalizedKind,
    status: normalizedStatus,
    detail: detailFromItem(item)
  });
  emitActivity(emit, {
    sessionId,
    turnId,
    messageId,
    item,
    kind: normalizedKind,
    status: normalizedStatus
  });
}

export function emitCodexEvent(event, sessionId, turnId, emit, state) {
  if (emitThreadEvent(event, sessionId, turnId, emit, state)) {
    return;
  }

  const item = eventItem(event);
  if (!item) {
    return;
  }

  const done = event.type === 'item.completed';
  const kind = item.type || 'item';
  const status = eventStatus(event, item);
  const messageId = item.id || `${turnId}-${kind}`;

  if (emitAssistantItem({ item, kind, status, done, messageId, sessionId, turnId, emit, state })) {
    return;
  }

  if (kind === 'reasoning') {
    emitStatus(emit, { sessionId, turnId, kind, status, label: statusLabel(kind, status) });
    return;
  }

  if (kind === 'error') {
    emitErrorItem({ item, messageId, sessionId, turnId, emit });
    return;
  }

  if (ACTIVITY_KINDS.has(kind)) {
    emitActivityItem({ item, kind, status, messageId, sessionId, turnId, emit });
    return;
  }

  const detail = detailFromItem(item);
  if (detail) {
    emitStatus(emit, { sessionId, turnId, kind, status, detail });
  }
}
