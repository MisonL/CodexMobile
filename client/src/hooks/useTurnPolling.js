import { useEffect, useRef } from 'react';
import { apiFetch } from '../api.js';
import { hasAssistantResultForTurn, upsertSessionInProject } from '../app-core-utils.js';
import { upsertAssistantMessage, upsertStatusMessage } from '../app-message-state.js';
import { mergeCompletedTurnMessages } from './turn-message-refresh.js';

const TURN_POLL_INTERVAL_MS = 1400;
const TURN_POLL_TIMEOUT_MS = 30 * 60 * 1000;

export function useTurnPolling(app, runRegistry, turnRefresh) {
  const stoppedRef = useRef(false);

  useEffect(() => {
    stoppedRef.current = false;
    return () => {
      stoppedRef.current = true;
    };
  }, []);

  function turnMatchesCurrentSelection(turnId, optimisticSessionId, realSessionId, previousSessionId) {
    const current = app.selectedSessionRef.current;
    if (!current) {
      return true;
    }
    return (
      current.id === optimisticSessionId ||
      current.id === realSessionId ||
      current.id === previousSessionId ||
      current.turnId === turnId ||
      current.draft
    );
  }

  function applyTurnSession(turn, optimisticSessionId, projectId, previousSessionId) {
    const sessionIdText = String(turn.sessionId || '');
    const realSessionId =
      sessionIdText && !sessionIdText.startsWith('draft-') && !sessionIdText.startsWith('codex-')
        ? sessionIdText
        : null;
    if (!realSessionId) {
      return null;
    }

    const currentSession = app.selectedSessionRef.current;
    const nextSession = {
      ...(currentSession || {}),
      id: realSessionId,
      projectId,
      title: currentSession?.title || '新对话',
      updatedAt: turn.completedAt || turn.updatedAt || new Date().toISOString(),
      draft: false
    };

    app.setSelectedSession((current) => {
      if (!current) {
        return nextSession;
      }
      if (!turnMatchesCurrentSelection(turn.turnId, optimisticSessionId, realSessionId, previousSessionId)) {
        return current;
      }
      return { ...current, ...nextSession };
    });
    app.setSessionsByProject((current) =>
      upsertSessionInProject(current, projectId, nextSession, previousSessionId || optimisticSessionId)
    );
    app.setMessages((current) =>
      current.map((message) =>
        message.turnId === turn.turnId ||
        message.sessionId === optimisticSessionId ||
        message.sessionId === previousSessionId
          ? { ...message, sessionId: realSessionId }
          : message
      )
    );
    return realSessionId;
  }

  const loadTurnMessages = async ({
    realSessionId,
    turnId,
    messageId,
    optimisticSessionId,
    previousSessionId,
    hadAssistantText = false
  }) => {
    if (!realSessionId) {
      return false;
    }
    const current = app.selectedSessionRef.current;
    if (
      current &&
      current.id !== realSessionId &&
      current.id !== optimisticSessionId &&
      current.id !== previousSessionId &&
      current.turnId !== turnId
    ) {
      return false;
    }
    const data = await apiFetch(`/api/sessions/${encodeURIComponent(realSessionId)}/messages?limit=120`);
    if (
      data.messages?.length &&
      hasAssistantResultForTurn(data.messages, {
        turnId,
        messageId,
        hadAssistantText,
        status: 'completed',
        allowLatestAssistantFallback: !messageId
      })
    ) {
      mergeCompletedTurnMessages({
        app,
        activeRuns: [{ turnId, sessionId: realSessionId, previousSessionId }],
        serverMessages: data.messages
      });
      return true;
    }
    return false;
  };

  const pollTurnUntilComplete = async ({ turnId, optimisticSessionId, projectId, previousSessionId }) => {
    if (stoppedRef.current || !turnId || app.activePollsRef.current.has(turnId)) {
      return;
    }
    app.activePollsRef.current.add(turnId);
    const startedAt = Date.now();
    try {
      while (Date.now() - startedAt < TURN_POLL_TIMEOUT_MS) {
        await new Promise((resolve) => window.setTimeout(resolve, TURN_POLL_INTERVAL_MS));
        if (stoppedRef.current) {
          break;
        }
        let turn = null;
        try {
          const result = await apiFetch(`/api/chat/turns/${encodeURIComponent(turnId)}`);
          turn = result.turn;
        } catch {
          continue;
        }
        if (!turn) {
          continue;
        }
        if (stoppedRef.current) {
          break;
        }

        const realSessionId = applyTurnSession(turn, optimisticSessionId, projectId, previousSessionId);
        if (turn.status === 'failed') {
          runRegistry.clearRun({ turnId, sessionId: realSessionId || optimisticSessionId, previousSessionId });
          app.setMessages((current) =>
            upsertStatusMessage(current, {
              sessionId: realSessionId || optimisticSessionId,
              turnId,
              kind: 'turn',
              status: 'failed',
              label: '任务失败',
              detail: turn.error || turn.detail || '任务失败'
            })
          );
          break;
        }
        if (turn.status === 'aborted') {
          runRegistry.clearRun({ turnId, sessionId: realSessionId || optimisticSessionId, previousSessionId });
          app.setMessages((current) =>
            upsertStatusMessage(current, {
              sessionId: realSessionId || optimisticSessionId,
              turnId,
              kind: 'turn',
              status: 'completed',
              label: '已中止'
            })
          );
          break;
        }
        if (turn.status === 'completed') {
          const terminalPayload = { sessionId: realSessionId || optimisticSessionId, turnId, previousSessionId };
          turnRefresh.markTurnCompleted({ ...terminalPayload, detail: turn.detail || '' });
          const loaded = await loadTurnMessages({
            realSessionId,
            turnId,
            messageId: turn.messageId || null,
            optimisticSessionId,
            previousSessionId,
            hadAssistantText: turn.hadAssistantText
          });
          if (loaded) {
            runRegistry.clearRun(terminalPayload);
          } else if (turn.assistantPreview) {
            app.setMessages((current) =>
              upsertAssistantMessage(current, {
                ...terminalPayload,
                preview: true,
                content: turn.assistantPreview
              })
            );
            turnRefresh.scheduleTurnRefresh({
              ...terminalPayload,
              messageId: turn.messageId || null,
              hadAssistantText: true,
              allowLatestAssistantFallback: !turn.messageId,
              usage: turn.usage || null
            });
            runRegistry.clearRun(terminalPayload);
          } else {
            turnRefresh.scheduleTurnRefresh({
              ...terminalPayload,
              messageId: turn.messageId || null,
              allowLatestAssistantFallback: !turn.messageId,
              hadAssistantText: turn.hadAssistantText || Boolean(turn.assistantPreview),
              usage: turn.usage || null
            });
          }
          break;
        }
      }
    } finally {
      app.activePollsRef.current.delete(turnId);
    }
  };

  return {
    pollTurnUntilComplete
  };
}
