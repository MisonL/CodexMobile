import assert from 'node:assert/strict';
import test from 'node:test';

import { createRunRegistry } from '../client/src/hooks/useRunRegistry.js';

function createRegistryHarness() {
  let runningById = { 'turn-1': true };
  let messages = [
    {
      id: 'activity-1',
      role: 'activity',
      status: 'running',
      turnId: 'turn-1'
    }
  ];
  const app = {
    runningById,
    selectedSession: { id: 'session-1', turnId: 'turn-1' },
    activePollsRef: { current: new Set() },
    turnRefreshTimersRef: { current: new Map() },
    lastLocalRunAtRef: { current: 0 },
    runningByIdRef: { current: runningById },
    messages,
    setRunningById: (updater) => {
      runningById = typeof updater === 'function' ? updater(runningById) : updater;
      app.runningById = runningById;
    },
    setMessages: (updater) => {
      messages = typeof updater === 'function' ? updater(messages) : updater;
      app.messages = messages;
    }
  };
  return {
    app,
    messages: () => messages,
    runningById: () => runningById
  };
}

test('run registry clears stale running ids when status has no active runs', () => {
  const harness = createRegistryHarness();
  const registry = createRunRegistry(harness.app);

  registry.syncActiveRunsFromStatus({ activeRuns: [] });

  assert.deepEqual(harness.runningById(), {});
  assert.deepEqual(harness.app.runningByIdRef.current, {});
  assert.deepEqual(harness.messages(), []);
});

test('run registry preserves recent local runs while waiting for server status', () => {
  const harness = createRegistryHarness();
  harness.app.lastLocalRunAtRef.current = Date.now();
  const registry = createRunRegistry(harness.app);

  registry.syncActiveRunsFromStatus({ activeRuns: [] });

  assert.deepEqual(harness.runningById(), { 'turn-1': true });
  assert.equal(harness.messages().length, 1);
});
