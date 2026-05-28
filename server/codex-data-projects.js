import crypto from 'node:crypto';
import path from 'node:path';

// Short stable IDs keep project routes readable while still deriving from the full path hash.
const PROJECT_ID_LENGTH = 16;

export function normalizeComparablePath(value) {
  if (!value || typeof value !== 'string') {
    return '';
  }
  const normalized = path.resolve(value);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

export function projectIdFor(projectPath) {
  return crypto.createHash('sha1').update(normalizeComparablePath(projectPath)).digest('hex').slice(0, PROJECT_ID_LENGTH);
}

export function displayNameFor(projectPath) {
  if (!projectPath || typeof projectPath !== 'string') {
    return '';
  }
  const parsed = path.parse(projectPath);
  return path.basename(projectPath) || parsed.root || projectPath;
}

export function toPublicProject(entry) {
  return {
    id: entry.id,
    name: entry.name,
    path: entry.path,
    trusted: entry.trusted,
    updatedAt: entry.updatedAt,
    sessionCount: entry.sessionCount || 0
  };
}
