import WebSocket from 'ws';

export const DEFAULT_TIMEOUT_MS = 10000;
const FALLBACK_TEXT = 'Build the PWA with: npm run build';
const SENSITIVE_KEY_PATTERN = /secret|token|authorization|cookie|pairingCode/i;
export function normalizeSpaceBaseUrl(input) {
  const value = String(input || '').trim();
  if (!value) throw new Error('Missing Space URL.');
  const url = new URL(value);
  if (url.protocol === 'wss:') url.protocol = 'https:';
  else if (url.protocol === 'ws:') url.protocol = 'http:';
  else if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(`Unsupported Space URL protocol: ${url.protocol}`);
  }
  if (url.pathname === '/relay/mac') {
    url.pathname = '/';
    url.search = '';
  }
  url.hash = '';
  return url.origin;
}
export function parseArgs(argv, env = process.env) {
  const options = defaultOptions(env);
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === '--url') options.spaceUrl = requireValue(argv, ++index, item);
    else if (item.startsWith('--url=')) options.spaceUrl = item.slice(6);
    else if (item === '--token') options.token = requireValue(argv, ++index, item);
    else if (item.startsWith('--token=')) options.token = item.slice(8);
    else if (item === '--pair-code') options.pairCode = requireValue(argv, ++index, item);
    else if (item.startsWith('--pair-code=')) options.pairCode = item.slice(12);
    else if (item === '--device-name') options.deviceName = requireValue(argv, ++index, item);
    else if (item.startsWith('--device-name=')) options.deviceName = item.slice(14);
    else if (item === '--project-id') options.projectId = requireValue(argv, ++index, item);
    else if (item.startsWith('--project-id=')) options.projectId = item.slice(13);
    else if (item === '--chat-message') options.chatMessage = requireValue(argv, ++index, item);
    else if (item.startsWith('--chat-message=')) options.chatMessage = item.slice(15);
    else if (item === '--timeout-ms') options.timeoutMs = positiveInt(requireValue(argv, ++index, item), item);
    else if (item.startsWith('--timeout-ms=')) options.timeoutMs = positiveInt(item.slice(13), '--timeout-ms');
    else if (item === '--require-mac') options.requireMac = true;
    else if (item === '--json') options.json = true;
    else throw new Error(`Unknown argument: ${item}`);
  }
  options.spaceUrl = normalizeSpaceBaseUrl(options.spaceUrl);
  return options;
}
export async function verifySpace(options) {
  const context = { token: String(options.token || '').trim(), projects: [] };
  const report = createReport(options);
  await runPublicChecks(report, context, options);
  if (!context.token && options.pairCode) {
    await runCheck(report, 'pair', 'Pair through Space and receive Mac token', async () => {
      context.token = await pairThroughSpace(report.spaceUrl, options.pairCode, options.deviceName, report.timeoutMs);
      return 'token received';
    });
  }
  if (!context.token) {
    skipAuthChecks(report, 'missing browser token or pair code');
    return finalize(report);
  }
  await runAuthenticatedChecks(report, context, options);
  return finalize(report);
}
function defaultOptions(env) {
  return {
    spaceUrl: env.CODEXMOBILE_SPACE_URL || env.CODEXMOBILE_RELAY_URL || '',
    token: env.CODEXMOBILE_DEVICE_TOKEN || '',
    pairCode: env.CODEXMOBILE_PAIRING_CODE || '',
    deviceName: env.CODEXMOBILE_VERIFY_DEVICE_NAME || 'space-verify',
    chatMessage: '',
    projectId: '',
    timeoutMs: DEFAULT_TIMEOUT_MS,
    requireMac: false,
    json: false
  };
}
function createReport(options) {
  const spaceUrl = normalizeSpaceBaseUrl(options.spaceUrl);
  return {
    ok: true,
    spaceUrl,
    timeoutMs: positiveInt(options.timeoutMs || DEFAULT_TIMEOUT_MS, 'timeoutMs'),
    requireMac: Boolean(options.requireMac),
    checks: []
  };
}
async function runPublicChecks(report, context, options) {
  await runCheck(report, 'pwa', 'PWA loads from Space', () => verifyPwa(report.spaceUrl, report.timeoutMs));
  await runCheck(report, 'status', 'Relay status is safe and valid', async () => {
    const status = await verifyStatus(report.spaceUrl, report.timeoutMs, options.requireMac);
    context.status = status;
    return `relayState=${status.relayState} macConnected=${Boolean(status.macConnected)}`;
  });
  await runCheck(report, 'realtimeHttpFallback', 'Realtime WebSocket HTTP fallback is explicit', () => {
    return verifyRealtimeHttpFallback(report.spaceUrl, report.timeoutMs);
  });
  await runCheck(report, 'unauthenticatedProjects', 'Unauthenticated projects requires pairing', () => {
    return verifyUnauthenticatedProjects(report.spaceUrl, report.timeoutMs);
  });
}
async function runAuthenticatedChecks(report, context, options) {
  await runCheck(report, 'authenticatedProjects', 'Authenticated project list', async () => {
    context.projects = await verifyAuthenticatedProjects(report.spaceUrl, context.token, report.timeoutMs);
    return `projects=${context.projects.length}`;
  });
  await runCheck(report, 'browserWebSocket', 'Browser WebSocket receives connected event', () => {
    return verifyBrowserWebSocket(report.spaceUrl, context.token, report.timeoutMs);
  });
  if (!options.chatMessage) {
    skip(report, 'chatSend', 'Chat send', 'missing --chat-message');
    return;
  }
  await runCheck(report, 'chatSend', 'Chat send returns 202', () => {
    return verifyChatSend(report.spaceUrl, context, options, report.timeoutMs);
  });
}
function skipAuthChecks(report, detail) {
  skip(report, 'authenticatedProjects', 'Authenticated project list', detail);
  skip(report, 'browserWebSocket', 'Browser WebSocket', detail);
  skip(report, 'chatSend', 'Chat send', detail);
}
async function verifyPwa(spaceUrl, timeoutMs) {
  const result = await requestJsonOrText(`${spaceUrl}/`, { timeoutMs });
  if (result.status !== 200) throw new Error(`expected 200, got ${result.status}`);
  if (result.text.includes(FALLBACK_TEXT)) throw new Error('Space is serving fallback text instead of built PWA.');
  if (!/<html[\s>]/i.test(result.text) || !/id=["']root["']/i.test(result.text)) {
    throw new Error('Space root response does not look like the built PWA.');
  }
  return 'built PWA HTML';
}
async function verifyStatus(spaceUrl, timeoutMs, requireMac) {
  const result = await requestJsonOrText(`${spaceUrl}/api/status`, { timeoutMs });
  if (result.status !== 200 || result.data?.mode !== 'relay') throw new Error(`expected relay status 200, got ${result.status}`);
  if (typeof result.data.relayState !== 'string') throw new Error('relayState is missing.');
  const sensitivePath = findSensitiveKey(result.data);
  if (sensitivePath) throw new Error(`status exposes sensitive field: ${sensitivePath}`);
  if (requireMac && (!result.data.macConnected || result.data.localStatus?.reachable !== true)) {
    throw new Error(`Mac connector is not ready: ${result.data.relayState}`);
  }
  return result.data;
}
async function verifyRealtimeHttpFallback(spaceUrl, timeoutMs) {
  const result = await requestJsonOrText(`${spaceUrl}/ws/realtime`, { timeoutMs });
  if (result.status !== 501 || result.data?.error !== 'relay_realtime_http_upgrade_required') {
    throw new Error(`expected 501 relay_realtime_http_upgrade_required, got ${result.status}`);
  }
  return 'relay_realtime_http_upgrade_required';
}
async function verifyUnauthenticatedProjects(spaceUrl, timeoutMs) {
  const result = await requestJsonOrText(`${spaceUrl}/api/projects`, { timeoutMs });
  if (result.status !== 401 || result.data?.error !== 'pairing_required') {
    throw new Error(`expected 401 pairing_required, got ${result.status}`);
  }
  return 'pairing_required';
}
async function pairThroughSpace(spaceUrl, pairCode, deviceName, timeoutMs) {
  const result = await requestJsonOrText(`${spaceUrl}/api/pair`, {
    timeoutMs,
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: String(pairCode), deviceName: String(deviceName || 'space-verify') })
  });
  if (result.status !== 200 || typeof result.data?.token !== 'string' || !result.data.token) {
    throw new Error(`expected pair token, got ${result.status}`);
  }
  return result.data.token;
}
async function verifyAuthenticatedProjects(spaceUrl, token, timeoutMs) {
  const result = await requestJsonOrText(`${spaceUrl}/api/projects`, { timeoutMs, headers: authHeaders(token) });
  if (result.status !== 200 || !Array.isArray(result.data?.projects)) {
    throw new Error(`expected projects array, got ${result.status}`);
  }
  return result.data.projects;
}
async function verifyBrowserWebSocket(spaceUrl, token, timeoutMs) {
  const wsUrl = `${wsOrigin(spaceUrl)}/ws?token=${encodeURIComponent(token)}`;
  const event = await waitForWsEvent(wsUrl, timeoutMs, (payload) => payload.type === 'connected');
  if (event.status?.mode !== 'relay') throw new Error('connected event did not include relay status.');
  return `relayState=${event.status.relayState}`;
}
async function verifyChatSend(spaceUrl, context, options, timeoutMs) {
  const projectId = options.projectId || context.projects[0]?.id;
  if (!projectId) throw new Error('missing project id for chat send.');
  const wsUrl = `${wsOrigin(spaceUrl)}/ws?token=${encodeURIComponent(context.token)}`;
  const isChatEvent = (payload) => ['status-update', 'assistant-update', 'chat-complete'].includes(payload.type);
  const event = await waitForWsEvent(wsUrl, timeoutMs, isChatEvent, async () => {
      const result = await requestJsonOrText(`${spaceUrl}/api/chat/send`, {
        timeoutMs, method: 'POST',
        headers: { ...authHeaders(context.token), 'content-type': 'application/json' },
        body: JSON.stringify({ projectId, message: options.chatMessage })
      });
      if (result.status !== 202) throw new Error(`expected 202, got ${result.status}`);
    });
  if (!event?.type) throw new Error('chat websocket event was not received.');
  return `projectId=${projectId}`;
}
async function requestJsonOrText(url, { timeoutMs, ...options } = {}) {
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
function waitForWsEvent(wsUrl, timeoutMs, predicate, afterOpen = null) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error('timed out waiting for browser WebSocket event'));
    }, timeoutMs || DEFAULT_TIMEOUT_MS);
    const fail = (error) => {
      clearTimeout(timer);
      ws.close();
      reject(error);
    };
    if (afterOpen) {
      ws.once('open', () => Promise.resolve().then(afterOpen).catch(fail));
    }
    ws.on('message', (raw) => {
      const payload = safeJson(raw.toString());
      if (!payload || !predicate(payload)) return;
      clearTimeout(timer);
      ws.close();
      resolve(payload);
    });
    ws.on('unexpected-response', (_request, response) => {
      clearTimeout(timer);
      reject(new Error(`browser WebSocket rejected with ${response.statusCode}`));
    });
    ws.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}
function runCheck(report, id, label, action) {
  return Promise.resolve()
    .then(action)
    .then((detail) => pass(report, id, label, detail))
    .catch((error) => fail(report, id, label, error.message || String(error)));
}
function pass(report, id, label, detail = '') {
  report.checks.push({ id, label, status: 'passed', detail: String(detail || '') });
}
function fail(report, id, label, detail = '') {
  report.ok = false;
  report.checks.push({ id, label, status: 'failed', detail: String(detail || '') });
}
function skip(report, id, label, detail = '') {
  report.checks.push({ id, label, status: 'skipped', detail: String(detail || '') });
}
function finalize(report) {
  report.summary = {
    passed: report.checks.filter((check) => check.status === 'passed').length,
    failed: report.checks.filter((check) => check.status === 'failed').length,
    skipped: report.checks.filter((check) => check.status === 'skipped').length
  };
  return report;
}
function authHeaders(token) {
  return { authorization: `Bearer ${token}` };
}
function wsOrigin(spaceUrl) {
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
function findSensitiveKey(value, prefix = '') {
  if (!value || typeof value !== 'object') return '';
  for (const [key, child] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (path.startsWith('secrets.') && path !== 'secrets.previousConfigured') return path;
    if (SENSITIVE_KEY_PATTERN.test(key) && path !== 'secrets') return path;
    const nested = findSensitiveKey(child, path);
    if (nested) return nested;
  }
  return '';
}
function requireValue(argv, index, name) {
  const value = argv[index];
  if (!value) throw new Error(`${name} requires a value.`);
  return value;
}
function positiveInt(value, name) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new Error(`${name} must be a positive integer.`);
  return Math.floor(number);
}
