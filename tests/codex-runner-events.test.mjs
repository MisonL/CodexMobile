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

test('emitCodexEvent forwards agent messages as assistant updates', () => {
  const emitted = [];
  const state = { hadAssistantText: false, failed: false, usage: null };
  emitCodexEvent({
    type: 'event_msg',
    payload: {
      type: 'agent_message',
      message: 'CodexMobile真实链路OK'
    }
  }, 'session-1', 'turn-1', (event) => emitted.push(event), state);

  const assistant = emitted.find((event) => event.type === 'assistant-update');
  assert.equal(state.hadAssistantText, true);
  assert.equal(assistant?.content, 'CodexMobile真实链路OK');
  assert.equal(assistant?.kind, 'agent_message');
});

test('emitCodexEvent forwards array based agent message content', () => {
  const emitted = [];
  const state = { hadAssistantText: false, failed: false, usage: null };
  emitCodexEvent({
    type: 'response_item',
    payload: {
      type: 'agent_message',
      content: [{ type: 'output_text', text: 'CodexMobile复查OK' }]
    }
  }, 'session-1', 'turn-1', (event) => emitted.push(event), state);

  const assistant = emitted.find((event) => event.type === 'assistant-update');
  assert.equal(state.hadAssistantText, true);
  assert.equal(assistant?.content, 'CodexMobile复查OK');
});

test('emitCodexEvent keeps commentary messages out of assistant updates', () => {
  const emitted = [];
  const state = { hadAssistantText: false, failed: false, usage: null };
  emitCodexEvent({
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'assistant',
      phase: 'commentary',
      content: [{ type: 'output_text', text: '正在检查链路' }]
    }
  }, 'session-1', 'turn-1', (event) => emitted.push(event), state);

  assert.equal(state.hadAssistantText, false);
  assert.equal(emitted.some((event) => event.type === 'assistant-update'), false);
  assert.equal(emitted.find((event) => event.type === 'status-update')?.label, '正在检查链路');
});
