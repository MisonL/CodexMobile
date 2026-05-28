import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { createRelayHttpHandler } from '../server/relay-http.js';
import { createUpgradeHandler } from '../server/relay-server.js';

const RATE_LIMIT_RETRY_AFTER_SECONDS = 60;
const UPGRADE_AUTH_SETTLE_DELAY_MS = 10;

function createResponse() {
  return {
    status: 0,
    headers: {},
    body: '',
    writeHead(status, headers = {}) {
      this.status = status;
      this.headers = headers;
    },
    end(body = '') {
      this.body = String(body);
    }
  };
}

function createRequest({ url = '/api/status', headers = {} } = {}) {
  return {
    method: 'GET',
    url,
    headers,
    socket: { remoteAddress: '203.0.113.10' },
    [Symbol.asyncIterator]() {
      return {
        async next() {
          return { done: true, value: undefined };
        }
      };
    }
  };
}

function createRateLimiter() {
  return {
    calls: [],
    consume(key) {
      this.calls.push(key);
      return { allowed: false, retryAfter: RATE_LIMIT_RETRY_AFTER_SECONDS };
    }
  };
}

function createPerTokenRateLimiter() {
  return {
    seen: new Set(),
    calls: [],
    consume(key) {
      this.calls.push(key);
      if (this.seen.has(key)) {
        return { allowed: false, retryAfter: RATE_LIMIT_RETRY_AFTER_SECONDS };
      }
      this.seen.add(key);
      return { allowed: true, retryAfter: 0 };
    }
  };
}

function createValidatingRuntime(onValidate) {
  return {
    metrics: { rateLimitedTotal: 0, browserTokenRateLimitedTotal: 0, browserTokenRequestsTotal: 0 },
    hasCachedBrowserToken: () => false,
    validateBrowserToken: async (...args) => onValidate(...args),
    currentRelayStatus: () => ({ ok: true })
  };
}

async function requestStatusWithToken(handler, token) {
  const response = createResponse();
  await handler(createRequest({
    headers: { authorization: `Bearer ${token}` }
  }), response);
  return response;
}

class FakeUpgradeSocket extends EventEmitter {
  constructor() {
    super();
    this.writes = [];
    this.destroyed = false;
    this.remoteAddress = '203.0.113.10';
  }

  write(value) {
    this.writes.push(String(value));
  }

  destroy() {
    this.destroyed = true;
  }
}

test('relay status rate limits uncached browser token validation before contacting Mac', async () => {
  let validationCalls = 0;
  const res = createResponse();
  const rateLimiter = createRateLimiter();
  const handler = createRelayHttpHandler({
    clientDist: '/tmp/missing',
    maxBodyBytes: 1024,
    requestTimeoutMs: 1000,
    rateLimiter,
    runtime: {
      metrics: { rateLimitedTotal: 0, browserTokenRateLimitedTotal: 0, browserTokenRequestsTotal: 0 },
      hasCachedBrowserToken: () => false,
      validateBrowserToken: async () => {
        validationCalls += 1;
        return true;
      },
      currentRelayStatus: () => ({ ok: true })
    }
  });

  await handler(createRequest({
    headers: { authorization: 'Bearer invalid-token' }
  }), res);

  assert.equal(res.status, 429);
  assert.equal(validationCalls, 0);
  assert.deepEqual(rateLimiter.calls, ['token:203.0.113.10']);
});

test('uncached browser token validation is rate limited by client IP before token identity', async () => {
  let validationCalls = 0;
  const rateLimiter = createPerTokenRateLimiter();
  const runtime = createValidatingRuntime(async () => {
      validationCalls += 1;
      return true;
    });
  const handler = createRelayHttpHandler({
    clientDist: '/tmp/missing',
    maxBodyBytes: 1024,
    requestTimeoutMs: 1000,
    rateLimiter,
    runtime
  });

  const firstResponse = await requestStatusWithToken(handler, 'first-token');
  const secondResponse = await requestStatusWithToken(handler, 'second-token');

  assert.equal(firstResponse.status, 200);
  assert.equal(secondResponse.status, 429);
  assert.equal(validationCalls, 1);
  assert.deepEqual(rateLimiter.calls, [
    'token:203.0.113.10',
    'token:203.0.113.10'
  ]);
});

test('browser websocket upgrade rate limits token validation before contacting Mac', async () => {
  let validationCalls = 0;
  const socket = new FakeUpgradeSocket();
  const rateLimiter = createRateLimiter();
  const runtime = {
    metrics: { rateLimitedTotal: 0, browserTokenRateLimitedTotal: 0, browserTokenRequestsTotal: 0 },
    hasCachedBrowserToken: () => false,
    validateBrowserToken: async () => {
      validationCalls += 1;
      return true;
    }
  };
  const handler = createUpgradeHandler(
    runtime,
    { handleUpgrade: () => assert.fail('mac upgrade should not run') },
    { handleUpgrade: () => assert.fail('browser upgrade should not run') },
    { handleUpgrade: () => assert.fail('realtime upgrade should not run') },
    rateLimiter
  );

  handler(createRequest({ url: '/ws?token=invalid-token' }), socket, Buffer.alloc(0));

  await new Promise((resolve) => setTimeout(resolve, UPGRADE_AUTH_SETTLE_DELAY_MS));
  assert.equal(validationCalls, 0);
  assert.equal(socket.destroyed, true);
  assert.match(socket.writes.join(''), /429 Too Many Requests/);
});

test('browser websocket upgrade skips handleUpgrade if socket closes during auth', async () => {
  const socket = new FakeUpgradeSocket();
  const runtime = createValidatingRuntime(async () => {
    socket.destroy();
    return true;
  });
  const handler = createUpgradeHandler(
    runtime,
    { handleUpgrade: () => assert.fail('mac upgrade should not run') },
    { handleUpgrade: () => assert.fail('browser upgrade should not run after disconnect') },
    { handleUpgrade: () => assert.fail('realtime upgrade should not run') },
    null
  );

  handler(createRequest({ url: '/ws?token=valid-token' }), socket, Buffer.alloc(0));

  await new Promise((resolve) => setTimeout(resolve, UPGRADE_AUTH_SETTLE_DELAY_MS));
  assert.equal(socket.destroyed, true);
  assert.deepEqual(socket.writes, []);
});

test('realtime websocket upgrade skips handleUpgrade if socket closes during auth', async () => {
  const socket = new FakeUpgradeSocket();
  const runtime = createValidatingRuntime(async () => {
    socket.destroy();
    return true;
  });
  const handler = createUpgradeHandler(
    runtime,
    { handleUpgrade: () => assert.fail('mac upgrade should not run') },
    { handleUpgrade: () => assert.fail('browser upgrade should not run') },
    { handleUpgrade: () => assert.fail('realtime upgrade should not run after disconnect') },
    null
  );

  handler(createRequest({ url: '/ws/realtime?token=valid-token' }), socket, Buffer.alloc(0));

  await new Promise((resolve) => setTimeout(resolve, UPGRADE_AUTH_SETTLE_DELAY_MS));
  assert.equal(socket.destroyed, true);
  assert.deepEqual(socket.writes, []);
});

test('relay status does not mark deferred auth validation as authenticated', async () => {
  const res = createResponse();
  const handler = createRelayHttpHandler({
    clientDist: '/tmp/missing',
    maxBodyBytes: 1024,
    requestTimeoutMs: 1000,
    rateLimiter: null,
    runtime: {
      metrics: { rateLimitedTotal: 0, browserTokenRateLimitedTotal: 0, browserTokenRequestsTotal: 0 },
      hasCachedBrowserToken: () => false,
      validateBrowserToken: async () => {
        throw Object.assign(new Error('mac_offline'), { status: 503 });
      },
      currentRelayStatus: (authenticated) => ({ authenticated })
    }
  });

  await handler(createRequest({
    headers: { authorization: 'Bearer maybe-token' }
  }), res);

  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(res.body), {
    authenticated: false,
    authValidationDeferred: 'mac_offline'
  });
});
