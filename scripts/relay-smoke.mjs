import { spawn } from 'node:child_process';
import http from 'node:http';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import WebSocket, { WebSocketServer } from 'ws';
import {
  ApiError,
  rateLimitLockFromError,
  remainingLockSeconds
} from '../client/src/api.js';
import { buildLocalTargetUrl } from '../server/relay-protocol.js';
import {
  nextReconnectDelay,
  shouldResetReconnectDelay
} from './relay-mac-client.mjs';
import {
  connectMac,
  expectRejectedMacSecret,
  nextBrowserEvent
} from './relay-smoke-support.mjs';

const secret = process.env.CODEXMOBILE_RELAY_SECRET || 'test-relay-secret-0123456789abcdef';
const port = Number(process.env.CODEXMOBILE_RELAY_TEST_PORT || 9786);
const baseUrl = `http://127.0.0.1:${port}`;
const relayUrl = `ws://127.0.0.1:${port}/relay/mac`;
const localFixturePort = Number(process.env.CODEXMOBILE_RELAY_LOCAL_FIXTURE_PORT || 9788);
const rootDir = fileURLToPath(new URL('..', import.meta.url));
const generatedFixtureBytes = Buffer.alloc(2 * 1024 * 1024 + 17, 7);

function fail(message, detail) {
  console.error(`Relay smoke failed: ${message}`);
  if (detail) {
    console.error(detail);
  }
  process.exit(1);
}

function expectInvalidForwardPathRejected() {
  for (const path of ['//example.com/api/status', '/api/status\r\nx: y']) {
    try {
      buildLocalTargetUrl(path, 'http://127.0.0.1:3321');
      fail('invalid forward path should be rejected', path);
    } catch (error) {
      if (error.status !== 400 || error.message !== 'relay_invalid_forward_path') {
        fail('invalid forward path should fail with relay_invalid_forward_path', error);
      }
    }
  }
}

function verifyRateLimitRetryAfterHelpers() {
  const error = new ApiError('请求过快，请稍后再试。', {
    status: 429,
    code: 'relay_rate_limited',
    retryAfter: 3
  });
  const lock = rateLimitLockFromError(error, 'send', 1000);
  if (lock?.scope !== 'send' || lock.retryAfter !== 3 || lock.untilMs !== 4000) {
    fail('rate limit helper should create a scoped retryAfter lock', lock);
  }
  if (remainingLockSeconds(lock, 1001) !== 3 || remainingLockSeconds(lock, 4000) !== 0) {
    fail('rate limit helper should expose remaining lock seconds', lock);
  }
  const ignored = rateLimitLockFromError(new ApiError('offline', { status: 503, code: 'mac_offline' }), 'send', 1000);
  if (ignored) {
    fail('non-rate-limit errors should not create operation locks', ignored);
  }
}

function verifyConnectorReconnectPolicy() {
  let delay = nextReconnectDelay(60000, { active: true, idleHeartbeatMs: 300000 });
  if (delay.delayMs !== 30000 || delay.nextDelayMs !== 30000) {
    fail('active reconnect delay should cap at 30 seconds', delay);
  }
  delay = nextReconnectDelay(600000, { active: false, idleHeartbeatMs: 300000 });
  if (delay.delayMs !== 300000 || delay.nextDelayMs !== 300000) {
    fail('idle reconnect delay should cap at 5 minutes', delay);
  }
  if (shouldResetReconnectDelay(59999) || !shouldResetReconnectDelay(60000)) {
    fail('stable online reconnect delay reset should require 60 seconds');
  }
}

function spawnRelay() {
  const child = spawn(process.execPath, ['server/relay-server.js'], {
    cwd: rootDir,
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: String(port),
      CODEXMOBILE_MODE: 'relay',
      CODEXMOBILE_RELAY_SECRET: secret,
      CODEXMOBILE_RELAY_HEARTBEAT_MS: '100',
      CODEXMOBILE_RELAY_IDLE_HEARTBEAT_MS: '500',
      CODEXMOBILE_RELAY_REQUEST_TIMEOUT_MS: '3000',
      CODEXMOBILE_RELAY_SMALL_BODY_BYTES: '1024',
      CODEXMOBILE_RELAY_PENDING_REQUESTS_MAX: '2',
      CODEXMOBILE_RELAY_BROWSER_PENDING_REQUESTS_MAX: '1'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stderr.on('data', (chunk) => process.stderr.write(chunk));
  return child;
}

function spawnConnector(localUrl) {
  const child = spawn(process.execPath, ['scripts/relay-mac-client.mjs'], {
    cwd: rootDir,
    env: {
      ...process.env,
      CODEXMOBILE_RELAY_URL: relayUrl,
      CODEXMOBILE_RELAY_SECRET: secret,
      CODEXMOBILE_RELAY_LOCAL_URL: localUrl,
      CODEXMOBILE_RELAY_DEVICE_NAME: 'fixture-mac',
      CODEXMOBILE_RELAY_HEARTBEAT_MS: '100',
      CODEXMOBILE_RELAY_IDLE_HEARTBEAT_MS: '500',
      CODEXMOBILE_RELAY_REQUEST_TIMEOUT_MS: '3000'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stderr.on('data', (chunk) => process.stderr.write(chunk));
  return child;
}

async function waitForRelay(child) {
  let output = '';
  child.stdout.on('data', (chunk) => {
    output += chunk.toString();
  });
  const startedAt = Date.now();
  while (Date.now() - startedAt < 10000) {
    if (output.includes('CodexMobile relay listening')) {
      return;
    }
    if (child.exitCode !== null) {
      fail('relay exited before listening', output);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  fail('relay did not start in time', output);
}

async function waitForMacConnected() {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 10000) {
    const result = await request('/api/status', { headers: { authorization: 'Bearer valid-token' } });
    if (result.data.macConnected && result.data.localStatus?.reachable) {
      return result.data;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  fail('relay did not observe connector in time', await request('/api/status'));
}

async function request(path, options = {}) {
  let response;
  try {
    response = await fetch(`${baseUrl}${path}`, {
      ...options,
      signal: options.signal || AbortSignal.timeout(5000),
      headers: {
        ...(options.body && !(options.body instanceof Buffer) ? { 'content-type': 'application/json' } : {}),
        ...(options.headers || {})
      },
      body:
        options.body && !(options.body instanceof Buffer) && typeof options.body !== 'string'
          ? JSON.stringify(options.body)
          : options.body
    });
  } catch (error) {
    throw new Error(`request ${path} failed: ${error.message}`);
  }
  const text = await response.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { text };
  }
  return { response, data };
}

async function requestBuffer(path, options = {}) {
  let response;
  try {
    response = await fetch(`${baseUrl}${path}`, {
      ...options,
      signal: options.signal || AbortSignal.timeout(5000),
      headers: options.headers || {}
    });
  } catch (error) {
    throw new Error(`request ${path} failed: ${error.message}`);
  }
  return {
    response,
    body: Buffer.from(await response.arrayBuffer())
  };
}

function multipartBody(boundary, fieldName, filename, contentType, content) {
  return Buffer.from([
    `--${boundary}\r\n`,
    `content-disposition: form-data; name="${fieldName}"; filename="${filename}"\r\n`,
    `content-type: ${contentType}\r\n\r\n`,
    content,
    `\r\n--${boundary}--\r\n`
  ].join(''));
}

function startLocalCodexFixture() {
  const browserSockets = new Set();
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || `127.0.0.1:${localFixturePort}`}`);
    await handleFixtureHttp(req, res, url, browserSockets);
  });
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || `127.0.0.1:${localFixturePort}`}`);
    if (url.pathname !== '/ws' || url.searchParams.get('token') !== 'valid-token') {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      browserSockets.add(ws);
      ws.on('close', () => browserSockets.delete(ws));
      ws.send(JSON.stringify({ type: 'connected', status: { connected: true } }));
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(localFixturePort, '127.0.0.1', () => {
      resolve({
        url: `http://127.0.0.1:${localFixturePort}`,
        close: async () => {
          for (const socket of browserSockets) {
            socket.close();
          }
          wss.close();
          await new Promise((done) => server.close(done));
        }
      });
    });
  });
}

async function handleFixtureHttp(req, res, url, browserSockets) {
  if (url.pathname === '/api/status') {
    sendFixtureStatus(req, res);
    return;
  }
  if (url.pathname === '/api/chat/send') {
    sendFixtureChat(res, browserSockets);
    return;
  }
  if (url.pathname === '/api/uploads') {
    await sendFixtureUpload(req, res);
    return;
  }
  if (url.pathname === '/api/voice/transcribe') {
    await sendFixtureVoice(req, res);
    return;
  }
  if (url.pathname === '/generated/test.png') {
    sendFixtureGenerated(res);
    return;
  }
  sendFixtureJson(res, 404, { error: 'not_found' });
}

function sendFixtureStatus(req, res) {
  const token = String(req.headers.authorization || '').replace(/^bearer\s+/i, '');
  sendFixtureJson(res, 200, {
    connected: true,
    hostName: 'fixture-mac',
    provider: 'codex',
    model: 'fixture-model',
    syncedAt: null,
    auth: { authenticated: token === 'valid-token' }
  });
}

function sendFixtureChat(res, browserSockets) {
  sendFixtureJson(res, 202, { accepted: true, turnId: 'fixture-turn' });
  setTimeout(() => {
    broadcastFixtureEvent(browserSockets, {
      type: 'status-update',
      status: 'running',
      label: 'Fixture running',
      turnId: 'fixture-turn'
    });
  }, 50);
}

async function sendFixtureUpload(req, res) {
  const body = await readFixtureBody(req);
  if (!body.includes('hello-upload')) {
    sendFixtureJson(res, 400, { error: 'missing_upload_body' });
    return;
  }
  sendFixtureJson(res, 201, {
    ok: true,
    kind: 'upload',
    bytes: body.length,
    contentType: req.headers['content-type'] || ''
  });
}

async function sendFixtureVoice(req, res) {
  const body = await readFixtureBody(req);
  if (!body.includes('voice-bytes')) {
    sendFixtureJson(res, 400, { error: 'missing_voice_body' });
    return;
  }
  sendFixtureJson(res, 200, {
    text: 'fixture transcript',
    bytes: body.length,
    contentType: req.headers['content-type'] || ''
  });
}

function sendFixtureGenerated(res) {
  res.writeHead(200, {
    'content-type': 'image/png',
    'content-length': generatedFixtureBytes.length,
    'cache-control': 'no-store'
  });
  res.end(generatedFixtureBytes);
}

async function readFixtureBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function sendFixtureJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload));
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length
  });
  res.end(body);
}

function broadcastFixtureEvent(sockets, payload) {
  const body = JSON.stringify(payload);
  for (const socket of sockets) {
    if (socket.readyState === socket.OPEN) {
      socket.send(body);
    }
  }
}

async function verifyRelayStartup() {
  await expectRejectedMacSecret(relayUrl);

  let result = await request('/api/projects');
  result = await request('/api/status');
  if (
    result.response.status !== 200 ||
    result.data.mode !== 'relay' ||
    result.data.relayState !== 'pairing_required' ||
    result.data.macConnected !== false ||
    result.data.limits?.pendingRequestsMax !== 2 ||
    result.data.limits?.browserPendingRequestsMax !== 1 ||
    result.data.limits?.requestBodyMaxBytes !== 1024 ||
    result.data.limits?.heartbeatMs !== 100 ||
    result.data.limits?.idleHeartbeatMs !== 500
  ) {
    fail('/api/status should expose relay mode before Mac connects', result);
  }

  result = await request('/api/projects');
  if (result.response.status !== 401 || result.data.error !== 'pairing_required') {
    fail('unauthenticated API should return pairing_required', result);
  }

  result = await request('/api/projects', { headers: { authorization: 'Bearer valid-token' } });
  if (result.response.status !== 503 || result.data.error !== 'mac_offline') {
    fail('authenticated API without Mac should return mac_offline', result);
  }

  result = await request('/generated/test.png');
  if (result.response.status !== 401) {
    fail('unauthenticated generated asset should return 401', result);
  }

  result = await request('/api/feishu/auth/callback?code=test&state=test');
  if (result.response.status !== 501 || result.data.error !== 'relay_unsupported') {
    fail('Feishu OAuth callback should be explicitly unsupported in relay Phase 1', result);
  }
}

async function verifyMacOfflineState() {
  const offlineMac = await connectMac({ relayUrl, secret, reachable: false });
  const result = await request('/api/projects', { headers: { authorization: 'Bearer valid-token' } });
  if (result.response.status !== 503 || result.data.error !== 'mac_local_offline') {
    fail('Mac connected with local offline should return mac_local_offline', result);
  }
  offlineMac.ws.close();
  await new Promise((resolve) => setTimeout(resolve, 100));
}

async function verifyForwardedHttp(mac) {
  let result = await request('/api/pair', { method: 'POST', body: { code: '123456' } });
  if (result.response.status !== 200 || result.data.token !== 'valid-token') {
    fail('pair should be forwarded to Mac and return Mac token', result);
  }

  result = await request('/api/projects', { headers: { authorization: 'Bearer valid-token' } });
  if (result.response.status !== 200 || result.data.projects?.[0]?.id !== 'mac-project') {
    fail('/api/projects should be forwarded to Mac', result);
  }

  result = await request('/api/chat/send', {
    method: 'POST',
    headers: {
      authorization: 'Bearer valid-token',
      'content-type': 'application/json'
    },
    body: JSON.stringify({ message: 'x'.repeat(2048) })
  });
  if (result.response.status !== 413 || result.data.error !== 'relay_body_too_large') {
    fail('oversized relay body should return 413', result);
  }

  return mac;
}

async function verifyBrowserPendingLimit(mac) {
  mac.ws.close();
  await new Promise((resolve) => setTimeout(resolve, 100));
  const delayedMac = await connectMac({ relayUrl, secret, reachable: true, delayProjects: true });
  const first = request('/api/projects', { headers: { authorization: 'Bearer valid-token' } });
  await new Promise((resolve) => setTimeout(resolve, 100));
  const limited = await request('/api/projects', { headers: { authorization: 'Bearer valid-token' } });
  if (
    limited.response.status !== 429 ||
    limited.data.error !== 'relay_rate_limited' ||
    limited.data.reason !== 'relay_client_pending_limit_exceeded'
  ) {
    fail('same browser should be limited when pending request limit is reached', limited);
  }
  const result = await first;
  if (result.response.status !== 200 || result.data.projects?.[0]?.id !== 'mac-project') {
    fail('first pending request should still complete after pending limit rejection', result);
  }
  return delayedMac;
}

async function verifyGlobalPendingLimit(mac) {
  mac.ws.close();
  await new Promise((resolve) => setTimeout(resolve, 100));
  const delayedMac = await connectMac({ relayUrl, secret, reachable: true, delayProjects: true });
  const first = request('/api/projects', { headers: { authorization: 'Bearer valid-token-a' } });
  const second = request('/api/projects', { headers: { authorization: 'Bearer valid-token-b' } });
  await new Promise((resolve) => setTimeout(resolve, 100));
  const limited = await request('/api/projects', { headers: { authorization: 'Bearer valid-token-c' } });
  if (
    limited.response.status !== 429 ||
    limited.data.error !== 'relay_rate_limited' ||
    limited.data.reason !== 'relay_pending_limit_exceeded'
  ) {
    fail('global pending request limit should reject extra relay requests', limited);
  }
  for (const result of await Promise.all([first, second])) {
    if (result.response.status !== 200 || result.data.projects?.[0]?.id !== 'mac-project') {
      fail('requests already admitted before global limit should still complete', result);
    }
  }
  return delayedMac;
}

async function verifyIdleAndActiveHeartbeat(mac) {
  await new Promise((resolve) => setTimeout(resolve, 250));
  const idlePings = mac.messages.filter((message) => message.type === 'ping').length;
  if (idlePings !== 0) {
    fail('idle relay should not ping Mac at active heartbeat frequency', mac.messages);
  }

  const ws = new WebSocket(`${baseUrl.replace('http:', 'ws:')}/ws?token=valid-token`);
  await once(ws, 'open');
  await new Promise((resolve) => setTimeout(resolve, 250));
  const activePings = mac.messages.filter((message) => message.type === 'ping').length;
  ws.close();
  if (activePings < 1) {
    fail('relay should use active heartbeat while browser socket is connected', mac.messages);
  }
}

async function verifyBrowserEvents(mac) {
  const ws = new WebSocket(`${baseUrl.replace('http:', 'ws:')}/ws?token=valid-token`);
  await once(ws, 'open');
  const statusPromise = nextBrowserEvent(ws, 'relay-status');
  const relayHello = mac.messages.find((message) => message.type === 'relay.hello');
  mac.ws.send(JSON.stringify({
    type: 'mac.status',
    macConnectionEpoch: relayHello.macConnectionEpoch,
    localStatus: { reachable: true, checkedAt: new Date().toISOString(), status: 200 }
  }));
  const relayStatus = await statusPromise;
  if (!relayStatus.macConnected || relayStatus.localStatus?.reachable !== true) {
    fail('browser ws should receive relay-status when Mac status changes', relayStatus);
  }
  const eventPromise = nextBrowserEvent(ws, 'status-update');
  const result = await request('/api/chat/send', {
    method: 'POST',
    headers: { authorization: 'Bearer valid-token' },
    body: { projectId: 'mac-project', message: 'hello' }
  });
  if (result.response.status !== 202 || !result.data.accepted) {
    fail('/api/chat/send should return 202', result);
  }
  const event = await eventPromise;
  if (event.status !== 'running') {
    fail('browser ws should receive forwarded Mac status-update event', event);
  }
  ws.close();
}

async function verifyReconnectAndUnsupportedRoutes() {
  const delayedMac = await connectMac({ relayUrl, secret, reachable: true, delayProjects: true });
  const pending = request('/api/projects', { headers: { authorization: 'Bearer valid-token' } });
  await new Promise((resolve) => setTimeout(resolve, 100));
  const replacementMac = await connectMac({ relayUrl, secret, reachable: true });
  let result = await pending;
  if (result.response.status !== 502 || result.data.error !== 'mac_reconnected') {
    fail('old epoch pending request should fail on reconnect', result);
  }
  delayedMac.ws.close();
  replacementMac.ws.close();

  result = await request('/ws/realtime?token=valid-token');
  if (result.response.status !== 501 || result.data.error !== 'relay_realtime_unsupported') {
    fail('/ws/realtime should fail explicitly in Phase 1', result);
  }
}

async function verifyRealConnectorForwardsLocalWsEvents() {
  const local = await startLocalCodexFixture();
  const connector = spawnConnector(local.url);
  try {
    await waitForMacConnected();
    const ws = new WebSocket(`${baseUrl.replace('http:', 'ws:')}/ws?token=valid-token`);
    await once(ws, 'open');
    const eventPromise = nextBrowserEvent(ws, 'status-update', 5000);
    const result = await request('/api/chat/send', {
      method: 'POST',
      headers: { authorization: 'Bearer valid-token' },
      body: { projectId: 'fixture-project', message: 'hello' }
    });
    if (result.response.status !== 202 || result.data.turnId !== 'fixture-turn') {
      fail('real connector should forward chat request to local fixture', result);
    }
    const event = await eventPromise;
    ws.close();
    if (event.status !== 'running' || event.turnId !== 'fixture-turn') {
      fail('real connector should forward local ws status-update event', event);
    }
  } finally {
    connector.kill('SIGTERM');
    await local.close();
  }
}

async function verifyRealConnectorStreamsMultipartRequests() {
  const local = await startLocalCodexFixture();
  const connector = spawnConnector(local.url);
  try {
    await waitForMacConnected();
    const uploadBoundary = '----codexmobile-upload-boundary';
    let result = await request('/api/uploads', {
      method: 'POST',
      headers: {
        authorization: 'Bearer valid-token',
        'content-type': `multipart/form-data; boundary=${uploadBoundary}`
      },
      body: multipartBody(uploadBoundary, 'file', 'hello.txt', 'text/plain', 'hello-upload')
    });
    if (result.response.status !== 201 || result.data.kind !== 'upload' || !result.data.contentType.includes(uploadBoundary)) {
      fail('real connector should stream multipart upload to local fixture', result);
    }

    const voiceBoundary = '----codexmobile-voice-boundary';
    result = await request('/api/voice/transcribe', {
      method: 'POST',
      headers: {
        authorization: 'Bearer valid-token',
        'content-type': `multipart/form-data; boundary=${voiceBoundary}`
      },
      body: multipartBody(voiceBoundary, 'audio', 'voice.wav', 'audio/wav', 'voice-bytes')
    });
    if (result.response.status !== 200 || result.data.text !== 'fixture transcript' || !result.data.contentType.includes(voiceBoundary)) {
      fail('real connector should stream multipart voice transcription to local fixture', result);
    }
  } finally {
    connector.kill('SIGTERM');
    await local.close();
  }
}

async function verifyRealConnectorStreamsGeneratedAssets() {
  const local = await startLocalCodexFixture();
  const connector = spawnConnector(local.url);
  try {
    await waitForMacConnected();
    const result = await requestBuffer('/generated/test.png', {
      headers: { authorization: 'Bearer valid-token' }
    });
    if (
      result.response.status !== 200 ||
      result.response.headers.get('content-type') !== 'image/png' ||
      !result.body.equals(generatedFixtureBytes)
    ) {
      fail('real connector should stream generated asset bytes to browser', {
        status: result.response.status,
        contentType: result.response.headers.get('content-type'),
        bytes: result.body.length
      });
    }
  } finally {
    connector.kill('SIGTERM');
    await local.close();
  }
}

async function main() {
  expectInvalidForwardPathRejected();
  verifyRateLimitRetryAfterHelpers();
  verifyConnectorReconnectPolicy();
  const relay = spawnRelay();
  try {
    await waitForRelay(relay);
    await verifyRelayStartup();
    await verifyMacOfflineState();
    const mac = await connectMac({ relayUrl, secret, reachable: true });
    await verifyIdleAndActiveHeartbeat(mac);
    const pendingLimitMac = await verifyBrowserPendingLimit(await verifyForwardedHttp(mac));
    const globalLimitMac = await verifyGlobalPendingLimit(pendingLimitMac);
    globalLimitMac.ws.close();
    await new Promise((resolve) => setTimeout(resolve, 100));
    const eventMac = await connectMac({ relayUrl, secret, reachable: true });
    await verifyBrowserEvents(eventMac);
    eventMac.ws.close();
    await new Promise((resolve) => setTimeout(resolve, 100));
    await verifyReconnectAndUnsupportedRoutes();
    await verifyRealConnectorForwardsLocalWsEvents();
    await verifyRealConnectorStreamsMultipartRequests();
    await verifyRealConnectorStreamsGeneratedAssets();
    console.log('Relay smoke ok');
  } finally {
    relay.kill('SIGTERM');
  }
}

main().catch((error) => fail(error.message, error.stack));
