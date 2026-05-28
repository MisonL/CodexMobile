import assert from 'node:assert/strict';
import test from 'node:test';

import { createRelayRuntime } from '../server/relay-runtime.js';

const TEST_REQUEST_TIMEOUT_MS = 1000;
const TEST_HEARTBEAT_MS = 1000;
const TEST_TOKEN_CACHE_TTL_MS = 1000;

function createRuntime() {
  return createRelayRuntime({
    relaySecret: 'current-secret-0123456789abcdef',
    previousRelaySecret: 'previous-secret-0123456789abcde',
    requestTimeoutMs: TEST_REQUEST_TIMEOUT_MS,
    heartbeatMs: TEST_HEARTBEAT_MS,
    tokenCacheTtlMs: TEST_TOKEN_CACHE_TTL_MS
  });
}

test('relay secret validation accepts current and previous secrets only', () => {
  const runtime = createRuntime();

  assert.equal(runtime.isValidRelaySecret('current-secret-0123456789abcdef'), true);
  assert.equal(runtime.isValidRelaySecret('previous-secret-0123456789abcde'), true);
  assert.equal(runtime.isValidRelaySecret('current-secret-0123456789abcdeg'), false);
  assert.equal(runtime.isValidRelaySecret(''), false);
});
