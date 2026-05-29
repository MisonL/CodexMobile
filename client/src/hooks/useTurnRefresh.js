import { useEffect } from 'react';
import { hasAssistantResultForTurn } from '../app-core-utils.js';
import {
  removeActivityMessagesForTurn,
  upsertStatusMessage
} from '../app-message-state.js';
import { apiFetch } from '../api.js';
import { mergeServerMessagesPreservingLocalRuns } from './turn-message-refresh.js';

export function useTurnRefresh(app, runRegistry) {
  function clearTurnRefreshTimer(turnId) {
    if (!turnId) {
      return;
    }
    const timer = app.turnRefreshTimersRef.current.get(turnId);
    if (timer) {
      window.clearTimeout(timer);
      app.turnRefreshTimersRef.current.delete(turnId);
    }
  }

  const refreshMessagesForPayload = async (payload) => {
    if (!payload?.sessionId || !runRegistry.payloadMatchesCurrentConversation(payload)) {
      return false;
    }
    try {
      const data = await apiFetch(`/api/sessions/${encodeURIComponent(payload.sessionId)}/messages?limit=120`);
      if (data.messages?.length && hasAssistantResultForTurn(data.messages, payload)) {
        mergeServerMessagesPreservingLocalRuns({
          app,
          activeRuns: [payload],
          serverMessages: data.messages
        });
        return true;
      }
    } catch {
      return false;
    }
    return false;
  };

  const finalizeTurnWithoutAssistant = (payload) => {
    if (!payload?.turnId) {
      return;
    }
    clearTurnRefreshTimer(payload.turnId);
    app.setMessages((current) =>
      upsertStatusMessage(current, {
        ...payload,
        kind: 'turn',
        status: 'completed',
        label: '任务已完成',
        detail: payload.error || payload.detail || ''
      })
    );
    runRegistry.clearRun(payload);
  };

  const markTurnCompleted = (payload, detail = '结果同步中') => {
    if (!payload?.turnId) {
      return;
    }
    app.setMessages((current) => {
      if (hasAssistantResultForTurn(current, payload)) {
        return removeActivityMessagesForTurn(current, payload);
      }
      return upsertStatusMessage(current, {
        ...payload,
        kind: 'turn',
        status: 'running',
        label: '正在思考中',
        detail
      });
    });
  };

  function scheduleTurnRefresh(payload, attempt = 0) {
    const turnId = payload?.turnId;
    if (!turnId || !payload?.sessionId || !runRegistry.payloadMatchesCurrentConversation(payload)) {
      return;
    }
    clearTurnRefreshTimer(turnId);
    const delays = [300, 800, 1500, 2500, 4000, 6500, 10000, 15000, 22000, 30000, 30000];
    const delay = delays[attempt];
    if (delay === undefined) {
      finalizeTurnWithoutAssistant(payload);
      return;
    }

    const timer = window.setTimeout(async () => {
      if (!runRegistry.payloadMatchesCurrentConversation(payload)) {
        return;
      }
      const loaded = await refreshMessagesForPayload(payload);
      if (loaded) {
        clearTurnRefreshTimer(turnId);
        runRegistry.clearRun(payload);
        return;
      }
      scheduleTurnRefresh(payload, attempt + 1);
    }, delay);
    app.turnRefreshTimersRef.current.set(turnId, timer);
  }

  useEffect(
    () => () => {
      for (const timer of app.turnRefreshTimersRef.current.values()) {
        window.clearTimeout(timer);
      }
      app.turnRefreshTimersRef.current.clear();
    },
    [app.turnRefreshTimersRef]
  );

  return {
    clearTurnRefreshTimer,
    markTurnCompleted,
    scheduleTurnRefresh
  };
}
