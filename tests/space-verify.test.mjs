import http from 'node:http';
import assert from 'node:assert/strict';
import test from 'node:test';
import { WebSocketServer } from 'ws';

import {
  normalizeSpaceBaseUrl,
  verifySpace
} from '../scripts/verify-hf-space.mjs';

test('normalizeSpaceBaseUrl accepts Space HTTP URLs and Mac relay WebSocket URLs', () => {
  assert.equal(normalizeSpaceBaseUrl('https://example.hf.space/'), 'https://example.hf.space');
  assert.equal(normalizeSpaceBaseUrl('wss://example.hf.space/relay/mac'), 'https://example.hf.space');
  assert.equal(normalizeSpaceBaseUrl('ws://127.0.0.1:7860/relay/mac'), 'http://127.0.0.1:7860');
});

test('verifySpace performs public read-only checks without a browser token', async () => {
  const fixture = await startSpaceFixture();
  try {
    const report = await verifySpace({ spaceUrl: fixture.url, timeoutMs: 1000 });
    assert.equal(report.ok, true);
    assert.equal(statusFor(report, 'pwa'), 'passed');
    assert.equal(statusFor(report, 'status'), 'passed');
    assert.equal(statusFor(report, 'realtimeHttpFallback'), 'passed');
    assert.equal(statusFor(report, 'unauthenticatedProjects'), 'passed');
    assert.equal(statusFor(report, 'authenticatedProjects'), 'skipped');
  } finally {
    await fixture.close();
  }
});

test('verifySpace allows safe relay secret metadata without exposing secret values', async () => {
  const fixture = await startSpaceFixture({ exposeSecretMetadata: true });
  try {
    const report = await verifySpace({ spaceUrl: fixture.url, timeoutMs: 1000 });
    assert.equal(report.ok, true);
    assert.equal(statusFor(report, 'status'), 'passed');
  } finally {
    await fixture.close();
  }
});

test('verifySpace rejects status responses that expose actual secret values', async () => {
  const fixture = await startSpaceFixture({ exposeSecretValue: true });
  try {
    const report = await verifySpace({ spaceUrl: fixture.url, timeoutMs: 1000 });
    assert.equal(report.ok, false);
    assert.equal(statusFor(report, 'status'), 'failed');
    assert.match(detailFor(report, 'status'), /secret/i);
  } finally {
    await fixture.close();
  }
});

test('verifySpace fails when Space serves fallback text instead of the built PWA', async () => {
  const fixture = await startSpaceFixture({ fallbackPwa: true });
  try {
    const report = await verifySpace({ spaceUrl: fixture.url, timeoutMs: 1000 });
    assert.equal(report.ok, false);
    assert.equal(statusFor(report, 'pwa'), 'failed');
    assert.match(detailFor(report, 'pwa'), /fallback/i);
  } finally {
    await fixture.close();
  }
});

test('verifySpace can pair, verify browser websocket, and send chat when explicitly requested', async () => {
  const fixture = await startSpaceFixture({ authenticated: true });
  try {
    const report = await verifySpace({
      spaceUrl: fixture.url,
      pairCode: '123456',
      chatMessage: 'verification',
      checkRealtime: true,
      timeoutMs: 1000,
      requireMac: true
    });
    assert.equal(report.ok, true);
    assert.equal(statusFor(report, 'pair'), 'passed');
    assert.equal(statusFor(report, 'authenticatedProjects'), 'passed');
    assert.equal(statusFor(report, 'browserWebSocket'), 'passed');
    assert.equal(statusFor(report, 'realtimeWebSocket'), 'passed');
    assert.equal(statusFor(report, 'chatSend'), 'passed');
  } finally {
    await fixture.close();
  }
});

test('verifySpace does not open realtime websocket unless explicitly requested', async () => {
  const fixture = await startSpaceFixture({ authenticated: true });
  try {
    const report = await verifySpace({
      spaceUrl: fixture.url,
      token: 'valid-token',
      timeoutMs: 1000
    });
    assert.equal(report.ok, true);
    assert.equal(statusFor(report, 'realtimeWebSocket'), 'skipped');
    assert.equal(fixture.realtimeConnections(), 0);
  } finally {
    await fixture.close();
  }
});

test('verifySpace distinguishes realtime tunnel errors from strict provider readiness', async () => {
  const fixture = await startSpaceFixture({
    authenticated: true,
    realtimeEvent: { type: 'voice.realtime.error', error: 'fixture_provider_error' }
  });
  try {
    const relaxed = await verifySpace({
      spaceUrl: fixture.url,
      token: 'valid-token',
      checkRealtime: true,
      timeoutMs: 1000
    });
    assert.equal(relaxed.ok, true);
    assert.equal(statusFor(relaxed, 'realtimeWebSocket'), 'passed');
    assert.match(detailFor(relaxed, 'realtimeWebSocket'), /fixture_provider_error/);

    const strict = await verifySpace({
      spaceUrl: fixture.url,
      token: 'valid-token',
      timeoutMs: 1000,
      requireRealtimeReady: true
    });
    assert.equal(strict.ok, false);
    assert.equal(statusFor(strict, 'realtimeWebSocket'), 'failed');
    assert.match(detailFor(strict, 'realtimeWebSocket'), /voice\.realtime\.error/);
  } finally {
    await fixture.close();
  }
});

test('verifySpace fails realtime tunnel check when Mac availability is missing', async () => {
  const fixture = await startSpaceFixture({
    authenticated: true,
    realtimeEvent: { type: 'voice.realtime.error', error: 'mac_offline' }
  });
  try {
    const report = await verifySpace({
      spaceUrl: fixture.url,
      token: 'valid-token',
      checkRealtime: true,
      timeoutMs: 1000
    });
    assert.equal(report.ok, false);
    assert.equal(statusFor(report, 'realtimeWebSocket'), 'failed');
    assert.match(detailFor(report, 'realtimeWebSocket'), /mac_offline/);
  } finally {
    await fixture.close();
  }
});

test('verifySpace reports realtime websocket close before matching event', async () => {
  const fixture = await startSpaceFixture({
    authenticated: true,
    realtimeClose: { code: 1011, reason: 'local_realtime_rejected' }
  });
  try {
    const report = await verifySpace({
      spaceUrl: fixture.url,
      token: 'valid-token',
      checkRealtime: true,
      timeoutMs: 100
    });
    assert.equal(report.ok, false);
    assert.equal(statusFor(report, 'realtimeWebSocket'), 'failed');
    assert.match(detailFor(report, 'realtimeWebSocket'), /closed before matching event/);
    assert.match(detailFor(report, 'realtimeWebSocket'), /1011/);
    assert.match(detailFor(report, 'realtimeWebSocket'), /local_realtime_rejected/);
  } finally {
    await fixture.close();
  }
});

test('verifySpace accepts realtime event when server closes immediately after sending it', async () => {
  const fixture = await startSpaceFixture({
    authenticated: true,
    closeAfterRealtimeEvent: true
  });
  try {
    const report = await verifySpace({
      spaceUrl: fixture.url,
      token: 'valid-token',
      checkRealtime: true,
      timeoutMs: 1000
    });
    assert.equal(report.ok, true);
    assert.equal(statusFor(report, 'realtimeWebSocket'), 'passed');
  } finally {
    await fixture.close();
  }
});

function statusFor(report, id) {
  return report.checks.find((check) => check.id === id)?.status;
}

function detailFor(report, id) {
  return report.checks.find((check) => check.id === id)?.detail || '';
}

function startSpaceFixture({
  fallbackPwa = false,
  authenticated = false,
  exposeSecretMetadata = false,
  exposeSecretValue = false,
  realtimeEvent = { type: 'voice.realtime.ready' },
  realtimeClose = null,
  closeAfterRealtimeEvent = false
} = {}) {
  const wss = new WebSocketServer({ noServer: true });
  const browserSockets = new Set();
  let realtimeConnections = 0;
  const server = http.createServer((req, res) => {
    if (req.url === '/') {
      const body = fallbackPwa
        ? 'CodexMobile relay is running. Build the PWA with: npm run build'
        : '<!doctype html><html><head><title>CodexMobile</title></head><body><div id="root"></div></body></html>';
      res.writeHead(200, { 'content-type': fallbackPwa ? 'text/plain' : 'text/html' });
      res.end(body);
      return;
    }
    if (req.url === '/api/status') {
      sendJson(res, 200, {
        mode: 'relay',
        relayState: authenticated ? 'ready' : 'pairing_required',
        macConnected: authenticated,
        localStatus: { reachable: authenticated, checkedAt: new Date().toISOString() },
        ...(exposeSecretMetadata ? { secrets: { previousConfigured: true } } : {}),
        ...(exposeSecretValue ? { secrets: { current: 'should-not-leak' } } : {})
      });
      return;
    }
    if (req.url === '/ws/realtime') {
      sendJson(res, 501, { error: 'relay_realtime_http_upgrade_required' });
      return;
    }
    if (req.url === '/api/projects') {
      if (req.headers.authorization === 'Bearer valid-token') {
        sendJson(res, 200, { projects: [{ id: 'project-1', name: 'Project 1' }] });
        return;
      }
      sendJson(res, 401, { error: 'pairing_required' });
      return;
    }
    if (req.url === '/api/pair' && req.method === 'POST' && authenticated) {
      sendJson(res, 200, { token: 'valid-token' });
      return;
    }
    if (req.url === '/api/chat/send' && req.method === 'POST' && req.headers.authorization === 'Bearer valid-token') {
      sendJson(res, 202, { accepted: true, turnId: 'turn-1' });
      for (const ws of browserSockets) {
        ws.send(JSON.stringify({ type: 'status-update', status: 'running' }));
      }
      return;
    }
    sendJson(res, 404, { error: 'not_found' });
  });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    if (!['/ws', '/ws/realtime'].includes(url.pathname) || url.searchParams.get('token') !== 'valid-token') {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      browserSockets.add(ws);
      ws.on('close', () => browserSockets.delete(ws));
      if (url.pathname === '/ws/realtime') {
        realtimeConnections += 1;
        if (realtimeClose) {
          setImmediate(() => ws.close(realtimeClose.code, realtimeClose.reason));
          return;
        }
        ws.send(JSON.stringify(realtimeEvent));
        if (closeAfterRealtimeEvent) {
          setImmediate(() => ws.close(1000, 'fixture_realtime_done'));
        }
        return;
      }
      ws.send(JSON.stringify({
        type: 'connected',
        status: { mode: 'relay', relayState: 'ready', macConnected: true }
      }));
    });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        close: () => new Promise((done) => {
          for (const ws of browserSockets) ws.close();
          wss.close(() => server.close(done));
        }),
        realtimeConnections: () => realtimeConnections
      });
    });
  });
}

function sendJson(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}
