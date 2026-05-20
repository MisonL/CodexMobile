import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { CODEX_SESSION_INDEX } from './codex-config.js';

export function normalizeComparablePath(value) {
  if (!value || typeof value !== 'string') {
    return '';
  }
  const normalized = path.resolve(value);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

export function projectIdFor(projectPath) {
  return crypto.createHash('sha1').update(normalizeComparablePath(projectPath)).digest('hex').slice(0, 16);
}

export function displayNameFor(projectPath) {
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

export async function walkJsonlFiles(dir) {
  const files = [];
  async function walk(current) {
    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile() && entry.name.endsWith('.jsonl') && !entry.name.startsWith('agent-')) {
        files.push(fullPath);
      }
    }
  }
  await walk(dir);
  return files;
}

export async function readSessionNameIndex() {
  const index = new Map();
  try {
    const raw = await fs.readFile(CODEX_SESSION_INDEX, 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) {
        continue;
      }
      try {
        const item = JSON.parse(line);
        if (item.id && item.thread_name) {
          index.set(item.id, {
            title: item.thread_name,
            updatedAt: item.updated_at || null
          });
        }
      } catch {
        // Skip malformed index rows.
      }
    }
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.warn('[sessions] Failed to read session index:', error.message);
    }
  }
  return index;
}

export async function renameSessionNameIndexRow(sessionId, title, updatedAt) {
  try {
    const raw = await fs.readFile(CODEX_SESSION_INDEX, 'utf8');
    const nextLines = [];
    let changed = false;
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) {
        continue;
      }
      try {
        const item = JSON.parse(line);
        if (item?.id === sessionId) {
          item.thread_name = title;
          item.updated_at = item.updated_at || updatedAt || new Date().toISOString();
          nextLines.push(JSON.stringify(item));
          changed = true;
          continue;
        }
      } catch {
        // Preserve malformed rows.
      }
      nextLines.push(line);
    }
    if (!changed) {
      nextLines.push(JSON.stringify({
        id: sessionId,
        thread_name: title,
        updated_at: updatedAt || new Date().toISOString()
      }));
    }
    await fs.writeFile(CODEX_SESSION_INDEX, `${nextLines.join('\n')}\n`, 'utf8');
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') {
      await fs.writeFile(
        CODEX_SESSION_INDEX,
        `${JSON.stringify({
          id: sessionId,
          thread_name: title,
          updated_at: updatedAt || new Date().toISOString()
        })}\n`,
        'utf8'
      );
      return true;
    }
    throw error;
  }
}

export function isVisibleUserMessage(payload) {
  return (
    payload?.type === 'user_message' &&
    (!payload.kind || payload.kind === 'plain') &&
    typeof payload.message === 'string' &&
    sanitizeVisibleUserMessage(payload.message).trim().length > 0
  );
}

export const INTERNAL_PROMPT_MARKERS = [
  'CodexMobile iOS/PWA 回复要求：',
  'CodexMobile 已接入飞书官方 lark-cli。',
  'CodexMobile 已接入飞书官方 lark-cli'
];

export function sanitizeVisibleUserMessage(message) {
  const value = String(message || '').trim();
  if (!value) {
    return '';
  }
  let cutAt = value.length;
  for (const marker of INTERNAL_PROMPT_MARKERS) {
    const index = value.indexOf(marker);
    if (index > 0) {
      cutAt = Math.min(cutAt, index);
    }
  }
  return value.slice(0, cutAt).trim() || value;
}

export function extractContent(content) {
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return '';
  }
  return content
    .map((part) => {
      if (typeof part === 'string') {
        return part;
      }
      if (part?.type === 'output_text' || part?.type === 'input_text' || part?.type === 'text') {
        return part.text || '';
      }
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

export async function parseSessionMetadata(filePath, sessionIndex, mobileSessionIndex) {
  const stream = fsSync.createReadStream(filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  let meta = null;
  let lastTimestamp = null;
  let lastUserMessage = '';
  let messageCount = 0;

  for await (const line of rl) {
    if (!line.trim()) {
      continue;
    }
    try {
      const entry = JSON.parse(line);
      if (entry.timestamp) {
        lastTimestamp = entry.timestamp;
      }
      if (entry.type === 'session_meta' && entry.payload?.id) {
        meta = {
          id: entry.payload.id,
          cwd: entry.payload.cwd,
          model: entry.payload.model || null,
          provider: entry.payload.model_provider || null,
          timestamp: entry.timestamp || entry.payload.timestamp || null
        };
      }
      if (entry.type === 'event_msg' && isVisibleUserMessage(entry.payload)) {
        messageCount += 1;
        lastUserMessage = sanitizeVisibleUserMessage(entry.payload.message);
      }
      if (entry.type === 'response_item' && entry.payload?.type === 'message' && entry.payload.role === 'assistant') {
        messageCount += 1;
      }
    } catch {
      // Skip malformed or partial rows.
    }
  }

  if (!meta?.id || !meta.cwd) {
    return null;
  }
  const indexedSession = sessionIndex.get(meta.id);
  const mobileSession = mobileSessionIndex.get(meta.id);
  const indexEntry = indexedSession || mobileSession || {};
  const mobileMessages = Array.isArray(mobileSession?.messages) ? mobileSession.messages : [];
  const mobileUpdatedAt = mobileSession?.updatedAt || null;
  const updatedAt =
    mobileUpdatedAt && (!lastTimestamp || new Date(mobileUpdatedAt) > new Date(lastTimestamp))
      ? mobileUpdatedAt
      : lastTimestamp || meta.timestamp;

  return {
    id: meta.id,
    cwd: meta.cwd,
    projectId: projectIdFor(meta.cwd),
    title: mobileSession?.title || indexEntry.title || (lastUserMessage ? lastUserMessage.slice(0, 52) : '新对话'),
    summary: mobileSession?.summary || lastUserMessage || indexEntry.summary || indexEntry.title || 'Codex 会话',
    model: meta.model,
    provider: meta.provider,
    messageCount: messageCount + mobileMessages.length,
    updatedAt,
    source: 'codex-app',
    filePath
  };
}

export function upsertProject(projectMap, projectPath, trustLevel = null, label = null) {
  const normalized = normalizeComparablePath(projectPath);
  if (!normalized) {
    return null;
  }
  const id = projectIdFor(projectPath);
  const existing = projectMap.get(id);
  if (existing) {
    if (trustLevel) {
      existing.trusted = trustLevel === 'trusted';
    }
    if (label) {
      existing.name = label;
    }
    return existing;
  }
  const entry = {
    id,
    name: label || displayNameFor(projectPath),
    path: path.resolve(projectPath),
    trusted: trustLevel === 'trusted',
    updatedAt: null,
    sessionCount: 0
  };
  projectMap.set(id, entry);
  return entry;
}
