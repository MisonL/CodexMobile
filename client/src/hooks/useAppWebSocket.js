import { useEffect } from 'react';
import { apiFetch, getToken, websocketUrl } from '../api.js';
import { briefActivityLabel } from '../app-activity-labels.js';
import { upsertActivityMessage, upsertAssistantMessage, upsertStatusMessage } from '../app-message-state.js';
import { upsertSessionInProject } from '../app-core-utils.js';
import { DEFAULT_STATUS, connectionStateFromStatus } from '../relay-status.js';

export function useAppWebSocket(app, runRegistry, turnRefresh) {
  useEffect(() => {
    if (!app.authenticated || !getToken()) {
      app.setConnectionState('disconnected');
      return undefined;
    }

    let stopped = false;
    let reconnectTimer = null;

    const connect = () => {
      app.setConnectionState('connecting');
      const ws = new WebSocket(websocketUrl());
      app.wsRef.current = ws;

      ws.onopen = () => app.setConnectionState('connecting');
      ws.onclose = () => {
        app.setConnectionState('disconnected');
        if (!stopped) {
          reconnectTimer = window.setTimeout(connect, 1200);
        }
      };
      ws.onerror = () => app.setConnectionState('disconnected');
      ws.onmessage = (event) => handleSocketMessage(app, runRegistry, turnRefresh, event);
    };

    connect();

    return () => {
      stopped = true;
      if (reconnectTimer) {
        window.clearTimeout(reconnectTimer);
      }
      app.wsRef.current?.close();
      app.setConnectionState('disconnected');
    };
  }, [app.authenticated]);
}

function handleSocketMessage(app, runRegistry, turnRefresh, event) {
  const payload = JSON.parse(event.data);
  if (payload.type === 'connected' || payload.type === 'relay-status') {
    const { type, ...relayStatus } = payload;
    const nextStatus = payload.type === 'connected' ? payload.status || DEFAULT_STATUS : relayStatus;
    app.setStatus(nextStatus);
    app.setConnectionState(connectionStateFromStatus(nextStatus));
    runRegistry.syncActiveRunsFromStatus(nextStatus);
    return;
  }
  if (payload.type === 'chat-started') {
    runRegistry.markRun(payload);
    if (!runRegistry.payloadMatchesCurrentConversation(payload)) {
      return;
    }
    if (!app.selectedSessionRef.current && payload.sessionId) {
      app.setSelectedSession({ id: payload.sessionId, projectId: payload.projectId, title: '新对话' });
    }
    return;
  }
  if (payload.type === 'thread-started' && payload.sessionId) {
    handleThreadStarted(app, runRegistry, payload);
    return;
  }
  if (payload.type === 'message-deleted') {
    if (runRegistry.payloadMatchesCurrentConversation(payload)) {
      app.setMessages((current) => current.filter((message) => String(message.id) !== String(payload.messageId)));
    }
    return;
  }
  if (payload.type === 'user-message') {
    handleUserMessage(app, runRegistry, payload);
    return;
  }
  if (payload.type === 'assistant-update') {
    handleAssistantUpdate(app, runRegistry, payload);
    return;
  }
  if (payload.type === 'status-update') {
    handleStatusUpdate(app, runRegistry, turnRefresh, payload);
    return;
  }
  if (payload.type === 'activity-update') {
    if (payload.status === 'running' || payload.status === 'queued') {
      runRegistry.markRun(payload);
    }
    if (runRegistry.payloadMatchesCurrentConversation(payload)) {
      app.setMessages((current) => upsertActivityMessage(current, payload));
    }
    return;
  }
  if (payload.type === 'chat-complete' || payload.type === 'chat-error' || payload.type === 'chat-aborted') {
    handleTerminalChatEvent(app, runRegistry, turnRefresh, payload);
    return;
  }
  if (payload.type === 'sync-complete' && payload.projects) {
    app.setProjects(payload.projects);
    const project = app.selectedProjectRef.current;
    if (project?.id) {
      apiFetch(`/api/projects/${encodeURIComponent(project.id)}/sessions`)
        .then((data) => {
          app.setSessionsByProject((current) => ({ ...current, [project.id]: data.sessions || [] }));
        })
        .catch(() => null);
    }
  }
}

function handleThreadStarted(app, runRegistry, payload) {
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

function handleUserMessage(app, runRegistry, payload) {
  if (!runRegistry.payloadMatchesCurrentConversation(payload)) {
    return;
  }
  app.setMessages((current) => {
    const alreadyShown = current.some(
      (message) => message.role === 'user' && message.content === payload.message.content
    );
    return alreadyShown ? current : [...current, payload.message];
  });
}

function handleAssistantUpdate(app, runRegistry, payload) {
  if (!payload.content?.trim()) {
    return;
  }
  runRegistry.markRun(payload);
  if (!runRegistry.payloadMatchesCurrentConversation(payload)) {
    return;
  }
  if (payload.phase === 'commentary' || payload.kind === 'agent_message') {
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

function handleStatusUpdate(app, runRegistry, turnRefresh, payload) {
  if (payload.status === 'running' || payload.status === 'queued') {
    runRegistry.markRun(payload);
  }
  if (!runRegistry.payloadMatchesCurrentConversation(payload)) {
    return;
  }
  if (payload.kind === 'turn' && payload.status === 'completed') {
    turnRefresh.markTurnCompleted(payload);
    return;
  }
  app.setMessages((current) => upsertStatusMessage(current, payload));
}

function handleTerminalChatEvent(app, runRegistry, turnRefresh, payload) {
  if (!runRegistry.payloadMatchesCurrentConversation(payload)) {
    runRegistry.clearRun(payload);
    return;
  }
  if (payload.type === 'chat-complete') {
    turnRefresh.markTurnCompleted(payload);
    turnRefresh.scheduleTurnRefresh(payload);
    return;
  }
  runRegistry.clearRun(payload);
  if (payload.type === 'chat-error' && payload.error) {
    app.setMessages((current) =>
      upsertStatusMessage(current, {
        ...payload,
        status: 'failed',
        label: '任务失败',
        detail: payload.error
      })
    );
  } else if (payload.type === 'chat-aborted') {
    app.setMessages((current) =>
      upsertStatusMessage(current, {
        ...payload,
        status: 'completed',
        label: '已中止'
      })
    );
  }
}
