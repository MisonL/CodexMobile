import { execFile as defaultExecFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { CODEX_HOME } from './codex-config.js';

export const CODEX_APP_STATE_DB = path.join(CODEX_HOME, 'state_5.sqlite');
export const MAX_CODEX_APP_TITLE_LENGTH = 120;
export const MAX_CODEX_APP_PREVIEW_LENGTH = 500;

function normalizeText(value, maxLength) {
  const text = String(value || '').replaceAll('\0', '').replace(/\s+/g, ' ').trim();
  if (text.length <= maxLength) {
    return text;
  }
  return text.slice(0, maxLength).trimEnd();
}

function sqlString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function timestampParts(updatedAt) {
  const date = updatedAt ? new Date(updatedAt) : new Date();
  const millis = Number.isFinite(date.getTime()) ? date.getTime() : Date.now();
  return {
    seconds: Math.floor(millis / 1000),
    millis
  };
}

function execFileAsync(execFile, command, args, options) {
  return new Promise((resolve, reject) => {
    execFile(command, args, options, (error, stdout, stderr) => {
      if (error) {
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function sqliteReadWriteUri(filePath) {
  const url = pathToFileURL(path.resolve(filePath));
  url.searchParams.set('mode', 'rw');
  return url.href;
}

export function buildCodexAppThreadMetadataSql({ threadId, title, preview, updatedAt, cwd }) {
  const id = String(threadId || '').trim();
  if (!id) {
    throw new TypeError('threadId is required.');
  }
  const nextTitle = normalizeText(title, MAX_CODEX_APP_TITLE_LENGTH);
  const nextPreview = normalizeText(preview, MAX_CODEX_APP_PREVIEW_LENGTH);
  const { seconds, millis } = timestampParts(updatedAt);
  const titleSql = nextTitle ? sqlString(nextTitle) : 'title';
  const previewSql = nextPreview ? sqlString(nextPreview) : 'preview';
  const cwdGuard = cwd ? ` AND cwd = ${sqlString(path.resolve(cwd))}` : '';
  const freshnessGuard = ` AND (updated_at_ms IS NULL OR updated_at_ms <= ${millis})`;

  return [
    'PRAGMA busy_timeout = 1000;',
    'UPDATE threads',
    'SET',
    `  title = ${titleSql},`,
    `  preview = ${previewSql},`,
    `  updated_at = CASE WHEN updated_at IS NULL OR updated_at < ${seconds} THEN ${seconds} ELSE updated_at END,`,
    `  updated_at_ms = CASE WHEN updated_at_ms IS NULL OR updated_at_ms < ${millis} THEN ${millis} ELSE updated_at_ms END`,
    `WHERE id = ${sqlString(id)}${cwdGuard}${freshnessGuard};`,
    'SELECT changes();'
  ].join('\n');
}

export async function syncCodexAppThreadMetadata(params, options = {}) {
  const stateDbPath = options.stateDbPath || CODEX_APP_STATE_DB;
  const execFile = options.execFile || defaultExecFile;
  const sqliteCommand = options.sqliteCommand || process.env.CODEXMOBILE_SQLITE3 || 'sqlite3';

  if (!await pathExists(stateDbPath)) {
    return { updated: false, skipped: true, reason: 'state-db-missing' };
  }

  const sql = buildCodexAppThreadMetadataSql(params);
  let stdout;
  try {
    ({ stdout } = await execFileAsync(execFile, sqliteCommand, [sqliteReadWriteUri(stateDbPath), sql], {
      timeout: options.timeoutMs || 5000,
      maxBuffer: 1024 * 1024
    }));
  } catch (error) {
    if (!await pathExists(stateDbPath)) {
      return { updated: false, skipped: true, reason: 'state-db-missing' };
    }
    throw error;
  }
  const changes = Number.parseInt(String(stdout || '').trim().split(/\s+/).pop() || '0', 10);
  return {
    updated: Number.isFinite(changes) && changes > 0,
    skipped: false,
    changes: Number.isFinite(changes) ? changes : 0
  };
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}
