import assert from 'node:assert/strict';
import test from 'node:test';

import { mergeCompletedTurnMessages } from '../client/src/hooks/turn-message-refresh.js';

function createRefreshApp(messages, { activePolls = [], turnRefreshTimers = [] } = {}) {
  return {
    activePollsRef: { current: new Set(activePolls) },
    turnRefreshTimersRef: { current: new Map(turnRefreshTimers.map((id) => [id, true])) },
    runningByIdRef: { current: {} },
    messages,
    setMessages(updater) {
      this.messages = typeof updater === 'function' ? updater(this.messages) : updater;
    }
  };
}

test('completed turn refresh preserves queued local messages for another turn', () => {
  const app = createRefreshApp(
    [
      {
        id: 'local-queued-user',
        role: 'user',
        content: 'second prompt',
        sessionId: 'session-1',
        turnId: 'turn-2'
      },
      {
        id: 'queued-activity',
        role: 'activity',
        content: '已加入队列',
        sessionId: 'session-1',
        turnId: 'turn-2',
        status: 'queued'
      }
    ]
  );
  app.runningByIdRef.current = { 'turn-2': true };

  mergeCompletedTurnMessages({
    app,
    activeRuns: [{ sessionId: 'session-1', turnId: 'turn-1' }],
    serverMessages: [
      {
        id: 'server-user-1',
        role: 'user',
        content: 'first prompt',
        sessionId: 'session-1',
        turnId: 'turn-1'
      },
      {
        id: 'server-assistant-1',
        role: 'assistant',
        content: 'first answer',
        sessionId: 'session-1',
        turnId: 'turn-1'
      }
    ]
  });

  assert.deepEqual(
    app.messages.map((message) => message.id),
    ['server-user-1', 'server-assistant-1', 'local-queued-user', 'queued-activity']
  );
});
