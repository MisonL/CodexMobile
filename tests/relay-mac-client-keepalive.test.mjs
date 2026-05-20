import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_RELAY_KEEPALIVE_MS,
  buildRelayKeepaliveUrl,
  createRelayKeepalive,
  parseRelayKeepaliveMs
} from '../scripts/relay-mac-client-keepalive.mjs';

test('buildRelayKeepaliveUrl targets the relay origin status endpoint', () => {
  assert.equal(
    buildRelayKeepaliveUrl('wss://example-space.hf.space/relay/mac'),
    'https://example-space.hf.space/api/status?keepalive=1'
  );
  assert.equal(
    buildRelayKeepaliveUrl('ws://127.0.0.1:9786/relay/mac', '/healthz'),
    'http://127.0.0.1:9786/healthz?keepalive=1'
  );
});

test('buildRelayKeepaliveUrl rejects non websocket relay URLs', () => {
  assert.throws(
    () => buildRelayKeepaliveUrl('https://example-space.hf.space/relay/mac'),
    /relay_keepalive_invalid_relay_url/
  );
});

test('buildRelayKeepaliveUrl rejects relay URLs with userinfo', () => {
  assert.throws(
    () => buildRelayKeepaliveUrl('wss://user:pass@example-space.hf.space/relay/mac'),
    /relay_keepalive_invalid_relay_url/
  );
});

test('parseRelayKeepaliveMs allows explicit zero to disable keepalive', () => {
  assert.equal(parseRelayKeepaliveMs('0', DEFAULT_RELAY_KEEPALIVE_MS), 0);
  assert.equal(parseRelayKeepaliveMs('', DEFAULT_RELAY_KEEPALIVE_MS), DEFAULT_RELAY_KEEPALIVE_MS);
});

test('parseRelayKeepaliveMs enforces a minimum active interval', () => {
  assert.equal(parseRelayKeepaliveMs('1', DEFAULT_RELAY_KEEPALIVE_MS), DEFAULT_RELAY_KEEPALIVE_MS);
  assert.equal(parseRelayKeepaliveMs('59999', DEFAULT_RELAY_KEEPALIVE_MS), DEFAULT_RELAY_KEEPALIVE_MS);
  assert.equal(parseRelayKeepaliveMs('60000', DEFAULT_RELAY_KEEPALIVE_MS), 60000);
});

test('keepalive sends an unauthenticated GET and logs success', async () => {
  const requests = [];
  const logs = [];
  const keepalive = createRelayKeepalive({
    relayUrl: 'wss://example-space.hf.space/relay/mac',
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return { ok: true, status: 200 };
    },
    logState: (state, reason) => logs.push({ state, reason })
  });

  const result = await keepalive.ping();

  assert.equal(result, true);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://example-space.hf.space/api/status?keepalive=1');
  assert.equal(requests[0].options.method, 'GET');
  assert.equal(requests[0].options.headers.authorization, undefined);
  assert.deepEqual(logs, [{ state: 'keepalive', reason: 'status=200' }]);
});

test('keepalive releases the response body after a ping', async () => {
  let canceled = false;
  const keepalive = createRelayKeepalive({
    relayUrl: 'wss://example-space.hf.space/relay/mac',
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      body: {
        cancel: async () => {
          canceled = true;
        }
      }
    })
  });

  const result = await keepalive.ping();

  assert.equal(result, true);
  assert.equal(canceled, true);
});

test('keepalive logs failures without reporting success', async () => {
  const logs = [];
  const keepalive = createRelayKeepalive({
    relayUrl: 'wss://example-space.hf.space/relay/mac',
    fetchImpl: async () => ({ ok: false, status: 503 }),
    logState: (state, reason) => logs.push({ state, reason })
  });

  const result = await keepalive.ping();

  assert.equal(result, false);
  assert.deepEqual(logs, [{ state: 'keepalive_failed', reason: 'status=503' }]);
});

test('keepalive skips overlapping timer pings', async () => {
  let tick;
  let resolveFetch;
  let fetchCalls = 0;
  const keepalive = createRelayKeepalive({
    relayUrl: 'wss://example-space.hf.space/relay/mac',
    intervalMs: 60000,
    fetchImpl: async () => {
      fetchCalls += 1;
      return new Promise((resolve) => {
        resolveFetch = () => resolve({ ok: true, status: 200 });
      });
    },
    setIntervalFn: (callback) => {
      tick = callback;
      return 1;
    }
  });

  keepalive.start();
  const firstPing = tick();
  tick();

  assert.equal(fetchCalls, 1);
  resolveFetch();
  await firstPing;
  const secondPing = tick();
  assert.equal(fetchCalls, 2);
  resolveFetch();
  await secondPing;
});

test('disabled keepalive does not schedule or ping', () => {
  let intervalCalls = 0;
  let fetchCalls = 0;
  const keepalive = createRelayKeepalive({
    relayUrl: 'wss://example-space.hf.space/relay/mac',
    intervalMs: 0,
    fetchImpl: async () => {
      fetchCalls += 1;
      return { ok: true, status: 200 };
    },
    setIntervalFn: () => {
      intervalCalls += 1;
      return 1;
    }
  });

  keepalive.start();

  assert.equal(intervalCalls, 0);
  assert.equal(fetchCalls, 0);
});
