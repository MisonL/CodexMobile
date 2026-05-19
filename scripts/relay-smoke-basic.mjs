import {
  ApiError,
  rateLimitLockFromError,
  remainingLockSeconds
} from '../client/src/api.js';
import { buildLocalTargetUrl } from '../server/relay-protocol.js';
import {
  nextReconnectDelay,
  shouldResetReconnectDelay
} from './relay-mac-client-reconnect.mjs';
import { fail } from './relay-smoke-env.mjs';

export function runBasicRelayAssertions() {
  expectInvalidForwardPathRejected();
  verifyRateLimitRetryAfterHelpers();
  verifyConnectorReconnectPolicy();
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
