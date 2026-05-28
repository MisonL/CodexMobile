import { remainingLockSeconds } from './api.js';

export function retryAfterLabel(lock, nowMs = Date.now()) {
  const seconds = remainingLockSeconds(lock, nowMs);
  return seconds > 0 ? `请求过快，请 ${seconds} 秒后再试` : '';
}

export const DEFAULT_REASONING_EFFORT = 'xhigh';
export const REASONING_DEFAULT_VERSION = 'xhigh-v1';
export const THEME_KEY = 'codexmobile.theme';
export const VOICE_MAX_RECORDING_MS = 90 * 1000;
export const VOICE_MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
export const VOICE_MIME_CANDIDATES = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm'];
export const VOICE_DIALOG_SILENCE_MS = 900;
export const VOICE_DIALOG_MIN_RECORDING_MS = 600;
export const VOICE_DIALOG_LEVEL_THRESHOLD = 0.018;
export const VOICE_DIALOG_SILENCE_AUDIO =
  'data:audio/wav;base64,UklGRiYAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQIAAAAAAA==';
export const REALTIME_VOICE_SAMPLE_RATE = 24000;
export const REALTIME_VOICE_BUFFER_SIZE = 2048;
export const REALTIME_VOICE_MIN_TURN_MS = 500;
export const REALTIME_VOICE_BARGE_IN_LEVEL_THRESHOLD = 0.026;
export const REALTIME_VOICE_BARGE_IN_SUSTAIN_MS = 180;

export async function copyTextToClipboard(text) {
  const value = String(text || '');
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {
    // Fall back below for browsers that block Clipboard API in PWA/http contexts.
  }

  const textarea = document.createElement('textarea');
  textarea.value = value;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.top = '-1000px';
  textarea.style.left = '-1000px';
  document.body.appendChild(textarea);
  textarea.select();
  textarea.setSelectionRange(0, textarea.value.length);
  try {
    return document.execCommand('copy');
  } finally {
    document.body.removeChild(textarea);
  }
}

export const PERMISSION_OPTIONS = [
  { value: 'default', label: '默认权限' },
  { value: 'acceptEdits', label: '自动接受编辑' },
  { value: 'bypassPermissions', label: '完全访问', danger: true }
];

export const REASONING_OPTIONS = [
  { value: 'low', label: '低' },
  { value: 'medium', label: '中' },
  { value: 'high', label: '高' },
  { value: 'xhigh', label: '超高' }
];

export function formatTime(value) {
  if (!value) {
    return '';
  }
  try {
    return new Intl.DateTimeFormat('zh-CN', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit'
    }).format(new Date(value));
  } catch {
    return '';
  }
}

export function compactPath(value) {
  if (!value) {
    return '';
  }
  const normalized = value.replaceAll('\\', '/');
  const parts = normalized.split('/').filter(Boolean);
  return parts.length > 2 ? `${parts.at(-2)}/${parts.at(-1)}` : normalized;
}

export function formatBytes(value) {
  const size = Number(value) || 0;
  if (size < 1024) {
    return `${size} B`;
  }
  if (size < 1024 * 1024) {
    return `${Math.round(size / 102.4) / 10} KB`;
  }
  return `${Math.round(size / 1024 / 102.4) / 10} MB`;
}

export function shortModelName(model) {
  if (!model) {
    return '5.5';
  }
  return model
    .replace(/^gpt-/i, '')
    .replace(/-codex.*$/i, '')
    .replace(/-mini$/i, ' mini');
}

export function permissionLabel(value) {
  return PERMISSION_OPTIONS.find((option) => option.value === value)?.label || '默认权限';
}

export function reasoningLabel(value) {
  return REASONING_OPTIONS.find((option) => option.value === value)?.label || '超高';
}

export function imageUrlWithRetry(url, retryKey) {
  if (!retryKey) {
    return url;
  }
  const separator = url.includes('?') ? '&' : '?';
  return `${url}${separator}r=${retryKey}`;
}

export function createClientTurnId() {
  return globalThis.crypto?.randomUUID?.() || `turn-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function createDraftSession(project) {
  const now = new Date().toISOString();
  return {
    id: `draft-${project.id}-${Date.now()}`,
    projectId: project.id,
    title: '新对话',
    summary: '等待第一条消息',
    messageCount: 0,
    updatedAt: now,
    draft: true
  };
}

export function isDraftSession(session) {
  const id = typeof session === 'string' ? session : session?.id;
  return Boolean(session?.draft || id?.startsWith('draft-'));
}

export function titleFromFirstMessage(message) {
  const value = String(message || '').trim().replace(/\s+/g, ' ');
  return value ? value.slice(0, 52) : '新对话';
}

export function payloadRunKeys(payload) {
  return [payload?.turnId, payload?.sessionId, payload?.previousSessionId].filter(Boolean);
}

export function selectedRunKeys(session) {
  return [session?.id, session?.turnId].filter(Boolean);
}

export function hasRunningKey(runningById, keys) {
  return keys.some((key) => Boolean(runningById[key]));
}

export function hasVisibleAssistantForTurn(messages, payload) {
  const hasExactMatch = messages.some(
    (message) =>
      message.role === 'assistant' &&
      ((payload?.messageId && message.id === payload.messageId) ||
        (payload?.turnId && message.turnId === payload.turnId)) &&
      typeof message.content === 'string' &&
      message.content.trim()
  );
  if (hasExactMatch) {
    return true;
  }
  if (payload?.turnId || payload?.messageId) {
    return false;
  }

  const latestUserIndex = messages.reduce(
    (latest, message, index) => (message.role === 'user' ? index : latest),
    -1
  );
  return messages.some(
    (message, index) =>
      message.role === 'assistant' &&
      index > latestUserIndex &&
      typeof message.content === 'string' &&
      message.content.trim()
  );
}

export function hasLatestAssistantAfterLatestUser(messages) {
  const latestUserIndex = messages.reduce(
    (latest, message, index) => (message.role === 'user' ? index : latest),
    -1
  );
  return messages.some(
    (message, index) =>
      message.role === 'assistant' &&
      index > latestUserIndex &&
      typeof message.content === 'string' &&
      message.content.trim()
  );
}

export function hasAssistantResultForTurn(messages, payload) {
  if (hasVisibleAssistantForTurn(messages, payload)) {
    return true;
  }
  if (payload?.messageId) {
    return false;
  }
  if (payload?.turnId && !payload?.allowLatestAssistantFallback) {
    return false;
  }
  if (!payload?.hadAssistantText && payload?.status !== 'completed') {
    return false;
  }
  return hasLatestAssistantAfterLatestUser(messages);
}

export function upsertSessionInProject(current, projectId, session, replaceId = null) {
  if (!projectId || !session) {
    return current;
  }
  const existing = current[projectId] || [];
  const filtered = existing.filter((item) => item.id !== session.id && (!replaceId || item.id !== replaceId));
  return {
    ...current,
    [projectId]: [session, ...filtered]
  };
}
