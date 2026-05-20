import { hasRunningKey, payloadRunKeys, selectedRunKeys } from '../app-core-utils.js';

export function useRunRegistry(app) {
  const running =
    hasRunningKey(app.runningById, selectedRunKeys(app.selectedSession)) ||
    app.messages.some(
      (message) => message.role === 'activity' && (message.status === 'running' || message.status === 'queued')
    );

  function markRun(payload) {
    const keys = payloadRunKeys(payload);
    if (!keys.length) {
      return;
    }
    app.lastLocalRunAtRef.current = Date.now();
    app.setRunningById((current) => {
      const next = { ...current };
      for (const key of keys) {
        next[key] = true;
      }
      app.runningByIdRef.current = next;
      return next;
    });
  }

  function clearRun(payload) {
    const keys = payloadRunKeys(payload);
    if (!keys.length) {
      return;
    }
    app.setRunningById((current) => {
      const next = { ...current };
      for (const key of keys) {
        delete next[key];
      }
      app.runningByIdRef.current = next;
      return next;
    });
  }

  function syncActiveRunsFromStatus(nextStatus) {
    const activeRuns = Array.isArray(nextStatus?.activeRuns) ? nextStatus.activeRuns : [];
    if (!activeRuns.length) {
      app.setMessages((current) => {
        const hasRecentLocalRun = Date.now() - app.lastLocalRunAtRef.current < 15000;
        if (app.activePollsRef.current.size || app.turnRefreshTimersRef.current.size || hasRecentLocalRun) {
          return current;
        }
        return current.filter(
          (message) => !(message.role === 'activity' && (message.status === 'running' || message.status === 'queued'))
        );
      });
      return;
    }

    const nextRunning = {};
    for (const run of activeRuns) {
      for (const key of payloadRunKeys(run)) {
        nextRunning[key] = true;
      }
    }
    const shouldPreserveLocalRuns =
      app.activePollsRef.current.size > 0 ||
      app.turnRefreshTimersRef.current.size > 0 ||
      Date.now() - app.lastLocalRunAtRef.current < 15000;
    app.setRunningById((current) => {
      const next = shouldPreserveLocalRuns ? { ...current, ...nextRunning } : nextRunning;
      app.runningByIdRef.current = next;
      return next;
    });
  }

  function payloadMatchesCurrentConversation(payload) {
    const current = app.selectedSessionRef.current;
    if (!current) {
      return true;
    }
    const keys = payloadRunKeys(payload);
    return keys.includes(current.id) || keys.includes(current.turnId);
  }

  return {
    running,
    markRun,
    clearRun,
    syncActiveRunsFromStatus,
    payloadMatchesCurrentConversation
  };
}
