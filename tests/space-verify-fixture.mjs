import http from 'node:http';
import { WebSocketServer } from 'ws';

export function statusFor(report, id) {
  return report.checks.find((check) => check.id === id)?.status;
}

export function detailFor(report, id) {
  return report.checks.find((check) => check.id === id)?.detail || '';
}

export function startSpaceFixture({
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
