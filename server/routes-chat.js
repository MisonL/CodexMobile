import crypto from 'node:crypto';
import { getCacheSnapshot, getProject, getSession, refreshCodexCache } from './codex-data.js';
import { abortCodexTurn } from './codex-runner.js';
import { isImageRequest, runImageTurn } from './image-generator.js';
import { readBody, sendJson } from './http-utils.js';
import { DEFAULT_REASONING_EFFORT, MAX_JSON_BYTES } from './app-config.js';
import { normalizeAttachments, withAttachmentReferences } from './app-attachments.js';
import { rememberImagePrompt, resolveContinuationImagePrompt } from './app-image-prompts.js';
import { remoteAddress } from './app-auth.js';
import {
  deleteActiveImageRun,
  emitJobEvent,
  enqueueChatJob,
  getActiveImageRun,
  rememberTurn,
  resolveConversationKey,
  setActiveImageRun
} from './app-turn-state.js';
import { broadcast } from './app-sockets.js';

export async function handleChatRoute(req, res, { method, pathname }) {
  if (method === 'POST' && pathname === '/api/chat/send') {
    await sendChat(req, res);
    return true;
  }
  if (method === 'POST' && pathname === '/api/chat/abort') {
    const body = await readBody(req, MAX_JSON_BYTES);
    console.log(`[chat] abort request remote=${remoteAddress(req)} turn=${body.turnId || ''} session=${body.sessionId || ''}`);
    const aborted = abortCodexTurn(body.turnId || body.sessionId);
    sendJson(res, aborted ? 200 : 404, { aborted });
    return true;
  }
  return false;
}

async function sendChat(req, res) {
  const body = await readBody(req, MAX_JSON_BYTES);
  const attachmentCount = Array.isArray(body.attachments) ? body.attachments.length : 0;
  console.log(`[chat] send request remote=${remoteAddress(req)} project=${body.projectId || ''} session=${body.sessionId || body.draftSessionId || ''} attachments=${attachmentCount}`);
  const project = getProject(body.projectId);
  if (!project) {
    console.warn(`[chat] rejected project not found: ${body.projectId || ''}`);
    sendJson(res, 404, { error: 'Project not found' });
    return;
  }

  let attachments = [];
  try {
    attachments = normalizeAttachments(body.attachments);
  } catch (error) {
    sendJson(res, error.statusCode || 400, { error: error.message || 'invalid_attachment' });
    return;
  }
  const message = String(body.message || '').trim();
  if (!message && !attachments.length) {
    sendJson(res, 400, { error: 'message or attachments are required' });
    return;
  }

  const context = buildChatContext({ body, project, attachments, message });
  rememberTurn(context.turnId, {
    projectId: project.id,
    projectPath: project.path,
    sessionId: context.conversationSessionId,
    previousSessionId: context.draftSessionId || context.selectedSessionId || null,
    draftSessionId: context.draftSessionId,
    status: 'accepted',
    label: '正在思考',
    hadAssistantText: false,
    startedAt: new Date().toISOString()
  });
  broadcastUserMessage(project.id, context.conversationSessionId, context.displayMessage, context.turnId);

  if (context.imagePrompt) {
    await startImageTurn(res, context);
    return;
  }

  startCodexTurn(res, context);
}

function buildChatContext({ body, project, attachments, message }) {
  const requestedSessionId = String(body.sessionId || '').trim();
  const isDraft = requestedSessionId.startsWith('draft-');
  const session = requestedSessionId && !isDraft ? getSession(requestedSessionId) : null;
  const mobileOnlySession = session?.mobileOnly ? session : null;
  const draftSessionId = String(body.draftSessionId || '').trim() || mobileOnlySession?.id || null;
  const selectedSessionId = session && !session.mobileOnly
    ? session.id
    : (requestedSessionId && !isDraft && !mobileOnlySession ? requestedSessionId : null);
  const config = getCacheSnapshot().config || {};
  const displayMessage = message || '请查看附件。';
  const imagePrompt = isImageRequest(displayMessage, attachments)
    ? displayMessage
    : resolveContinuationImagePrompt(project.id, displayMessage);
  return {
    project,
    attachments,
    body,
    config,
    displayMessage,
    codexMessage: withAttachmentReferences(displayMessage, attachments),
    imagePrompt,
    requestedSessionId,
    draftSessionId,
    selectedSessionId,
    mobileOnlySession,
    turnId: String(body.clientTurnId || '').trim() || crypto.randomUUID(),
    conversationSessionId: selectedSessionId || mobileOnlySession?.id || draftSessionId || null
  };
}

function broadcastUserMessage(projectId, sessionId, content, turnId) {
  broadcast({
    type: 'user-message',
    sessionId,
    projectId,
    turnId,
    message: {
      id: `user-${turnId || Date.now()}`,
      role: 'user',
      content,
      timestamp: new Date().toISOString(),
      sessionId,
      turnId
    }
  });
}

async function startImageTurn(res, context) {
  rememberImagePrompt(context.project.id, context.imagePrompt);
  const imageSessionId = context.selectedSessionId || context.mobileOnlySession?.id || `mobile-image-${crypto.randomUUID()}`;
  const previousSessionId = imageSessionId === context.conversationSessionId
    ? context.draftSessionId
    : context.conversationSessionId;
  const imageLabel = context.attachments.some((attachment) => attachment.kind === 'image') ? '正在编辑图片' : '正在生成图片';
  setActiveImageRun(context.turnId, {
    turnId: context.turnId,
    sessionId: imageSessionId,
    previousSessionId,
    startedAt: new Date().toISOString(),
    status: 'running',
    label: imageLabel
  });
  console.log(`[chat] accepted image turn=${context.turnId} session=${imageSessionId} project=${context.project.name}`);
  rememberTurn(context.turnId, {
    projectId: context.project.id,
    projectPath: context.project.path,
    sessionId: imageSessionId,
    previousSessionId,
    status: 'running',
    kind: 'image_generation_call',
    label: imageLabel
  });
  runImageTurn({
    sessionId: imageSessionId,
    previousSessionId,
    projectPath: context.project.path,
    message: context.imagePrompt,
    attachments: context.attachments,
    config: context.config,
    turnId: context.turnId,
    persistMobileSession: true
  }, (payload) => handleImagePayload(context.project, payload));
  sendJson(res, 202, {
    accepted: true,
    queued: false,
    sessionId: imageSessionId,
    draftSessionId: context.draftSessionId,
    turnId: context.turnId,
    mode: 'image'
  });
}

function handleImagePayload(project, payload) {
  if (payload.turnId && getActiveImageRun(payload.turnId)) {
    const existing = getActiveImageRun(payload.turnId);
    if (payload.type === 'status-update' || payload.type === 'activity-update') {
      setActiveImageRun(payload.turnId, {
        ...existing,
        sessionId: payload.sessionId || existing.sessionId,
        previousSessionId: payload.previousSessionId || existing.previousSessionId,
        status: payload.status || existing.status,
        label: payload.label || existing.label
      });
    }
  }
  emitJobEvent({ project }, payload);
  if (payload.type === 'chat-complete' || payload.type === 'chat-error') {
    deleteActiveImageRun(payload.turnId);
    refreshCodexCache()
      .then((snapshot) => broadcast({ type: 'sync-complete', syncedAt: snapshot.syncedAt, projects: snapshot.projects }))
      .catch((error) => console.warn('[sync] Failed to refresh after image chat:', error.message));
  }
}

function startCodexTurn(res, context) {
  console.log(`[chat] accepted codex turn=${context.turnId} session=${context.selectedSessionId || context.draftSessionId || ''} project=${context.project.name}`);
  const queueKey = resolveConversationKey(context.selectedSessionId, context.draftSessionId, context.requestedSessionId);
  const session = context.selectedSessionId ? getSession(context.selectedSessionId) : null;
  const queued = enqueueChatJob({
    queueKey,
    project: context.project,
    selectedSessionId: context.selectedSessionId,
    draftSessionId: context.draftSessionId,
    turnId: context.turnId,
    codexMessage: context.codexMessage,
    displayMessage: context.displayMessage,
    model: session?.model || context.body.model || context.config.model || 'gpt-5.5',
    reasoningEffort: context.body.reasoningEffort || DEFAULT_REASONING_EFFORT,
    permissionMode: context.body.permissionMode || 'default'
  });
  sendJson(res, 202, {
    accepted: true,
    queued,
    sessionId: context.selectedSessionId,
    draftSessionId: context.draftSessionId,
    turnId: context.turnId
  });
}
