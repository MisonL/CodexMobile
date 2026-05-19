import assert from 'node:assert/strict';
import test from 'node:test';

import {
  emitCodexEvent,
  isNonFatalCodexItemError
} from '../server/codex-runner-events.js';

test('isNonFatalCodexItemError downgrades unstable feature warnings only', () => {
  assert.equal(
    isNonFatalCodexItemError('Under-development features enabled: js_repl.'),
    true
  );
  assert.equal(isNonFatalCodexItemError('unexpected status 401 Unauthorized'), false);
  assert.equal(isNonFatalCodexItemError('Codex turn failed'), false);
});

test('emitCodexEvent treats unstable feature warning as activity', () => {
  const emitted = [];
  const state = { hadAssistantText: false, failed: false, usage: null };
  emitCodexEvent({
    type: 'response_item',
    payload: {
      id: 'warning-item',
      type: 'error',
      message: 'Under-development features enabled: js_repl.'
    }
  }, 'session-1', 'turn-1', (event) => emitted.push(event), state);

  assert.equal(emitted.some((event) => event.type === 'chat-error'), false);
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].type, 'activity-update');
  assert.equal(emitted[0].status, 'completed');
  assert.equal(state.failed, false);
});

test('emitCodexEvent keeps real item errors fatal', () => {
  const emitted = [];
  const state = { hadAssistantText: false, failed: false, usage: null };
  emitCodexEvent({
    type: 'response_item',
    payload: {
      id: 'error-item',
      type: 'error',
      message: 'unexpected status 401 Unauthorized'
    }
  }, 'session-1', 'turn-1', (event) => emitted.push(event), state);

  assert.equal(emitted.some((event) => event.type === 'chat-error'), true);
  assert.equal(emitted.find((event) => event.type === 'status-update')?.status, 'failed');
});
