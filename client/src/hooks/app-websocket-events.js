import { apiFetch } from '../api.js';
import { briefActivityLabel } from '../app-activity-labels.js';
import {
  upsertActivityMessage,
  upsertAssistantMessage,
  upsertStatusMessage
} from '../app-message-state.js';
import { upsertSessionInProject } from '../app-core-utils.js';
import { DEFAULT_STATUS, canUseAppShellFromStatus, connectionStateFromStatus } from '../relay-status.js';

const MESSAGE_HANDLERS = {
  connected: handleConnectionStatus,
  'relay-status': handleConnectionStatus,
  'chat-started': handleChatStarted,
  'thread-started': handleThreadStarted,
  'message-deleted': handleMessageDeleted,
  'user-message': handleUserMessage,
  'assistant-update': handleAssistantUpdate,
  'status-update': handleStatusUpdate,
  'activity-update': handleActivityUpdate,
  'chat-complete': handleTerminalChatEvent,
  'chat-error': handleTerminalChatEvent,
  'chat-aborted': handleTerminalChatEvent,
  'sync-complete': handleSyncComplete
};

export function handleSocketMessage({ app, runRegistry, turnRefresh, event }) {
  let payload;
  try {
    payload = JSON.parse(event.data);
  } catch {
    console.error('Invalid websocket payload');
    return;
  }

  const handler = MESSAGE_HANDLERS[payload.type];
  if (handler) {
    handler({ app, runRegistry, turnRefresh, payload });
  }
}

function handleConnectionStatus({ app, runRegistry, payload }) {
  const { type, ...relayStatus } = payload;
  const nextStatus = payload.type === 'connected' ? payload.status || DEFAULT_STATUS : relayStatus;
  app.setStatus(nextStatus);
  app.setAuthenticated(canUseAppShellFromStatus(nextStatus));
  app.setConnectionState(connectionStateFromStatus(nextStatus));
  runRegistry.syncActiveRunsFromStatus(nextStatus);
}

function handleChatStarted({ app, runRegistry, payload }) {
  runRegistry.markRun(payload);
  if (!runRegistry.payloadMatchesCurrentConversation(payload)) {
    return;
  }
  if (!app.selectedSessionRef.current && payload.sessionId) {
    app.setSelectedSession({ id: payload.sessionId, projectId: payload.projectId, title: '新对话' });
  }
}

function handleMessageDeleted({ app, runRegistry, payload }) {
  if (runRegistry.payloadMatchesCurrentConversation(payload)) {
    app.setMessages((current) => current.filter((message) => String(message.id) !== String(payload.messageId)));
  }
}

function handleActivityUpdate({ app, runRegistry, payload }) {
  if (payload.status === 'running' || payload.status === 'queued') {
    runRegistry.markRun(payload);
  }
  if (runRegistry.payloadMatchesCurrentConversation(payload)) {
    app.setMessages((current) => upsertActivityMessage(current, payload));
  }
}

function handleSyncComplete({ app, payload }) {
  if (payload.projects) {
    app.setProjects(payload.projects);
    const project = app.selectedProjectRef.current;
    if (project?.id) {
      const projectId = project.id;
      const fetchSessions = app.apiFetch || apiFetch;
      fetchSessions(`/api/projects/${encodeURIComponent(project.id)}/sessions`)
        .then((data) => {
          if (app.selectedProjectRef.current?.id !== projectId) {
            return;
          }
          app.setSessionsByProject((current) => ({ ...current, [projectId]: data.sessions || [] }));
        })
        .catch((error) => {
          console.warn(`[websocket] sync session refresh failed project=${projectId}:`, error.message || error);
        });
    }
  }
}

function handleThreadStarted({ app, runRegistry, payload }) {
  if (!payload.sessionId) {
    return;
  }
  const projectId = payload.projectId || app.selectedProjectRef.current?.id || app.selectedSessionRef.current?.projectId;
  const currentSession = app.selectedSessionRef.current;
  const nextSession = {
    ...(currentSession || {}),
    id: payload.sessionId,
    projectId,
    title: currentSession?.title || '新对话',
    updatedAt: new Date().toISOString(),
    draft: false
  };
  runRegistry.markRun(payload);
  app.setSelectedSession((current) => {
    if (!current) {
      return nextSession;
    }
    const shouldReplace =
      current.id === payload.previousSessionId ||
      current.id === payload.sessionId ||
      current.turnId === payload.turnId ||
      (current.draft && current.projectId === projectId);
    return shouldReplace ? { ...current, ...nextSession } : current;
  });
  app.setSessionsByProject((current) =>
    upsertSessionInProject(current, projectId, nextSession, payload.previousSessionId)
  );
  app.setMessages((current) =>
    current.map((message) =>
      message.turnId === payload.turnId || message.sessionId === payload.previousSessionId
        ? { ...message, sessionId: payload.sessionId }
        : message
    )
  );
}

function handleUserMessage({ app, runRegistry, payload }) {
  if (!runRegistry.payloadMatchesCurrentConversation(payload)) {
    return;
  }
  app.setMessages((current) => {
    const incoming = {
      ...payload.message,
      sessionId: payload.message?.sessionId || payload.sessionId || null,
      turnId: payload.message?.turnId || payload.turnId || null
    };
    const alreadyShown = current.some((message) => {
      if (message.role !== 'user') {
        return false;
      }
      if (incoming.id && message.id === incoming.id) {
        return true;
      }
      return Boolean(incoming.turnId && message.turnId === incoming.turnId);
    });
    return alreadyShown ? current : [...current, incoming];
  });
}

function handleAssistantUpdate({ app, runRegistry, payload }) {
  if (!payload.content?.trim()) {
    return;
  }
  runRegistry.markRun(payload);
  if (!runRegistry.payloadMatchesCurrentConversation(payload)) {
    return;
  }
  if (payload.phase === 'commentary') {
    app.setMessages((current) =>
      upsertStatusMessage(current, {
        ...payload,
        kind: payload.kind || 'agent_message',
        label: briefActivityLabel(payload.content),
        status: payload.status || 'running'
      })
    );
    return;
  }
  if (payload.kind === 'agent_message') {
    app.setMessages((current) => upsertAssistantMessage(current, payload));
    return;
  }
  if (!payload.done) {
    app.setMessages((current) =>
      upsertStatusMessage(current, {
        ...payload,
        kind: payload.kind || 'message',
        label: '正在整理回复',
        status: payload.status || 'running'
      })
    );
    return;
  }
  app.setMessages((current) => upsertAssistantMessage(current, payload));
}

function handleStatusUpdate({ app, runRegistry, turnRefresh, payload }) {
  if (payload.status === 'running' || payload.status === 'queued') {
    runRegistry.markRun(payload);
  }
  if (!runRegistry.payloadMatchesCurrentConversation(payload)) {
    return;
  }
  if (payload.kind === 'turn' && payload.status === 'completed') {
    turnRefresh.markTurnCompleted({
      ...payload,
      allowLatestAssistantFallback: !payload.messageId
    });
    return;
  }
  app.setMessages((current) => upsertStatusMessage(current, payload));
}

function handleTerminalChatEvent({ app, runRegistry, turnRefresh, payload }) {
  if (!runRegistry.payloadMatchesCurrentConversation(payload)) {
    runRegistry.clearRun(payload);
    return;
  }
  if (payload.type === 'chat-complete') {
    const terminalPayload = {
      ...payload,
      status: 'completed',
      allowLatestAssistantFallback: !payload.messageId
    };
    turnRefresh.markTurnCompleted(terminalPayload);
    turnRefresh.scheduleTurnRefresh(terminalPayload);
    return;
  }
  runRegistry.clearRun(payload);
  if (payload.type === 'chat-error' && payload.error) {
    app.setMessages((current) =>
      upsertStatusMessage(current, {
        ...payload,
        kind: 'turn',
        status: 'failed',
        label: '任务失败',
        detail: payload.error
      })
    );
  } else if (payload.type === 'chat-aborted') {
    app.setMessages((current) =>
      upsertStatusMessage(current, {
        ...payload,
        kind: 'turn',
        status: 'completed',
        label: '已中止'
      })
    );
  }
}
