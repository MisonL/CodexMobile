import { mergeServerMessagesWithLocalState } from '../app-message-state.js';

function localActiveRuns(app) {
  return Object.keys(app.runningByIdRef?.current || {}).map((key) => ({ turnId: key }));
}

export function mergeServerMessagesPreservingLocalRuns({ app, activeRuns = [], serverMessages = [] }) {
  const preserveLocalRuns = Boolean(
    app.activePollsRef.current.size ||
      app.turnRefreshTimersRef.current.size
  );
  const mergedActiveRuns = [...activeRuns, ...localActiveRuns(app)];
  app.setMessages((current) =>
    mergeServerMessagesWithLocalState(current, serverMessages, { activeRuns: mergedActiveRuns, preserveLocalRuns })
  );
}
