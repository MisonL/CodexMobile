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
    assert.equal(statusFor(report, 'realtimeUnsupported'), 'passed');
    assert.equal(statusFor(report, 'unauthenticatedProjects'), 'passed');
    assert.equal(statusFor(report, 'authenticatedProjects'), 'skipped');
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
      timeoutMs: 1000,
      requireMac: true
    });
    assert.equal(report.ok, true);
    assert.equal(statusFor(report, 'pair'), 'passed');
    assert.equal(statusFor(report, 'authenticatedProjects'), 'passed');
    assert.equal(statusFor(report, 'browserWebSocket'), 'passed');
    assert.equal(statusFor(report, 'chatSend'), 'passed');
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

function startSpaceFixture({ fallbackPwa = false, authenticated = false } = {}) {
  const wss = new WebSocketServer({ noServer: true });
  const browserSockets = new Set();
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
        localStatus: { reachable: authenticated, checkedAt: new Date().toISOString() }
      });
      return;
    }
    if (req.url === '/ws/realtime') {
      sendJson(res, 501, { error: 'relay_realtime_unsupported' });
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
    if (url.pathname !== '/ws' || url.searchParams.get('token') !== 'valid-token') {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      browserSockets.add(ws);
      ws.on('close', () => browserSockets.delete(ws));
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
        })
      });
    });
  });
}

function sendJson(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}
