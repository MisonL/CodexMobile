import assert from 'node:assert/strict';
import test from 'node:test';

import { mergeServerMessagesWithLocalState } from '../client/src/app-message-state.js';

test('message refresh preserves duplicate pending user messages when content match is ambiguous', () => {
  const current = [
    { id: 'local-1', role: 'user', content: 'same text', turnId: 'turn-1' },
    { id: 'local-2', role: 'user', content: 'same text', turnId: 'turn-2' }
  ];
  const serverMessages = [
    { id: 'server-1', role: 'user', content: 'same text' }
  ];

  const merged = mergeServerMessagesWithLocalState(current, serverMessages, {
    activeRuns: [{ turnId: 'turn-1' }, { turnId: 'turn-2' }]
  });

  assert.deepEqual(
    merged.map((message) => message.id),
    ['server-1', 'local-1', 'local-2']
  );
});

test('message refresh deduplicates a single pending user message by content when turn metadata is missing', () => {
  const current = [
    { id: 'local-1', role: 'user', content: 'same text', turnId: 'turn-1' }
  ];
  const serverMessages = [
    { id: 'server-1', role: 'user', content: 'same text' }
  ];

  const merged = mergeServerMessagesWithLocalState(current, serverMessages, {
    activeRuns: [{ turnId: 'turn-1' }]
  });

  assert.deepEqual(
    merged.map((message) => message.id),
    ['server-1']
  );
});

test('message refresh ignores persisted local messages when checking ambiguous content matches', () => {
  const current = [
    { id: 'persisted-1', role: 'user', content: 'same text' },
    { id: 'local-1', role: 'user', content: 'same text', turnId: 'turn-1' }
  ];
  const serverMessages = [
    { id: 'server-1', role: 'user', content: 'same text' }
  ];

  const merged = mergeServerMessagesWithLocalState(current, serverMessages, {
    activeRuns: [{ turnId: 'turn-1' }]
  });

  assert.deepEqual(
    merged.map((message) => message.id),
    ['server-1']
  );
});

test('message refresh preserves pending user messages for a different turn in the same session', () => {
  const merged = mergeServerMessagesWithLocalState(
    [
      {
        id: 'local-turn-2',
        role: 'user',
        content: 'second prompt',
        sessionId: 'session-1',
        turnId: 'turn-2'
      }
    ],
    [
      {
        id: 'server-turn-1',
        role: 'user',
        content: 'first prompt',
        sessionId: 'session-1',
        turnId: 'turn-1'
      }
    ],
    { activeRuns: [{ sessionId: 'session-1', turnId: 'turn-2' }] }
  );

  assert.deepEqual(
    merged.map((message) => message.id),
    ['server-turn-1', 'local-turn-2']
  );
});

test('message refresh drops transient local activity messages', () => {
  const merged = mergeServerMessagesWithLocalState(
    [
      {
        id: 'upload-error-1',
        role: 'activity',
        status: 'failed',
        label: '上传失败',
        content: 'upload failed',
        transient: true
      }
    ],
    [],
    { preserveLocalRuns: true }
  );

  assert.deepEqual(merged, []);
});

test('message refresh drops local activity after server assistant for the same turn', () => {
  const merged = mergeServerMessagesWithLocalState(
    [
      { id: 'activity-turn-1', role: 'activity', content: '正在思考中', turnId: 'turn-1' }
    ],
    [
      { id: 'assistant-1', role: 'assistant', content: 'done', turnId: 'turn-1' }
    ],
    { activeRuns: [{ turnId: 'turn-1' }] }
  );

  assert.deepEqual(
    merged.map((message) => message.id),
    ['assistant-1']
  );
});

test('message refresh preserves assistant preview until the same turn has a server assistant', () => {
  const merged = mergeServerMessagesWithLocalState(
    [
      {
        id: 'preview-turn-2',
        role: 'assistant',
        preview: true,
        content: 'same text',
        turnId: 'turn-2'
      }
    ],
    [
      {
        id: 'assistant-turn-1',
        role: 'assistant',
        content: 'same text',
        turnId: 'turn-1'
      }
    ],
    { activeRuns: [{ turnId: 'turn-2' }] }
  );

  assert.deepEqual(
    merged.map((message) => message.id),
    ['assistant-turn-1', 'preview-turn-2']
  );
});
