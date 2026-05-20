import fsSync from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { CODEX_SESSIONS_DIR } from './codex-config.js';
import { readMobileSessionMessages } from './mobile-session-index.js';
import { filterDeletedMessages, readDeletedMessageIds } from './codex-data-hidden-state.js';
import { extractContent, isVisibleUserMessage, sanitizeVisibleUserMessage, walkJsonlFiles } from './codex-data-parser.js';

async function findSessionFile(cache, sessionId) {
  const cached = cache.sessionById.get(sessionId)?.filePath;
  if (cached) {
    return cached;
  }
  const files = await walkJsonlFiles(CODEX_SESSIONS_DIR);
  return files.find((file) => path.basename(file).includes(sessionId)) || null;
}

function paginateMessages(messages, { limit = 120, offset = null, latest = true } = {}) {
  const total = messages.length;
  const count = Number(limit) || 0;
  const hasOffset = offset !== null && offset !== undefined;
  const start = hasOffset
    ? Math.max(0, Number(offset) || 0)
    : latest && count
      ? Math.max(0, total - count)
      : 0;
  const end = count ? start + count : undefined;
  return {
    messages: messages.slice(start, end),
    total,
    offset: start,
    hasMore: end ? end < total : false,
    hasMoreBefore: start > 0
  };
}

export async function readSessionMessagesFromCache(cache, sessionId, { limit = 120, offset = null, latest = true } = {}) {
  const filePath = await findSessionFile(cache, sessionId);
  const mobileMessages = await readMobileSessionMessages(sessionId);
  const deletedIds = await readDeletedMessageIds(sessionId);
  if (!filePath) {
    return paginateMessages(filterDeletedMessages(mobileMessages, deletedIds), { limit, offset, latest });
  }

  const messages = [];
  const stream = fsSync.createReadStream(filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  for await (const line of rl) {
    if (!line.trim()) {
      continue;
    }
    try {
      const entry = JSON.parse(line);
      const timestamp = entry.timestamp || null;

      if (entry.type === 'event_msg' && isVisibleUserMessage(entry.payload)) {
        messages.push({
          id: `${entry.timestamp || messages.length}-user`,
          role: 'user',
          content: sanitizeVisibleUserMessage(entry.payload.message),
          timestamp
        });
      }

      if (
        entry.type === 'response_item' &&
        entry.payload?.type === 'message' &&
        entry.payload.role === 'assistant' &&
        entry.payload.phase !== 'commentary'
      ) {
        const content = extractContent(entry.payload.content);
        if (content.trim()) {
          messages.push({
            id: entry.payload.id || `${entry.timestamp || messages.length}-assistant`,
            role: entry.payload.role || 'assistant',
            content,
            timestamp
          });
        }
      }

    } catch {
      // Skip malformed rows.
    }
  }

  for (const message of mobileMessages) {
    if (!messages.some((item) => item.id === message.id)) {
      messages.push(message);
    }
  }
  messages.sort((a, b) => new Date(a.timestamp || 0) - new Date(b.timestamp || 0));

  return paginateMessages(filterDeletedMessages(messages, deletedIds), { limit, offset, latest });
}
