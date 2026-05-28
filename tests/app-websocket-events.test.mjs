import assert from 'node:assert/strict';
import test from 'node:test';

import { handleSocketMessage } from '../client/src/hooks/app-websocket-events.js';

function createSocketEventApp() {
  let messages = [];
  let sessionsByProject = {};
  return {
    app: {
      selectedProjectRef: { current: null },
      setMessages: (updater) => {
        messages = typeof updater === 'function' ? updater(messages) : updater;
      },
      setProjects: () => {},
      setSessionsByProject: (updater) => {
        sessionsByProject = typeof updater === 'function' ? updater(sessionsByProject) : updater;
      }
    },
    messages: () => messages,
    sessionsByProject: () => sessionsByProject
  };
}

function socketEvent(payload) {
  return { data: JSON.stringify(payload) };
}

const matchingRunRegistry = {
  markRun: () => {},
  payloadMatchesCurrentConversation: () => true,
  clearRun: () => {},
  syncActiveRunsFromStatus: () => {}
};

test('agent message websocket updates render as assistant messages', () => {
  const harness = createSocketEventApp();
  handleSocketMessage({
    app: harness.app,
    runRegistry: matchingRunRegistry,
    turnRefresh: {},
    event: socketEvent({
      type: 'assistant-update',
      sessionId: 'session-1',
      turnId: 'turn-1',
      messageId: 'agent-message-1',
      kind: 'agent_message',
      phase: 'final_answer',
      content: 'CodexMobile真实链路OK',
      done: false
    })
  });

  assert.deepEqual(harness.messages(), [
    {
      id: 'agent-message-1',
      role: 'assistant',
      content: 'CodexMobile真实链路OK',
      timestamp: harness.messages()[0].timestamp,
      turnId: 'turn-1',
      sessionId: 'session-1',
      kind: 'agent_message',
      preview: undefined
    }
  ]);
});

test('commentary websocket updates remain activity messages', () => {
  const harness = createSocketEventApp();
  handleSocketMessage({
    app: harness.app,
    runRegistry: matchingRunRegistry,
    turnRefresh: {},
    event: socketEvent({
      type: 'assistant-update',
      sessionId: 'session-1',
      turnId: 'turn-1',
      messageId: 'commentary-1',
      kind: 'agent_message',
      phase: 'commentary',
      content: '正在检查链路',
      done: false
    })
  });

  assert.equal(harness.messages().length, 1);
  assert.equal(harness.messages()[0].role, 'activity');
  assert.equal(harness.messages()[0].kind, 'agent_message');
});

test('user websocket messages dedupe by id or turn instead of text only', () => {
  const harness = createSocketEventApp();
  for (const turnId of ['turn-1', 'turn-2']) {
    handleSocketMessage({
      app: harness.app,
      runRegistry: matchingRunRegistry,
      turnRefresh: {},
      event: socketEvent({
        type: 'user-message',
        sessionId: 'session-1',
        turnId,
        message: {
          id: `user-${turnId}`,
          role: 'user',
          content: 'same text'
        }
      })
    });
  }

  assert.deepEqual(
    harness.messages().map((message) => [message.id, message.turnId, message.content]),
    [
      ['user-turn-1', 'turn-1', 'same text'],
      ['user-turn-2', 'turn-2', 'same text']
    ]
  );
});

test('sync complete session refresh ignores stale project selection', async () => {
  const harness = createSocketEventApp();
  harness.app.selectedProjectRef.current = { id: 'project-1' };
  let resolveFetch;
  const fetchDone = new Promise((resolve) => {
    resolveFetch = resolve;
  });

  handleSocketMessage({
    app: {
      ...harness.app,
      apiFetch: async () => {
        await fetchDone;
        return { sessions: [{ id: 'session-1' }] };
      }
    },
    runRegistry: matchingRunRegistry,
    turnRefresh: {},
    event: socketEvent({
      type: 'sync-complete',
      projects: [{ id: 'project-1' }]
    })
  });

  harness.app.selectedProjectRef.current = { id: 'project-2' };
  resolveFetch();
  await Promise.resolve();
  await Promise.resolve();

  assert.deepEqual(harness.sessionsByProject(), {});
});

test('sync complete session refresh writes sessions for current project', async () => {
  const harness = createSocketEventApp();
  harness.app.selectedProjectRef.current = { id: 'project-1' };

  handleSocketMessage({
    app: {
      ...harness.app,
      apiFetch: async () => ({ sessions: [{ id: 'session-1' }] })
    },
    runRegistry: matchingRunRegistry,
    turnRefresh: {},
    event: socketEvent({
      type: 'sync-complete',
      projects: [{ id: 'project-1' }]
    })
  });

  await Promise.resolve();
  await Promise.resolve();

  assert.deepEqual(harness.sessionsByProject(), {
    'project-1': [{ id: 'session-1' }]
  });
});
