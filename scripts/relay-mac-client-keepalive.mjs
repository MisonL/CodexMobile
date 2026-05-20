export const DEFAULT_RELAY_KEEPALIVE_MS = 240000;
export const MIN_RELAY_KEEPALIVE_MS = 60000;
const DEFAULT_KEEPALIVE_PATH = '/api/status';
const KEEPALIVE_TIMEOUT_MS = 10000;

export function parseRelayKeepaliveMs(value, fallback = DEFAULT_RELAY_KEEPALIVE_MS) {
  if (String(value).trim() === '0') {
    return 0;
  }
  const next = Number(value);
  if (!Number.isFinite(next) || next < MIN_RELAY_KEEPALIVE_MS) {
    return fallback;
  }
  return Math.floor(next);
}

export function buildRelayKeepaliveUrl(relayUrl, pathname = DEFAULT_KEEPALIVE_PATH) {
  const url = new URL(relayUrl);
  if (url.username || url.password) {
    throw new Error('relay_keepalive_invalid_relay_url');
  }
  if (url.protocol === 'wss:') {
    url.protocol = 'https:';
  } else if (url.protocol === 'ws:') {
    url.protocol = 'http:';
  } else {
    throw new Error('relay_keepalive_invalid_relay_url');
  }
  url.pathname = pathname;
  url.search = '';
  url.hash = '';
  url.searchParams.set('keepalive', '1');
  return url.toString();
}

export function createRelayKeepalive({
  relayUrl,
  intervalMs = DEFAULT_RELAY_KEEPALIVE_MS,
  fetchImpl = globalThis.fetch,
  logState = () => {},
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval
}) {
  const keepaliveUrl = buildRelayKeepaliveUrl(relayUrl);
  let timer = null;
  let pingInFlight = null;

  async function ping() {
    if (pingInFlight) {
      return pingInFlight;
    }
    pingInFlight = runPing().finally(() => {
      pingInFlight = null;
    });
    return pingInFlight;
  }

  async function runPing() {
    try {
      const response = await fetchImpl(keepaliveUrl, {
        method: 'GET',
        headers: {
          accept: 'application/json',
          'cache-control': 'no-store'
        },
        signal: AbortSignal.timeout(KEEPALIVE_TIMEOUT_MS)
      });
      await releaseResponseBody(response);
      if (!response.ok) {
        logState('keepalive_failed', `status=${response.status}`);
        return false;
      }
      logState('keepalive', `status=${response.status}`);
      return true;
    } catch (error) {
      logState('keepalive_failed', error.message || 'request_failed');
      return false;
    }
  }

  function start() {
    if (!intervalMs || timer) {
      return;
    }
    timer = setIntervalFn(() => ping(), intervalMs);
    timer.unref?.();
  }

  function stop() {
    if (!timer) {
      return;
    }
    clearIntervalFn(timer);
    timer = null;
  }

  async function releaseResponseBody(response) {
    try {
      await response.body?.cancel?.();
    } catch {
      return;
    }
  }

  return {
    ping,
    start,
    stop
  };
}
