import {
  deleteSession,
  getProject,
  getSession,
  listProjectSessions,
  readSessionMessages,
  refreshCodexCache,
  renameSession
} from './codex-data.js';
import { hideSessionMessage } from './codex-data-hidden-state.js';
import { readBody, sendJson } from './http-utils.js';
import { MAX_JSON_BYTES } from './app-config.js';
import { broadcast } from './app-sockets.js';
import { recentTurns, sessionHasActiveWork } from './app-turn-state.js';

function projectSessionPath(parts) {
  return parts.length === 5 && parts[0] === 'api' && parts[1] === 'projects' && parts[3] === 'sessions';
}

export async function handleSessionRoute(req, res, { method, url, parts }) {
  if (method === 'GET' && parts.length === 4 && parts[0] === 'api' && parts[1] === 'projects' && parts[3] === 'sessions') {
    const projectId = decodeURIComponent(parts[2]);
    sendJson(res, 200, { sessions: listProjectSessions(projectId) });
    return true;
  }

  if (method === 'PATCH' && projectSessionPath(parts)) {
    await renameProjectSession(req, res, decodeURIComponent(parts[2]), decodeURIComponent(parts[4]));
    return true;
  }

  if (method === 'DELETE' && projectSessionPath(parts)) {
    await deleteProjectSession(res, decodeURIComponent(parts[2]), decodeURIComponent(parts[4]));
    return true;
  }

  if (method === 'GET' && parts.length === 4 && parts[0] === 'api' && parts[1] === 'chat' && parts[2] === 'turns') {
    sendJson(res, 200, { turn: recentTurns.get(decodeURIComponent(parts[3])) || null });
    return true;
  }

  if (method === 'DELETE' && parts.length === 5 && parts[0] === 'api' && parts[1] === 'sessions' && parts[3] === 'messages') {
    await deleteSessionMessage(res, decodeURIComponent(parts[2]), decodeURIComponent(parts[4]));
    return true;
  }

  if (method === 'GET' && parts.length === 4 && parts[0] === 'api' && parts[1] === 'sessions' && parts[3] === 'messages') {
    const limit = url.searchParams.get('limit');
    const offset = url.searchParams.has('offset') ? url.searchParams.get('offset') : null;
    const result = await readSessionMessages(decodeURIComponent(parts[2]), {
      limit: limit ? Number(limit) : 120,
      offset: offset !== null ? Number(offset) : null,
      latest: offset === null || url.searchParams.get('latest') === '1'
    });
    sendJson(res, 200, result);
    return true;
  }

  return false;
}

async function renameProjectSession(req, res, projectId, sessionId) {
  const project = getProject(projectId);
  const session = getSession(sessionId);
  if (!project || !session || session.projectId !== project.id) {
    sendJson(res, 404, { error: project ? 'Session not found' : 'Project not found' });
    return;
  }
  const body = await readBody(req, MAX_JSON_BYTES);
  const title = String(body.title || '').trim().slice(0, 52);
  if (!title) {
    sendJson(res, 400, { error: 'Title is required' });
    return;
  }
  try {
    const renamed = await renameSession(session.id, project.id, title);
    const snapshot = await refreshCodexCache();
    broadcast({ type: 'sync-complete', syncedAt: snapshot.syncedAt, projects: snapshot.projects });
    sendJson(res, 200, { success: true, session: renamed });
  } catch (error) {
    console.warn(`[sessions] rename failed session=${sessionId} project=${projectId}: ${error.message}`);
    sendJson(res, 500, { error: 'Failed to rename session' });
  }
}

async function deleteProjectSession(res, projectId, sessionId) {
  const project = getProject(projectId);
  const session = getSession(sessionId);
  if (!project || !session || session.projectId !== project.id) {
    sendJson(res, 404, { error: project ? 'Session not found' : 'Project not found' });
    return;
  }
  if (sessionHasActiveWork(sessionId)) {
    sendJson(res, 409, { error: 'Session is running' });
    return;
  }
  try {
    const deleted = await deleteSession(sessionId, project.id);
    const snapshot = await refreshCodexCache();
    broadcast({ type: 'sync-complete', syncedAt: snapshot.syncedAt, projects: snapshot.projects });
    sendJson(res, 200, { success: true, ...deleted });
  } catch (error) {
    const statusCode = error.statusCode || 500;
    console.warn(`[sessions] delete failed session=${sessionId} project=${projectId}: ${error.message}`);
    sendJson(res, statusCode, { error: statusCode === 409 ? error.message : 'Failed to delete session' });
  }
}

async function deleteSessionMessage(res, sessionId, messageId) {
  try {
    const deleted = await hideSessionMessage(sessionId, messageId);
    broadcast({ type: 'message-deleted', ...deleted });
    sendJson(res, 200, { success: true, ...deleted });
  } catch (error) {
    const statusCode = error.statusCode || 500;
    console.warn(`[sessions] message delete failed session=${sessionId} message=${messageId}: ${error.message}`);
    sendJson(res, statusCode, { error: statusCode === 400 ? error.message : 'Failed to delete message' });
  }
}
