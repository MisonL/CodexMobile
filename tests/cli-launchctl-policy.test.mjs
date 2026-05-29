import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isAlreadyBootstrapped,
  isNotBootstrapped
} from '../cli/launchctl-policy.mjs';

test('isAlreadyBootstrapped matches known duplicate bootstrap messages', () => {
  assert.equal(isAlreadyBootstrapped({ stderr: 'service already loaded' }), true);
  assert.equal(isAlreadyBootstrapped({ stderr: 'bootstrap failed: 37: operation already in progress' }), true);
});

test('isAlreadyBootstrapped does not hide unrelated launchctl failures', () => {
  assert.equal(isAlreadyBootstrapped({ code: 5, stderr: 'permission denied' }), false);
  assert.equal(isAlreadyBootstrapped({ stderr: 'Bootstrap failed: 5: Input/output error' }), false);
  assert.equal(isAlreadyBootstrapped({ stderr: 'syntax error in plist' }), false);
});

test('isNotBootstrapped matches missing service bootout messages', () => {
  assert.equal(isNotBootstrapped({ stderr: 'No such process' }), true);
  assert.equal(isNotBootstrapped({ stderr: 'Could not find service' }), true);
  assert.equal(isNotBootstrapped({ stderr: 'Input/output error' }), false);
});
