import http from 'node:http';
import { WebSocketServer } from 'ws';
import { localFixturePort } from './relay-smoke-env.mjs';

export const generatedFixtureBytes = Buffer.alloc(2 * 1024 * 1024 + 17, 7);
export const speechFixtureBytes = Buffer.alloc(2 * 1024 * 1024 + 31, 9);

export function startLocalCodexFixture() {
  const browserSockets = new Set();
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || `127.0.0.1:${localFixturePort}`}`);
    await handleFixtureHttp(req, res, url, browserSockets);
  });
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || `127.0.0.1:${localFixturePort}`}`);
    if (!['/ws', '/ws/realtime'].includes(url.pathname) || url.searchParams.get('token') !== 'valid-token') {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      if (url.pathname === '/ws/realtime') {
        attachRealtimeFixture(ws);
        return;
      }
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

function attachRealtimeFixture(ws) {
  ws.send(JSON.stringify({ type: 'voice.realtime.ready', fixture: true }));
  ws.on('message', (raw, isBinary) => {
    if (isBinary) {
      ws.send(raw, { binary: true });
      return;
    }
    const payload = JSON.parse(raw.toString());
    if (payload.type === 'voice.test.ping') {
      ws.send(JSON.stringify({ type: 'voice.test.pong', text: payload.text }));
    }
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
  if (url.pathname === '/api/voice/speech') {
    await sendFixtureSpeech(req, res);
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

async function sendFixtureSpeech(req, res) {
  const body = JSON.parse(await readFixtureBody(req));
  if (body.text !== 'fixture speech') {
    sendFixtureJson(res, 400, { error: 'missing_speech_text' });
    return;
  }
  res.writeHead(200, {
    'content-type': 'audio/mpeg',
    'content-length': speechFixtureBytes.length,
    'cache-control': 'no-store'
  });
  res.end(speechFixtureBytes);
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
