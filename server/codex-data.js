import os from 'node:os';
import { CODEX_SESSIONS_DIR, readCodexConfig, readCodexWorkspaceState } from './codex-config.js';
import {
  readMobileSessionIndex,
  readMobileSessions,
  renameMobileSession
} from './mobile-session-index.js';
import { hideSessionInMobile, readHiddenSessionIds } from './codex-data-hidden-state.js';
import {
  normalizeComparablePath,
  parseFilteredSessionMetadata,
  projectIdFor,
  readSessionNameIndex,
  renameSessionNameIndexRow,
  toPublicProject,
  upsertProject,
  walkJsonlFiles
} from './codex-data-parser.js';
import { readSessionMessagesFromCache } from './codex-data-messages.js';
import { mergeMobileOnlySessions } from './codex-data-mobile-sessions.js';

const DEFAULT_SESSION_SCAN_CONCURRENCY = 16;
const MIN_SESSION_SCAN_CONCURRENCY = 1;
const SESSION_SCAN_CONCURRENCY_ENV = 'CODEXMOBILE_SESSION_SCAN_CONCURRENCY';

function resolveSessionScanConcurrency(env = process.env) {
  const configured = Number(env[SESSION_SCAN_CONCURRENCY_ENV] || DEFAULT_SESSION_SCAN_CONCURRENCY);
  if (!Number.isFinite(configured)) {
    return DEFAULT_SESSION_SCAN_CONCURRENCY;
  }
  return Math.max(MIN_SESSION_SCAN_CONCURRENCY, Math.floor(configured));
}

// Session scans are mostly JSONL file I/O, so the default allows moderate parallel reads while staying tunable.
const SESSION_SCAN_CONCURRENCY = resolveSessionScanConcurrency();

function retainProjectSessions({ sessionsByProject, sessionById }, projectById) {
  const retainedSessionsByProject = new Map();
  const retainedSessionById = new Map();

  for (const [projectId, sessions] of sessionsByProject.entries()) {
    if (!projectById.has(projectId)) {
      continue;
    }
    const retained = sessions.filter((session) => session?.projectId === projectId);
    if (!retained.length) {
      continue;
    }
    retainedSessionsByProject.set(projectId, retained);
    for (const session of retained) {
      retainedSessionById.set(session.id, sessionById.get(session.id) || session);
    }
  }

  return { sessionsByProject: retainedSessionsByProject, sessionById: retainedSessionById };
}

let cache = {
  syncedAt: null,
  config: null,
  projects: [],
  projectById: new Map(),
  sessionsByProject: new Map(),
  sessionById: new Map()
};

async function loadVisibleProjectCache() {
  const config = await readCodexConfig();
  const workspaceState = await readCodexWorkspaceState();
  const projectById = new Map();

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
  return { config, visibleProjects, visibleProjectIds, projectById };
}

export async function refreshProjectCache() {
  const { config, visibleProjects, projectById } = await loadVisibleProjectCache();
  const projectOrder = new Map(visibleProjects.map((project, index) => [projectIdFor(project.path), index]));
  const retained = retainProjectSessions(cache, projectById);
  cache = {
    ...cache,
    config,
    projects: [...projectById.values()].sort((a, b) => {
      const orderA = projectOrder.get(a.id) ?? Number.MAX_SAFE_INTEGER;
      const orderB = projectOrder.get(b.id) ?? Number.MAX_SAFE_INTEGER;
      return orderA - orderB || a.name.localeCompare(b.name, 'zh-Hans-CN');
    }),
    projectById,
    sessionsByProject: retained.sessionsByProject,
    sessionById: retained.sessionById
  };
  return getCacheSnapshot();
}

async function mapWithConcurrency(items, limit, mapper) {
  if (!Number.isInteger(limit) || limit < MIN_SESSION_SCAN_CONCURRENCY) {
    throw new TypeError('Concurrency limit must be a positive integer.');
  }
  if (!items.length) {
    return [];
  }
  const results = new Array(items.length);
  let nextIndex = 0;

  const worker = async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index], index);
    }
  };

  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

export async function refreshCodexCache() {
  const { config, visibleProjects, visibleProjectIds, projectById } = await loadVisibleProjectCache();
  const sessionIndex = await readSessionNameIndex();
  const mobileSessionIndex = await readMobileSessionIndex();
  const mobileSessions = await readMobileSessions();
  const hiddenSessionIds = await readHiddenSessionIds();
  const sessionsByProject = new Map();
  const sessionById = new Map();

  const files = await walkJsonlFiles(CODEX_SESSIONS_DIR);
  const sessions = await mapWithConcurrency(files, SESSION_SCAN_CONCURRENCY, async (file) => {
    try {
      const session = await parseFilteredSessionMetadata({
        filePath: file,
        sessionIndex,
        mobileSessionIndex,
        includeIdentity: (identity) => (
          !hiddenSessionIds.has(identity.id) &&
          visibleProjectIds.has(identity.projectId)
        )
      });
      if (!session) {
        return null;
      }
      if (hiddenSessionIds.has(session.id)) {
        return null;
      }
      if (!visibleProjectIds.has(session.projectId)) {
        return null;
      }
      return session;
    } catch (error) {
      console.warn(`[codex-data] skip unreadable session file=${file} message=${error.message || error}`);
      return null;
    }
  });

  for (const session of sessions) {
    if (!session) {
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

  mergeMobileOnlySessions({
    mobileSessions,
    hiddenSessionIds,
    visibleProjectIds,
    projectById,
    sessionsByProject,
    sessionById
  });

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
