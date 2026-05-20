import WebSocket from 'ws';

const DEFAULT_TIMEOUT_MS = 10000;

export async function requestJsonOrText(url, { timeoutMs, ...options } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs || DEFAULT_TIMEOUT_MS);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const text = await response.text();
    return { status: response.status, headers: response.headers, text, data: safeJson(text) };
  } finally {
    clearTimeout(timer);
  }
}

export function waitForWsEvent(wsUrl, timeoutMs, predicate, afterOpen = null) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      ws.terminate();
      reject(new Error('timed out waiting for browser WebSocket event'));
    }, timeoutMs || DEFAULT_TIMEOUT_MS);

    const finish = (handler, value, close = true) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (close && [ws.OPEN, ws.CONNECTING].includes(ws.readyState)) {
        ws.close();
      }
      handler(value);
    };
    const fail = (error) => {
      finish(reject, error);
    };

    if (afterOpen) {
      ws.once('open', () => Promise.resolve().then(afterOpen).catch(fail));
    }
    ws.on('message', (raw) => {
      const payload = safeJson(raw.toString());
      if (!payload || !predicate(payload)) return;
      finish(resolve, payload);
    });
    ws.on('unexpected-response', (_request, response) => {
      finish(reject, new Error(`browser WebSocket rejected with ${response.statusCode}`), false);
    });
    ws.on('error', (error) => {
      finish(reject, error, false);
    });
    ws.on('close', (code, reason) => {
      const detail = reason?.toString() || '';
      setImmediate(() => {
        finish(
          reject,
          new Error(`browser WebSocket closed before matching event: code=${code}${detail ? ` reason=${detail.slice(0, 120)}` : ''}`),
          false
        );
      });
    });
  });
}

export function authHeaders(token) {
  return { authorization: `Bearer ${token}` };
}

export function wsOrigin(spaceUrl) {
  const url = new URL(spaceUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.origin;
}

function safeJson(text) {
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return {};
  }
}
