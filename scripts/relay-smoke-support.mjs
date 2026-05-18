import WebSocket from 'ws';

export function nextBrowserEvent(ws, expectedType, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    function onMessage(raw) {
      const event = JSON.parse(raw.toString());
      if (event.type !== expectedType) {
        return;
      }
      clearTimeout(timer);
      ws.off('message', onMessage);
      resolve(event);
    }
    const timer = setTimeout(() => {
      ws.off('message', onMessage);
      reject(new Error(`timed out waiting for browser event ${expectedType}`));
    }, timeoutMs);
    ws.on('message', onMessage);
  });
}

export function expectRejectedMacSecret(relayUrl) {
  const ws = new WebSocket(relayUrl, {
    headers: {
      authorization: 'Bearer wrong-relay-secret-0123456789abcdef'
    }
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error('timed out waiting for Mac secret rejection'));
    }, 3000);
    ws.on('unexpected-response', (_req, response) => {
      clearTimeout(timer);
      if (response.statusCode === 401) {
        resolve();
      } else {
        reject(new Error(`expected 401 for invalid Mac secret, got ${response.statusCode}`));
      }
    });
    ws.on('open', () => {
      clearTimeout(timer);
      ws.close();
      reject(new Error('invalid Mac secret should not open relay socket'));
    });
    ws.on('error', () => {});
  });
}

export function connectMac({
  relayUrl,
  secret,
  reachable = true,
  delayProjects = false,
  rateLimitChat = false,
  connectorInstanceId = 'test-mac',
  deviceName = 'test-mac'
} = {}) {
  const ws = new WebSocket(relayUrl, {
    headers: {
      authorization: `Bearer ${secret}`
    }
  });
  const messages = [];
  ws.on('message', (raw) => {
    const message = JSON.parse(raw.toString());
    messages.push(message);
    if (message.type === 'ping') {
      ws.send(JSON.stringify({ type: 'pong', sentAt: message.sentAt }));
      return;
    }
    if (message.type === 'auth.validate') {
      replyAuthValidate(ws, message);
      return;
    }
    if (message.type === 'http.request') {
      replyHttpRequest(ws, message, { delayProjects, rateLimitChat });
    }
  });
  return new Promise((resolve, reject) => {
    ws.on('open', () => {
      ws.send(JSON.stringify({
        type: 'mac.hello',
        protocolVersion: 1,
        connectorInstanceId,
        deviceName,
        clientVersion: '0.1.0',
        localStatus: { reachable, checkedAt: new Date().toISOString() },
        capabilities: ['http', 'events']
      }));
    });
    ws.on('message', (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.type === 'relay.hello') {
        resolve({ ws, messages });
      }
    });
    ws.on('error', reject);
  });
}

function replyAuthValidate(ws, message) {
  const token = String(message.token || '');
  ws.send(JSON.stringify({
    type: 'auth.validate.result',
    requestId: message.requestId,
    macConnectionEpoch: message.macConnectionEpoch,
    valid: token === 'valid-token' || token.startsWith('valid-token-')
  }));
}

function replyHttpRequest(ws, message, { delayProjects = false, rateLimitChat = false } = {}) {
  const reply = () => {
    if (message.path === '/api/pair') {
      sendHttpResponse(ws, message, 200, {
        token: 'valid-token',
        device: { id: 'device-1', name: 'iPhone' }
      });
      return;
    }
    if (message.path === '/api/projects') {
      sendHttpResponse(ws, message, 200, {
        projects: [{ id: 'mac-project', name: 'Mac Project', path: '/tmp/codexmobile-relay-fixture' }]
      });
      return;
    }
    if (message.path === '/api/projects/mac-project/sessions') {
      sendHttpResponse(ws, message, 200, { sessions: [] });
      return;
    }
    if (message.path.startsWith('/api/sessions/') && message.path.endsWith('/messages?limit=120')) {
      sendHttpResponse(ws, message, 200, { messages: [] });
      return;
    }
    if (message.path === '/api/sync') {
      sendHttpResponse(ws, message, 200, { ok: true });
      return;
    }
    if (message.path === '/api/chat/send') {
      if (rateLimitChat) {
        sendHttpResponse(ws, message, 429, { error: 'relay_rate_limited', retryAfter: 20 });
        return;
      }
      sendHttpResponse(ws, message, 202, { accepted: true, turnId: 'turn-1' });
      ws.send(JSON.stringify({
        type: 'event',
        eventId: 'event-1',
        payload: { type: 'status-update', status: 'running', label: '正在思考' }
      }));
      return;
    }
    sendHttpResponse(ws, message, 404, { error: 'Not found' });
  };
  if (delayProjects && message.path === '/api/projects') {
    setTimeout(reply, 800);
  } else {
    reply();
  }
}

function sendHttpResponse(ws, message, status, body) {
  ws.send(JSON.stringify({
    type: 'http.response',
    requestId: message.requestId,
    macConnectionEpoch: message.macConnectionEpoch,
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
    bodyEncoding: 'json',
    body
  }));
}
