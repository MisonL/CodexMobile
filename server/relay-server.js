import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import {
  DEFAULT_RELAY_HEARTBEAT_MS,
  DEFAULT_RELAY_IDLE_HEARTBEAT_MS,
  DEFAULT_RELAY_REQUEST_TIMEOUT_MS,
  DEFAULT_RELAY_SMALL_BODY_LIMIT,
  bearerSecretFromRequest,
  isStrongRelaySecret,
  logRelayEvent,
  parsePositiveInt
} from './relay-protocol.js';
import { createRelayHttpHandler } from './relay-http.js';
import { clientIpFromRequest, createMemoryRateLimiter } from './relay-rate-limit.js';
import { createRelayRuntime } from './relay-runtime.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '..');
const CLIENT_DIST = path.join(ROOT_DIR, 'client', 'dist');
const HOST = process.env.HOST || '0.0.0.0';
const PORT = parsePositiveInt(process.env.PORT, 7860);
const RELAY_SECRET = String(process.env.CODEXMOBILE_RELAY_SECRET || '').trim();
const RELAY_PREVIOUS_SECRET = String(process.env.CODEXMOBILE_RELAY_PREVIOUS_SECRET || '').trim();
const REQUEST_TIMEOUT_MS = parsePositiveInt(
  process.env.CODEXMOBILE_RELAY_REQUEST_TIMEOUT_MS,
  DEFAULT_RELAY_REQUEST_TIMEOUT_MS
);
const HEARTBEAT_MS = parsePositiveInt(process.env.CODEXMOBILE_RELAY_HEARTBEAT_MS, DEFAULT_RELAY_HEARTBEAT_MS);
const IDLE_HEARTBEAT_MS = parsePositiveInt(
  process.env.CODEXMOBILE_RELAY_IDLE_HEARTBEAT_MS,
  DEFAULT_RELAY_IDLE_HEARTBEAT_MS
);
const MAX_BODY_BYTES = parsePositiveInt(process.env.CODEXMOBILE_RELAY_SMALL_BODY_BYTES, DEFAULT_RELAY_SMALL_BODY_LIMIT);
const TOKEN_CACHE_TTL_MS = parsePositiveInt(process.env.CODEXMOBILE_RELAY_TOKEN_CACHE_TTL_MS, 5 * 60 * 1000);
const PENDING_REQUESTS_MAX = parsePositiveInt(process.env.CODEXMOBILE_RELAY_PENDING_REQUESTS_MAX, 64);
const BROWSER_PENDING_REQUESTS_MAX = parsePositiveInt(process.env.CODEXMOBILE_RELAY_BROWSER_PENDING_REQUESTS_MAX, 6);
const TRUST_PROXY = process.env.CODEXMOBILE_RELAY_TRUST_PROXY === '1';

function assertRelayConfig() {
  if (process.env.CODEXMOBILE_MODE && process.env.CODEXMOBILE_MODE !== 'relay') {
    throw new Error('CODEXMOBILE_MODE must be relay when starting relay server.');
  }
  if (!isStrongRelaySecret(RELAY_SECRET)) {
    throw new Error('CODEXMOBILE_RELAY_SECRET must be at least 32 characters.');
  }
  if (RELAY_PREVIOUS_SECRET && !isStrongRelaySecret(RELAY_PREVIOUS_SECRET)) {
    throw new Error('CODEXMOBILE_RELAY_PREVIOUS_SECRET must be at least 32 characters when set.');
  }
  if (RELAY_PREVIOUS_SECRET && RELAY_PREVIOUS_SECRET === RELAY_SECRET) {
    throw new Error('CODEXMOBILE_RELAY_PREVIOUS_SECRET must differ from CODEXMOBILE_RELAY_SECRET.');
  }
}

function writeUpgradeStatus(socket, status, reason) {
  socket.write(`HTTP/1.1 ${status} ${reason}\r\n\r\n`);
  socket.destroy();
}

function createUpgradeHandler(runtime, macWss, browserWss, realtimeWss, rateLimiter) {
  return function handleUpgrade(req, socket, head) {
    const url = new URL(req.url || '/', `http://${req.headers.host || `127.0.0.1:${PORT}`}`);
    if (url.pathname === '/relay/mac') {
      handleMacUpgrade(req, socket, head, macWss, runtime, rateLimiter);
      return;
    }
    if (url.pathname === '/ws/realtime') {
      handleRealtimeUpgrade(url, req, socket, head, realtimeWss, runtime);
      return;
    }
    if (url.pathname === '/ws') {
      handleBrowserUpgrade(url, req, socket, head, browserWss, runtime);
      return;
    }
    socket.destroy();
  };
}

function handleMacUpgrade(req, socket, head, macWss, runtime, rateLimiter) {
  if (!runtime.isValidRelaySecret(bearerSecretFromRequest(req))) {
    const clientIp = clientIpFromRequest(req, TRUST_PROXY);
    const result = rateLimiter.consume(`mac-auth:${clientIp}`, {
      limit: 5,
      windowMs: 5 * 60 * 1000,
      blockMs: 5 * 60 * 1000
    });
    runtime.metrics.macAuthFailuresTotal += 1;
    if (!result.allowed) {
      runtime.metrics.rateLimitedTotal += 1;
      logRelayEvent('relay.rate_limited', { scope: 'mac-auth', retryAfter: result.retryAfter });
      writeUpgradeStatus(socket, 429, 'Too Many Requests');
      return;
    }
    writeUpgradeStatus(socket, 401, 'Unauthorized');
    return;
  }
  macWss.handleUpgrade(req, socket, head, (ws) => runtime.acceptMacSocket(ws));
}

function handleBrowserUpgrade(url, req, socket, head, browserWss, runtime) {
  const token = url.searchParams.get('token') || '';
  runtime.validateBrowserToken(token).then((valid) => {
    if (!valid) {
      writeUpgradeStatus(socket, 401, 'Unauthorized');
      return;
    }
    browserWss.handleUpgrade(req, socket, head, (ws) => runtime.acceptBrowserSocket(ws));
  }).catch((error) => {
    writeUpgradeStatus(socket, error.status || 503, 'Service Unavailable');
  });
}

function handleRealtimeUpgrade(url, req, socket, head, realtimeWss, runtime) {
  const token = url.searchParams.get('token') || '';
  runtime.validateBrowserToken(token).then((valid) => {
    if (!valid) {
      writeUpgradeStatus(socket, 401, 'Unauthorized');
      return;
    }
    realtimeWss.handleUpgrade(req, socket, head, (ws) => runtime.acceptRealtimeSocket(ws, token));
  }).catch((error) => {
    writeUpgradeStatus(socket, error.status || 503, 'Service Unavailable');
  });
}

function main() {
  assertRelayConfig();
  const rateLimiter = createMemoryRateLimiter();
  const runtime = createRelayRuntime({
    relaySecret: RELAY_SECRET,
    previousRelaySecret: RELAY_PREVIOUS_SECRET,
    requestTimeoutMs: REQUEST_TIMEOUT_MS,
    heartbeatMs: HEARTBEAT_MS,
    idleHeartbeatMs: IDLE_HEARTBEAT_MS,
    tokenCacheTtlMs: TOKEN_CACHE_TTL_MS,
    pendingRequestsMax: PENDING_REQUESTS_MAX,
    browserPendingRequestsMax: BROWSER_PENDING_REQUESTS_MAX,
    requestBodyMaxBytes: MAX_BODY_BYTES
  });
  const requestHandler = createRelayHttpHandler({
    clientDist: CLIENT_DIST,
    maxBodyBytes: MAX_BODY_BYTES,
    requestTimeoutMs: REQUEST_TIMEOUT_MS,
    runtime,
    rateLimiter,
    trustProxy: TRUST_PROXY
  });
  const server = http.createServer(requestHandler);
  const macWss = new WebSocketServer({ noServer: true });
  const browserWss = new WebSocketServer({ noServer: true });
  const realtimeWss = new WebSocketServer({ noServer: true });

  server.on('upgrade', createUpgradeHandler(runtime, macWss, browserWss, realtimeWss, rateLimiter));
  server.listen(PORT, HOST, () => {
    logRelayEvent('relay.started', { host: HOST, port: PORT });
    console.log(`CodexMobile relay listening on http://${HOST}:${PORT}`);
  });
}

main();
