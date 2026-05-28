import {
  activityStepFromPayload,
  briefActivityLabel,
  isGenericActivityLabel,
  statusMessageId
} from './app-activity-labels.js';
import { payloadRunKeys } from './app-core-utils.js';

export function mergeActivityStep(currentSteps, step) {
  if (!step) {
    return currentSteps || [];
  }
  const steps = [...(currentSteps || [])];
  const existingIndex = steps.findIndex((item) => item.id === step.id);
  if (existingIndex >= 0) {
    steps[existingIndex] = { ...steps[existingIndex], ...step };
    return steps.slice(-8);
  }
  const sameWorkIndex = steps.findIndex(
    (item) =>
      item.kind === step.kind &&
      item.label === step.label &&
      (item.command || '') === (step.command || '')
  );
  if (sameWorkIndex >= 0) {
    steps[sameWorkIndex] = { ...steps[sameWorkIndex], ...step };
    return steps.slice(-8);
  }
  const last = steps[steps.length - 1];
  if (last && last.label === step.label && last.detail === step.detail && last.status === step.status) {
    return steps;
  }
  return [...steps, step].slice(-8);
}

export function isVisibleActivityStep(step, messageStatus) {
  if (!step) {
    return false;
  }
  const label = String(step.label || '').trim();
  if (isGenericActivityLabel(label)) {
    return false;
  }
  if (
    ['reasoning', 'message', 'agent_message'].includes(step.kind) &&
    /^(正在思考中?|正在处理|正在回复|正在整理回复)$/.test(label)
  ) {
    return false;
  }
  if (messageStatus !== 'failed' && step.kind === 'command_execution' && step.status === 'failed') {
    return false;
  }
  if (messageStatus !== 'failed' && /blocked by policy|rejected/i.test(`${step.detail || ''}\n${step.output || ''}\n${step.error || ''}`)) {
    return false;
  }
  return true;
}

export function upsertStatusMessage(current, payload) {
  const id = statusMessageId(payload);
  const existingIndex = current.findIndex((message) => message.id === id);
  const previous = existingIndex >= 0 ? current[existingIndex] : null;
  const normalizedPayload =
    payload.kind === 'agent_message'
      ? { ...payload, label: briefActivityLabel(payload.label || payload.content) }
      : payload;
  const detail =
    normalizedPayload.kind === 'reasoning'
      ? previous?.detail || ''
      : normalizedPayload.detail || previous?.detail || '';
  const status = normalizedPayload.status || previous?.status || 'running';
  const isTerminalStatus = ['aborted', 'completed', 'failed'].includes(status);
  const kind = normalizedPayload.kind || (isTerminalStatus ? 'turn' : previous?.kind || 'turn');
  const isTurnLevel = kind === 'turn' || kind === 'error';
  const nextMessage = {
    id,
    role: 'activity',
    turnId: normalizedPayload.turnId || previous?.turnId || null,
    sessionId: normalizedPayload.sessionId || previous?.sessionId || null,
    content: isTurnLevel ? (normalizedPayload.label || previous?.content || '正在处理') : (previous?.content || '正在处理'),
    label: isTurnLevel ? (normalizedPayload.label || previous?.label || '正在处理') : (previous?.label || '正在处理'),
    detail,
    kind,
    status: isTurnLevel ? status : (previous?.status || 'running'),
    timestamp: normalizedPayload.timestamp || previous?.timestamp || new Date().toISOString(),
    activities: mergeActivityStep(previous?.activities || [], activityStepFromPayload(normalizedPayload))
  };

  if (existingIndex >= 0) {
    const next = [...current];
    next[existingIndex] = nextMessage;
    return next;
  }
  return [...current, nextMessage];
}

export function upsertActivityMessage(current, payload) {
  const id = statusMessageId(payload);
  const existingIndex = current.findIndex((message) => message.id === id);
  const previous = existingIndex >= 0 ? current[existingIndex] : null;
  const isTurnLevel = payload.kind === 'turn' || payload.kind === 'error';
  const activity = activityStepFromPayload(payload, 'activity');
  if (!activity && !previous) {
    return current;
  }
  const activities = activity
    ? mergeActivityStep(previous?.activities || [], activity)
    : previous?.activities || [];

  const nextMessage = {
    id,
    role: 'activity',
    turnId: payload.turnId || previous?.turnId || null,
    sessionId: payload.sessionId || previous?.sessionId || null,
    content: previous?.content || '正在处理',
    label: previous?.label || '正在处理',
    detail: payload.detail || previous?.detail || activity?.detail || '',
    kind: payload.kind || previous?.kind || 'activity',
    status: isTurnLevel ? (payload.status || previous?.status || 'running') : (previous?.status || 'running'),
    timestamp: previous?.timestamp || payload.timestamp || new Date().toISOString(),
    activities
  };

  if (existingIndex >= 0) {
    const next = [...current];
    next[existingIndex] = nextMessage;
    return next;
  }
  return [...current, nextMessage];
}

export function completeStatusMessage(current, payload) {
  const id = statusMessageId(payload);
  return current.filter((message) => message.id !== id);
}

export function hasAssistantMessageForTurn(messages, payload) {
  return messages.some(
    (message) =>
      message.role === 'assistant' &&
      payload?.turnId &&
      message.turnId === payload.turnId &&
      typeof message.content === 'string' &&
      message.content.trim()
  );
}

export function removeActivityMessagesForTurn(messages, payload) {
  const keys = new Set(payloadRunKeys(payload));
  if (!keys.size) {
    return messages;
  }
  return messages.filter((message) => {
    if (message.role !== 'activity') {
      return true;
    }
    return !payloadRunKeys(message).some((key) => keys.has(key));
  });
}

function normalizedContent(message) {
  return String(message?.content || '').trim();
}

function contentKey(message) {
  return `${message?.role || ''}\n${normalizedContent(message)}`;
}

function countServerContent(messages) {
  const counts = new Map();
  for (const message of messages) {
    const key = contentKey(message);
    if (!normalizedContent(message)) {
      continue;
    }
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return counts;
}

function isPendingLocalMessage(message) {
  return (
    message?.role === 'activity' ||
    message?.preview ||
    String(message?.id || '').startsWith('local-')
  );
}

function countPendingLocalContent(messages) {
  const counts = new Map();
  for (const message of messages || []) {
    if (!isPendingLocalMessage(message) || !normalizedContent(message)) {
      continue;
    }
    const key = contentKey(message);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return counts;
}

function consumeContentMatch(counts, message) {
  const key = contentKey(message);
  const count = counts.get(key) || 0;
  if (!count) {
    return false;
  }
  if (count === 1) {
    counts.delete(key);
  } else {
    counts.set(key, count - 1);
  }
  return true;
}

function turnScopedRunKeys(payload) {
  return [payload?.turnId, payload?.previousSessionId].filter(Boolean);
}

export function mergeServerMessagesWithLocalState(current, serverMessages, options = {}) {
  const next = Array.isArray(serverMessages) ? [...serverMessages] : [];
  const activeKeys = new Set((options.activeRuns || []).flatMap((run) => payloadRunKeys(run)));
  const serverIds = new Set(next.map((message) => message.id).filter(Boolean));
  const serverKeysByRole = new Map();
  for (const message of next) {
    for (const key of turnScopedRunKeys(message)) {
      const role = message.role || '';
      const roleKeys = serverKeysByRole.get(role) || new Set();
      roleKeys.add(key);
      serverKeysByRole.set(role, roleKeys);
    }
  }
  const serverContentCounts = countServerContent(next);
  const pendingLocalContentCounts = countPendingLocalContent(current);
  const shouldPreserveLocalRun = (message) => {
    if (options.preserveLocalRuns) {
      return true;
    }
    const keys = message.turnId ? [message.turnId] : payloadRunKeys(message);
    return keys.some((key) => activeKeys.has(key));
  };
  const serverHasRoleKey = (message) => {
    const roleKeys = serverKeysByRole.get(message.role || '');
    const keys = turnScopedRunKeys(message);
    return Boolean(keys.length && keys.some((key) => roleKeys?.has(key)));
  };
  const serverHasAssistantForRun = (message) => {
    const roleKeys = serverKeysByRole.get('assistant');
    const keys = turnScopedRunKeys(message);
    return Boolean(keys.length && keys.some((key) => roleKeys?.has(key)));
  };
  const hasServerMessageForLocal = (message) => {
    if (serverIds.has(message.id)) {
      return true;
    }
    if (message.role === 'activity' || message.preview) {
      return serverHasAssistantForRun(message);
    }
    if (serverHasRoleKey(message)) {
      return true;
    }
    if ((pendingLocalContentCounts.get(contentKey(message)) || 0) > 1) {
      return false;
    }
    return consumeContentMatch(serverContentCounts, message);
  };
  for (const message of current || []) {
    if (message.transient) {
      continue;
    }
    if (!isPendingLocalMessage(message)) {
      continue;
    }
    if (!shouldPreserveLocalRun(message)) {
      continue;
    }
    if (hasServerMessageForLocal(message)) {
      continue;
    }
    next.push(message);
  }
  return next;
}

export function upsertAssistantMessage(current, payload) {
  const content = String(payload.content || '').trim();
  if (!content) {
    return current;
  }
  const id = payload.messageId || `assistant-${payload.turnId || Date.now()}`;
  const isPreview = Boolean(payload.preview);
  const nextMessage = {
    id,
    role: 'assistant',
    content,
    timestamp: new Date().toISOString(),
    turnId: payload.turnId || null,
    sessionId: payload.sessionId || null,
    kind: payload.kind,
    preview: isPreview || undefined
  };
  const withoutActivity = removeActivityMessagesForTurn(current, payload);
  const withoutStalePreview =
    !isPreview && payload.turnId
      ? withoutActivity.filter(
        (message) => !(message.role === 'assistant' && message.preview && message.turnId === payload.turnId)
      )
      : withoutActivity;
  const existingIndex = withoutStalePreview.findIndex((message) => message.id === id);
  if (existingIndex >= 0) {
    const next = [...withoutStalePreview];
    next[existingIndex] = nextMessage;
    return next;
  }
  return [...withoutStalePreview, nextMessage];
}
