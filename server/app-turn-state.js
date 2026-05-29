import crypto from 'node:crypto';
import { refreshCodexCache } from './codex-data.js';
import { renameSessionNameIndexRow } from './codex-data-parser.js';
import { getActiveRuns, runCodexTurn } from './codex-runner.js';
import { registerMobileSession } from './mobile-session-index.js';
import { broadcast } from './app-sockets.js';
import { syncCodexAppThreadMetadata } from './codex-app-state-sync.js';


export const recentTurns = new Map();
export const conversationQueues = new Map();
export const sessionQueueKeys = new Map();
export const recentImagePromptsByProject = new Map();
export const activeImageRuns = new Map();
export let feishuAuthState = { token: null, pendingStates: {} };
export const MAX_RECENT_TURNS = 80;

export function rememberTurn(turnId, patch) {
  if (!turnId) {
    return null;
  }
  const existing = recentTurns.get(turnId) || { turnId, createdAt: new Date().toISOString() };
  const next = {
    ...existing,
    ...patch,
    turnId,
    updatedAt: new Date().toISOString()
  };
  recentTurns.set(turnId, next);

  if (recentTurns.size > MAX_RECENT_TURNS) {
    const oldest = [...recentTurns.entries()].sort(
      (a, b) => new Date(a[1].updatedAt || a[1].createdAt || 0) - new Date(b[1].updatedAt || b[1].createdAt || 0)
    )[0]?.[0];
    if (oldest) {
      recentTurns.delete(oldest);
    }
  }
  return next;
}

export function rememberTurnEvent(payload) {
  if (!payload?.turnId) {
    return;
  }

  const patch = {
    projectId: payload.projectId,
    sessionId: payload.sessionId || undefined,
    previousSessionId: payload.previousSessionId || undefined
  };

  if (payload.type === 'chat-started') {
    patch.status = 'running';
    patch.startedAt = payload.startedAt || new Date().toISOString();
    patch.label = '正在思考';
  } else if (payload.type === 'thread-started') {
    patch.status = 'running';
    patch.label = '正在思考';
  } else if (payload.type === 'status-update') {
    patch.status = payload.status || 'running';
    patch.kind = payload.kind || undefined;
    patch.label = payload.label || undefined;
    patch.detail = payload.detail || undefined;
  } else if (payload.type === 'assistant-update') {
    patch.status = 'running';
    patch.hadAssistantText = true;
    patch.assistantPreview = payload.content || '';
    patch.messageId = payload.messageId || undefined;
    patch.label = '正在回复';
  } else if (payload.type === 'chat-complete') {
    patch.status = 'completed';
    patch.completedAt = payload.completedAt || new Date().toISOString();
    patch.hadAssistantText = Boolean(payload.hadAssistantText);
    patch.usage = payload.usage || null;
    patch.label = '任务已完成';
  } else if (payload.type === 'chat-error') {
    patch.status = 'failed';
    patch.error = payload.error || '任务失败';
    patch.label = '任务失败';
  } else if (payload.type === 'chat-aborted') {
    patch.status = 'aborted';
    patch.label = '已中止';
  } else {
    return;
  }

  rememberTurn(payload.turnId, patch);
}

export function getActiveImageRuns() {
  return [...activeImageRuns.values()].map((run) => ({
    sessionId: run.sessionId,
    previousSessionId: run.previousSessionId,
    startedAt: run.startedAt,
    status: run.status,
    turnId: run.turnId,
    kind: 'image_generation_call',
    label: run.label
  }));
}

export function payloadReferencesSession(payload, sessionId) {
  return [
    payload?.sessionId,
    payload?.previousSessionId,
    payload?.draftSessionId,
    payload?.selectedSessionId
  ].some((value) => value && value === sessionId);
}

export function sessionHasActiveWork(sessionId) {
  if (!sessionId) {
    return false;
  }
  const activeRuns = [...getActiveRuns(), ...getActiveImageRuns()];
  if (activeRuns.some((run) => payloadReferencesSession(run, sessionId))) {
    return true;
  }

  for (const turn of recentTurns.values()) {
    if (
      (turn.status === 'accepted' || turn.status === 'queued' || turn.status === 'running') &&
      payloadReferencesSession(turn, sessionId)
    ) {
      return true;
    }
  }

  for (const state of conversationQueues.values()) {
    if (state.running && state.sessionId === sessionId) {
      return true;
    }
    if (state.jobs.some((job) => payloadReferencesSession(job, sessionId))) {
      return true;
    }
  }

  return false;
}

export function rememberConversationAlias(queueKey, sessionId) {
  if (queueKey && sessionId) {
    sessionQueueKeys.set(sessionId, queueKey);
  }
}

export function resolveConversationKey(...ids) {
  for (const id of ids) {
    if (id && sessionQueueKeys.has(id)) {
      return sessionQueueKeys.get(id);
    }
  }
  const queueKey = ids.find(Boolean) || crypto.randomUUID();
  for (const id of ids) {
    rememberConversationAlias(queueKey, id);
  }
  return queueKey;
}

export function getConversationQueue(queueKey) {
  if (!conversationQueues.has(queueKey)) {
    conversationQueues.set(queueKey, {
      sessionId: null,
      running: false,
      jobs: []
    });
  }
  return conversationQueues.get(queueKey);
}

export function emitJobEvent(job, payload) {
  const enriched = { projectId: job.project.id, ...payload };
  rememberTurnEvent(enriched);
  broadcast(enriched);
}

export function enqueueChatJob(job) {
  const state = getConversationQueue(job.queueKey);
  rememberConversationAlias(job.queueKey, job.selectedSessionId);
  rememberConversationAlias(job.queueKey, job.draftSessionId);

  const queued = state.running || state.jobs.length > 0;
  state.jobs.push(job);

  if (queued) {
    const sessionId = state.sessionId || job.selectedSessionId || job.draftSessionId;
    rememberTurn(job.turnId, {
      status: 'queued',
      label: '已加入队列',
      sessionId: sessionId || null
    });
    broadcast({
      type: 'status-update',
      projectId: job.project.id,
      sessionId,
      turnId: job.turnId,
      kind: 'turn',
      status: 'queued',
      label: '已加入队列',
      detail: '',
      timestamp: new Date().toISOString()
    });
  }

  runNextQueuedChat(job.queueKey);
  return queued;
}

export function runNextQueuedChat(queueKey) {
  const state = getConversationQueue(queueKey);
  if (state.running) {
    return;
  }

  const job = state.jobs.shift();
  if (!job) {
    return;
  }

  state.running = true;
  const sessionId = state.sessionId || job.selectedSessionId;

  runCodexTurn(
    {
      sessionId,
      draftSessionId: job.draftSessionId,
      projectPath: job.project.path,
      message: job.codexMessage,
      model: job.model,
      reasoningEffort: job.reasoningEffort,
      permissionMode: job.permissionMode,
      turnId: job.turnId
    },
    (payload) => {
      if (payload.sessionId) {
        state.sessionId = payload.sessionId;
        rememberConversationAlias(queueKey, payload.sessionId);
      }
      if (payload.previousSessionId) {
        rememberConversationAlias(queueKey, payload.previousSessionId);
      }
      emitJobEvent(job, payload);
    }
  ).then(async (finalSessionId) => {
    if (finalSessionId) {
      state.sessionId = finalSessionId;
      rememberConversationAlias(queueKey, finalSessionId);
      const turn = recentTurns.get(job.turnId) || {};
      const updatedAt = turn.completedAt || new Date().toISOString();
      const title = job.displayMessage.slice(0, 52);
      const mobileSession = await registerMobileSession({
        id: finalSessionId,
        projectPath: job.project.path,
        title,
        summary: job.displayMessage,
        updatedAt
      });
      try {
        await renameSessionNameIndexRow(finalSessionId, mobileSession?.title || title, updatedAt, { refreshUpdatedAt: true });
      } catch (error) {
        console.warn(`[sessions] Failed to sync Codex session index session=${finalSessionId}: ${error.message}`);
      }
      try {
        await syncCodexAppThreadMetadata({
          threadId: finalSessionId,
          title: mobileSession?.title || title,
          preview: turn.assistantPreview || job.displayMessage,
          updatedAt,
          cwd: job.project.path
        });
      } catch (error) {
        console.warn(`[sessions] Failed to sync Codex App state session=${finalSessionId}: ${error.message}`);
      }
    }
    rememberTurn(job.turnId, {
      projectId: job.project.id,
      sessionId: finalSessionId || sessionId || job.selectedSessionId || job.draftSessionId || null,
      previousSessionId: job.draftSessionId || job.selectedSessionId || null
    });
  }).finally(async () => {
    try {
      const snapshot = await refreshCodexCache();
      broadcast({ type: 'sync-complete', syncedAt: snapshot.syncedAt, projects: snapshot.projects });
    } catch (error) {
      console.warn('[sync] Failed to refresh after chat:', error.message);
    } finally {
      state.running = false;
      if (state.jobs.length) {
        setTimeout(() => runNextQueuedChat(queueKey), 0);
      }
    }
  });
}

export function setActiveImageRun(turnId, value) {
  activeImageRuns.set(turnId, value);
}

export function getActiveImageRun(turnId) {
  return activeImageRuns.get(turnId) || null;
}

export function deleteActiveImageRun(turnId) {
  activeImageRuns.delete(turnId);
}
