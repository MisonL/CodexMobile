const TOKEN_KEY = 'codexmobile.deviceToken';

const ERROR_MESSAGES = {
  pairing_required: '需要重新配对这台 Mac。',
  mac_offline: 'Mac 连接器未在线。',
  mac_local_offline: 'Mac 本地 CodexMobile 服务未启动。',
  relay_request_timeout: '中转请求超时。',
  mac_reconnected: 'Mac 连接已刷新，请重试。',
  relay_body_too_large: '当前中转模式不支持这么大的内容。',
  relay_streaming_required: '此能力需要本地直连或后续流式中转支持。',
  relay_realtime_unsupported: '实时语音中转不可用。',
  relay_realtime_http_upgrade_required: '实时语音需要 WebSocket 连接。',
  relay_rate_limited: '请求过快，请稍后再试。',
  relay_unsupported: '此回调路径暂不支持中转模式。'
};

export class ApiError extends Error {
  constructor(message, { status = 0, code = '', retryAfter = 0, reason = '' } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
    this.reason = reason;
  }
}

export function rateLimitLockFromError(error, scope, nowMs = Date.now()) {
  if (!error || error.code !== 'relay_rate_limited' || !Number(error.retryAfter)) {
    return null;
  }
  const retryAfter = Math.max(0, Math.ceil(Number(error.retryAfter)));
  return {
    scope,
    retryAfter,
    untilMs: nowMs + retryAfter * 1000
  };
}

export function remainingLockSeconds(lock, nowMs = Date.now()) {
  if (!lock?.untilMs) {
    return 0;
  }
  return Math.max(0, Math.ceil((lock.untilMs - nowMs) / 1000));
}

function errorMessageFor(data, fallback) {
  const code = String(data?.error || '');
  return ERROR_MESSAGES[code] || code || fallback;
}

export function getToken() {
  return localStorage.getItem(TOKEN_KEY) || '';
}

export function setToken(token) {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken() {
  localStorage.removeItem(TOKEN_KEY);
}

export async function apiFetch(path, options = {}) {
  const token = getToken();
  const headers = {
    ...(options.body instanceof FormData ? {} : { 'content-type': 'application/json' }),
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    ...(options.headers || {})
  };

  const response = await fetch(path, {
    ...options,
    headers,
    body:
      options.body && !(options.body instanceof FormData) && typeof options.body !== 'string'
        ? JSON.stringify(options.body)
        : options.body
  });

  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new ApiError(errorMessageFor(data, `Request failed: ${response.status}`), {
      status: response.status,
      code: data.error || '',
      retryAfter: Number(data.retryAfter || 0),
      reason: data.reason || ''
    });
  }
  return data;
}

export async function apiBlobFetch(path, options = {}) {
  const token = getToken();
  const headers = {
    ...(options.body instanceof FormData ? {} : { 'content-type': 'application/json' }),
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    ...(options.headers || {})
  };

  const response = await fetch(path, {
    ...options,
    headers,
    body:
      options.body && !(options.body instanceof FormData) && typeof options.body !== 'string'
        ? JSON.stringify(options.body)
        : options.body
  });

  if (!response.ok) {
    const text = await response.text();
    let message = `Request failed: ${response.status}`;
    let data = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      message = text || message;
    }
    throw new ApiError(errorMessageFor(data, message), {
      status: response.status,
      code: data.error || '',
      retryAfter: Number(data.retryAfter || 0),
      reason: data.reason || ''
    });
  }

  return response.blob();
}

export function websocketUrl() {
  const token = encodeURIComponent(getToken());
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}/ws?token=${token}`;
}

export function realtimeVoiceWebsocketUrl() {
  const token = encodeURIComponent(getToken());
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}/ws/realtime?token=${token}`;
}
