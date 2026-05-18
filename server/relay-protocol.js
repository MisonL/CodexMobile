import crypto from 'node:crypto';

export const RELAY_PROTOCOL_VERSION = 1;
export const DEFAULT_RELAY_REQUEST_TIMEOUT_MS = 120000;
export const DEFAULT_RELAY_HEARTBEAT_MS = 15000;
export const DEFAULT_RELAY_IDLE_HEARTBEAT_MS = 300000;
export const DEFAULT_RELAY_SMALL_BODY_LIMIT = 2 * 1024 * 1024;
export const DEFAULT_RELAY_STREAM_CHUNK_BYTES = 256 * 1024;
export const DEFAULT_RELAY_WS_BUFFERED_BYTES = 4 * 1024 * 1024;

const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'upgrade',
  'transfer-encoding',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer'
]);

const REQUEST_HEADER_ALLOWLIST = new Set([
  'authorization',
  'content-type',
  'accept',
  'user-agent'
]);

const RESPONSE_HEADER_ALLOWLIST = new Set([
  'content-type',
  'content-length',
  'cache-control'
]);

export function createRequestId() {
  return crypto.randomUUID();
}

export function createConnectorInstanceId() {
  return crypto.randomUUID();
}

export function isStrongRelaySecret(value) {
  return String(value || '').trim().length >= 32;
}

export function parsePositiveInt(value, fallback) {
  const next = Number(value);
  return Number.isFinite(next) && next > 0 ? Math.floor(next) : fallback;
}

export function safeJsonParse(value) {
  try {
    return value ? JSON.parse(value) : null;
  } catch {
    return null;
  }
}

export function jsonMessage(type, patch = {}) {
  return {
    type,
    protocolVersion: RELAY_PROTOCOL_VERSION,
    ...patch
  };
}

export function sendWsJson(ws, payload) {
  if (ws.readyState !== ws.OPEN) {
    return false;
  }
  ws.send(JSON.stringify(payload));
  return true;
}

export function safePathWithQuery(pathname, search = '') {
  const path = String(pathname || '/');
  if (!path.startsWith('/')) {
    return `/${path}`;
  }
  return `${path}${search || ''}`;
}

export function buildLocalTargetUrl(forwardPath, localBaseUrl) {
  const pathWithQuery = String(forwardPath || '/');
  if (!pathWithQuery.startsWith('/') || pathWithQuery.startsWith('//') || /[\x00-\x1f\x7f]/.test(pathWithQuery)) {
    throw Object.assign(new Error('relay_invalid_forward_path'), { status: 400 });
  }
  const base = new URL(localBaseUrl);
  const parsedPath = new URL(pathWithQuery, 'http://codexmobile.local');
  base.pathname = parsedPath.pathname;
  base.search = parsedPath.search;
  base.hash = '';
  return base.toString();
}

export function isRelayUnsupportedPath(pathname, contentType = '') {
  const path = String(pathname || '');
  if (path === '/ws/realtime') {
    return 'relay_realtime_unsupported';
  }
  if (path.startsWith('/generated/')) {
    return 'relay_streaming_required';
  }
  return '';
}

export function isRelayStreamingRequest(method, pathname, contentType = '') {
  const normalizedMethod = String(method || 'GET').toUpperCase();
  if (['GET', 'HEAD'].includes(normalizedMethod)) {
    return false;
  }
  const path = String(pathname || '');
  if (path === '/api/uploads' || path === '/api/voice/transcribe') {
    return true;
  }
  return /multipart\/form-data|audio\/|image\//i.test(String(contentType || ''));
}

export function filterRequestHeaders(headers = {}) {
  const next = {};
  for (const [key, value] of Object.entries(headers)) {
    const normalized = key.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(normalized)) {
      continue;
    }
    if (REQUEST_HEADER_ALLOWLIST.has(normalized) || normalized.startsWith('x-codexmobile-')) {
      next[normalized] = Array.isArray(value) ? value.join(', ') : String(value);
    }
  }
  return next;
}

export function filterResponseHeaders(headers = {}) {
  const next = {};
  const entries = typeof headers.entries === 'function' ? headers.entries() : Object.entries(headers);
  for (const [key, value] of entries) {
    const normalized = key.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(normalized) || normalized === 'set-cookie') {
      continue;
    }
    if (RESPONSE_HEADER_ALLOWLIST.has(normalized) || normalized.startsWith('x-codexmobile-')) {
      next[normalized] = Array.isArray(value) ? value.join(', ') : String(value);
    }
  }
  return next;
}

export function redactHeaders(headers = {}) {
  const next = {};
  for (const [key, value] of Object.entries(headers)) {
    const normalized = key.toLowerCase();
    if (
      normalized.includes('authorization') ||
      normalized.includes('cookie') ||
      normalized.includes('token') ||
      normalized.includes('secret') ||
      normalized.includes('key')
    ) {
      next[key] = '[redacted]';
    } else {
      next[key] = value;
    }
  }
  return next;
}

export function browserTokenFromHeaders(headers = {}) {
  const header = headers.authorization || headers.Authorization || '';
  if (String(header).toLowerCase().startsWith('bearer ')) {
    return String(header).slice(7).trim();
  }
  const fallback = headers['x-codexmobile-token'] || headers['X-Codexmobile-Token'];
  return typeof fallback === 'string' ? fallback.trim() : '';
}

export function bearerSecretFromRequest(req) {
  const header = req.headers.authorization || '';
  if (!String(header).toLowerCase().startsWith('bearer ')) {
    return '';
  }
  return String(header).slice(7).trim();
}

export function normalizeErrorCode(error, fallback = 'relay_error') {
  return String(error || fallback)
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, '_')
    .toLowerCase() || fallback;
}

export function logRelayEvent(event, fields = {}, level = 'log') {
  const payload = {
    event,
    ts: new Date().toISOString(),
    ...fields
  };
  const line = JSON.stringify(payload);
  if (level === 'warn') {
    console.warn(line);
    return;
  }
  if (level === 'error') {
    console.error(line);
    return;
  }
  console.log(line);
}
