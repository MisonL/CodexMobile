import { apiFetch } from '../api.js';
import {
  DEFAULT_REASONING_EFFORT,
  createClientTurnId,
  createDraftSession,
  isDraftSession,
  titleFromFirstMessage,
  upsertSessionInProject
} from '../app-core-utils.js';
import { upsertStatusMessage } from '../app-message-state.js';

export function useChatActions(app, runRegistry, turnPolling, rememberRelayOperationLock) {
  function restoreVoiceTextToInput(text) {
    const value = String(text || '').trim();
    if (!value) {
      return;
    }
    app.setInput((current) => {
      const base = String(current || '').trimEnd();
      if (!base) {
        return value;
      }
      if (base.includes(value)) {
        return current;
      }
      return `${base}\n${value}`;
    });
  }

  async function submitCodexMessage({ message, attachmentsForTurn = [], clearComposer = false, restoreTextOnError = false }) {
    const project = app.selectedProject || app.selectedProjectRef.current;
    const selectedAttachments = Array.isArray(attachmentsForTurn) ? attachmentsForTurn : [];
    const displayMessage = String(message || '').trim() || (selectedAttachments.length ? '请查看附件。' : '');
    if ((!displayMessage && !selectedAttachments.length) || !project) {
      if (restoreTextOnError && displayMessage) {
        restoreVoiceTextToInput(displayMessage);
      }
      throw new Error(project ? 'message or attachments are required' : '请先选择项目');
    }

    let sessionForTurn = app.selectedSession;
    if (!sessionForTurn) {
      sessionForTurn = createDraftSession(project);
      app.setSelectedSession(sessionForTurn);
      app.setExpandedProjectIds((current) => ({ ...current, [project.id]: true }));
      app.setSessionsByProject((current) => upsertSessionInProject(current, project.id, sessionForTurn));
    }

    const turnId = createClientTurnId();
    const draftSessionId = isDraftSession(sessionForTurn) ? sessionForTurn.id : null;
    const outgoingSessionId = draftSessionId ? null : sessionForTurn?.id || null;
    const optimisticSessionId = draftSessionId || outgoingSessionId || turnId;
    const initialTitle = draftSessionId && !sessionForTurn.titleLocked ? titleFromFirstMessage(displayMessage) : null;

    if (clearComposer) {
      app.setInput('');
      app.setAttachments([]);
    }

    runRegistry.markRun({ turnId, sessionId: optimisticSessionId, previousSessionId: draftSessionId || outgoingSessionId });
    app.setSelectedSession((current) =>
      current?.id === sessionForTurn?.id
        ? { ...current, turnId, ...(initialTitle ? { title: initialTitle, titleLocked: true } : {}) }
        : current
    );
    if (initialTitle) {
      app.setSessionsByProject((current) => ({
        ...current,
        [project.id]: (current[project.id] || []).map((item) =>
          item.id === sessionForTurn.id ? { ...item, title: initialTitle, titleLocked: true } : item
        )
      }));
    }
    app.setMessages((current) =>
      upsertStatusMessage(
        [
          ...current,
          {
            id: `local-${Date.now()}`,
            role: 'user',
            content: displayMessage,
            timestamp: new Date().toISOString(),
            sessionId: optimisticSessionId,
            turnId
          }
        ],
        {
          sessionId: optimisticSessionId,
          turnId,
          kind: 'reasoning',
          status: 'running',
          label: '正在思考中',
          timestamp: new Date().toISOString()
        }
      )
    );

    try {
      const result = await apiFetch('/api/chat/send', {
        method: 'POST',
        body: {
          projectId: project.id,
          sessionId: outgoingSessionId,
          draftSessionId,
          clientTurnId: turnId,
          message: displayMessage,
          permissionMode: app.permissionMode,
          model: app.selectedModel || app.status.model,
          reasoningEffort: app.selectedReasoningEffort || app.status.reasoningEffort || DEFAULT_REASONING_EFFORT,
          attachments: selectedAttachments
        }
      });
      turnPolling.pollTurnUntilComplete({
        turnId: result.turnId || turnId,
        optimisticSessionId,
        projectId: project.id,
        previousSessionId: draftSessionId || outgoingSessionId
      });
      return { turnId: result.turnId || turnId, optimisticSessionId, projectId: project.id };
    } catch (error) {
      rememberRelayOperationLock('send', error);
      runRegistry.clearRun({ turnId, sessionId: optimisticSessionId, previousSessionId: draftSessionId || outgoingSessionId });
      if (clearComposer) {
        app.setAttachments(selectedAttachments);
      }
      if (restoreTextOnError) {
        restoreVoiceTextToInput(displayMessage);
      }
      app.setMessages((current) =>
        upsertStatusMessage(current, {
          sessionId: optimisticSessionId,
          turnId,
          kind: 'turn',
          status: 'failed',
          label: '发送失败',
          detail: error.message,
          timestamp: new Date().toISOString()
        })
      );
      throw error;
    }
  }

  const handleSubmit = async () => {
    const message = app.input.trim();
    if ((!message && !app.attachments.length) || !app.selectedProject) {
      return;
    }
    try {
      await submitCodexMessage({
        message,
        attachmentsForTurn: app.attachments,
        clearComposer: true,
        restoreTextOnError: true
      });
    } catch {
      // submitCodexMessage already reflects the failure in the chat UI.
    }
  };

  async function handleVoiceSubmit(transcript) {
    const message = String(transcript || '').trim();
    if (!message) {
      throw new Error('没有识别到文字');
    }
    return submitCodexMessage({ message, attachmentsForTurn: [], restoreTextOnError: true });
  }

  async function handleAbort() {
    const abortId = app.selectedSessionRef.current?.id || app.selectedSessionRef.current?.turnId || Object.keys(app.runningById)[0];
    if (!abortId) {
      return;
    }
    await apiFetch('/api/chat/abort', {
      method: 'POST',
      body: { sessionId: abortId, turnId: app.selectedSessionRef.current?.turnId || null }
    }).catch(() => null);
    runRegistry.clearRun({ sessionId: abortId, turnId: app.selectedSessionRef.current?.turnId || null });
  }

  return {
    submitCodexMessage,
    handleSubmit,
    handleVoiceSubmit,
    handleAbort
  };
}
