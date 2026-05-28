import path from 'node:path';
import { projectIdFor } from './codex-data-parser.js';

export function mergeMobileOnlySessions({
  mobileSessions,
  hiddenSessionIds,
  visibleProjectIds,
  projectById,
  sessionsByProject,
  sessionById
}) {
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
    const session = mobileSessionToCacheEntry(mobileSession, projectId);
    if (!sessionsByProject.has(project.id)) {
      sessionsByProject.set(project.id, []);
    }
    sessionsByProject.get(project.id).push(session);
    sessionById.set(session.id, session);
  }
}

function mobileSessionToCacheEntry(mobileSession, projectId) {
  const messages = Array.isArray(mobileSession.messages) ? mobileSession.messages : [];
  return {
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
}
