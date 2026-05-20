import os from 'node:os';
import path from 'node:path';
import { CODEX_SESSIONS_DIR, readCodexConfig, readCodexWorkspaceState } from './codex-config.js';
import {
  readMobileSessionIndex,
  readMobileSessions,
  renameMobileSession
} from './mobile-session-index.js';
import { hideSessionInMobile, readHiddenSessionIds } from './codex-data-hidden-state.js';
import {
  normalizeComparablePath,
  parseSessionMetadata,
  projectIdFor,
  readSessionNameIndex,
  renameSessionNameIndexRow,
  toPublicProject,
  upsertProject,
  walkJsonlFiles
} from './codex-data-parser.js';
import { readSessionMessagesFromCache } from './codex-data-messages.js';

let cache = {
  syncedAt: null,
  config: null,
  projects: [],
  projectById: new Map(),
  sessionsByProject: new Map(),
  sessionById: new Map()
};

export async function refreshCodexCache() {
  const config = await readCodexConfig();
  const workspaceState = await readCodexWorkspaceState();
  const sessionIndex = await readSessionNameIndex();
  const mobileSessionIndex = await readMobileSessionIndex();
  const mobileSessions = await readMobileSessions();
  const hiddenSessionIds = await readHiddenSessionIds();
  const projectById = new Map();
  const sessionsByProject = new Map();
  const sessionById = new Map();

  const visibleProjects = workspaceState.projects.length
    ? workspaceState.projects.map((project) => ({
      path: project.path,
      trustLevel: config.projects.find(
        (entry) => normalizeComparablePath(entry.path) === normalizeComparablePath(project.path)
      )?.trustLevel || 'trusted',
      label: project.label
    }))
    : config.projects.map((project) => ({ ...project, label: null }));
  const visibleProjectIds = new Set();

  for (const project of visibleProjects) {
    const entry = upsertProject(projectById, project.path, project.trustLevel, project.label);
    if (entry) {
      visibleProjectIds.add(entry.id);
    }
  }

  const files = await walkJsonlFiles(CODEX_SESSIONS_DIR);
  for (const file of files) {
    const session = await parseSessionMetadata(file, sessionIndex, mobileSessionIndex);
    if (!session) {
      continue;
    }
    if (hiddenSessionIds.has(session.id)) {
      continue;
    }
    if (!visibleProjectIds.has(session.projectId)) {
      continue;
    }
    const project = projectById.get(session.projectId);
    if (!project) {
      continue;
    }
    if (!sessionsByProject.has(project.id)) {
      sessionsByProject.set(project.id, []);
    }
    sessionsByProject.get(project.id).push(session);
    sessionById.set(session.id, session);
  }

  for (const mobileSession of mobileSessions) {
    if (!mobileSession?.id || !mobileSession.projectPath || sessionById.has(mobileSession.id)) {
      continue;
    }
    if (hiddenSessionIds.has(mobileSession.id)) {
      continue;
    }
    const projectId = projectIdFor(mobileSession.projectPath);
    if (!visibleProjectIds.has(projectId)) {
      continue;
    }
    const project = projectById.get(projectId);
    if (!project) {
      continue;
    }
    const messages = Array.isArray(mobileSession.messages) ? mobileSession.messages : [];
    const session = {
      id: mobileSession.id,
      cwd: path.resolve(mobileSession.projectPath),
      projectId,
      title: mobileSession.title || mobileSession.summary?.slice(0, 52) || '新对话',
      summary: mobileSession.summary || mobileSession.title || 'CodexMobile 对话',
      model: mobileSession.model || null,
      provider: mobileSession.provider || null,
      messageCount: messages.length,
      updatedAt: mobileSession.updatedAt || null,
      source: mobileSession.source || 'codexmobile',
      filePath: null,
      mobileOnly: true
    };
    if (!sessionsByProject.has(project.id)) {
      sessionsByProject.set(project.id, []);
    }
    sessionsByProject.get(project.id).push(session);
    sessionById.set(session.id, session);
  }

  for (const [projectId, sessions] of sessionsByProject.entries()) {
    sessions.sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0));
    const project = projectById.get(projectId);
    if (project) {
      project.sessionCount = sessions.length;
      project.updatedAt = sessions[0]?.updatedAt || project.updatedAt;
    }
  }

  const projectOrder = new Map(visibleProjects.map((project, index) => [projectIdFor(project.path), index]));
  const projects = [...projectById.values()].sort((a, b) => {
    const orderA = projectOrder.get(a.id) ?? Number.MAX_SAFE_INTEGER;
    const orderB = projectOrder.get(b.id) ?? Number.MAX_SAFE_INTEGER;
    return orderA - orderB || a.name.localeCompare(b.name, 'zh-Hans-CN');
  });

  cache = {
    syncedAt: new Date().toISOString(),
    config,
    projects,
    projectById,
    sessionsByProject,
    sessionById
  };

  return getCacheSnapshot();
}

export function getCacheSnapshot() {
  return {
    syncedAt: cache.syncedAt,
    config: cache.config,
    projects: cache.projects.map(toPublicProject)
  };
}

export function listProjects() {
  return cache.projects.map(toPublicProject);
}

export function getProject(projectId) {
  return cache.projectById.get(projectId) || null;
}

export function listProjectSessions(projectId) {
  return (cache.sessionsByProject.get(projectId) || []).map((session) => ({
    id: session.id,
    title: session.title,
    summary: session.summary,
    model: session.model,
    provider: session.provider,
    source: session.source,
    messageCount: session.messageCount,
    updatedAt: session.updatedAt
  }));
}

export function getSession(sessionId) {
  return cache.sessionById.get(sessionId) || null;
}

export async function renameSession(sessionId, projectId, title) {
  const session = getSession(sessionId);
  if (!session) {
    const error = new Error('Session not found');
    error.statusCode = 404;
    throw error;
  }
  if (projectId && session.projectId !== projectId) {
    const error = new Error('Session not found in project');
    error.statusCode = 404;
    throw error;
  }

  const nextTitle = String(title || '').trim().slice(0, 52);
  if (!nextTitle) {
    const error = new Error('Title is required');
    error.statusCode = 400;
    throw error;
  }

  if (session.filePath) {
    await renameSessionNameIndexRow(session.id, nextTitle, session.updatedAt);
  }
  await renameMobileSession({
    id: session.id,
    projectPath: session.cwd,
    title: nextTitle,
    updatedAt: session.updatedAt
  });

  return { ...session, title: nextTitle };
}

export async function deleteSession(sessionId, projectId) {
  const session = getSession(sessionId);
  if (!session) {
    const error = new Error('Session not found');
    error.statusCode = 404;
    throw error;
  }
  if (projectId && session.projectId !== projectId) {
    const error = new Error('Session not found in project');
    error.statusCode = 404;
    throw error;
  }

  const hidden = await hideSessionInMobile(session);

  return {
    deletedSessionId: sessionId,
    projectId: session.projectId,
    hiddenOnly: true,
    hiddenAt: hidden.hiddenAt,
    deletedFile: false,
    deletedIndexRows: false,
    deletedMobileRecord: false
  };
}


export async function readSessionMessages(sessionId, options = {}) {
  return readSessionMessagesFromCache(cache, sessionId, options);
}

export function getHostName() {
  return os.hostname();
}
