import assert from 'node:assert/strict';
import test from 'node:test';

import { hasActiveRelayOperationLock } from '../client/src/hooks/useRelayOperationLocks.js';

test('relay operation lock active check expires over time', () => {
  assert.equal(hasActiveRelayOperationLock({
    upload: { untilMs: Date.now() + 1000 }
  }), true);
  assert.equal(hasActiveRelayOperationLock({
    upload: { untilMs: Date.now() - 1 }
  }), false);
});
