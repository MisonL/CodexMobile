import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

import {
  buildCodexAppThreadMetadataSql,
  syncCodexAppThreadMetadata
} from '../server/codex-app-state-sync.js';

const execFileAsync = promisify(execFile);

test('buildCodexAppThreadMetadataSql updates only an existing matching thread', () => {
  const cwd = path.join(os.tmpdir(), 'codexmobile-app-state-project');
  const sql = buildCodexAppThreadMetadataSql({
    threadId: "thread-'1",
    title: "O'Brien title",
    preview: 'final preview',
    updatedAt: '2026-05-28T07:20:11.493Z',
    cwd
  });

  assert.match(sql, /PRAGMA busy_timeout = 1000;/);
  assert.match(sql, /UPDATE threads/);
  assert.match(sql, /WHERE id = 'thread-''1' AND cwd = '/);
  assert.match(sql, /AND \(updated_at_ms IS NULL OR updated_at_ms <= 1779952811493\)/);
  assert.match(sql, /title = 'O''Brien title'/);
  assert.match(sql, /preview = 'final preview'/);
  assert.match(sql, /updated_at = CASE WHEN updated_at IS NULL OR updated_at < 1779952811/);
  assert.match(sql, /updated_at_ms = CASE WHEN updated_at_ms IS NULL OR updated_at_ms < 1779952811493/);
  assert.match(sql, /SELECT changes\(\);/);
});

test('syncCodexAppThreadMetadata skips when Codex App state database is absent', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codexmobile-app-state-'));
  const missingDb = path.join(dir, 'missing.sqlite');
  let called = false;

  const result = await syncCodexAppThreadMetadata(
    {
      threadId: 'thread-1',
      title: 'title',
      preview: 'preview',
      updatedAt: '2026-05-28T07:20:11.493Z'
    },
    {
      stateDbPath: missingDb,
      execFile: () => {
        called = true;
      }
    }
  );

  assert.deepEqual(result, { updated: false, skipped: true, reason: 'state-db-missing' });
  assert.equal(called, false);
});

test('syncCodexAppThreadMetadata invokes sqlite3 with read-write URI and bounded update SQL', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codexmobile-app-state-'));
  const stateDbPath = path.join(dir, 'state #?.sqlite');
  await fs.writeFile(stateDbPath, '', 'utf8');
  const calls = [];
  const fakeExecFile = (command, args, options, callback) => {
    calls.push({ command, args, options });
    callback(null, '1\n', '');
  };

  const result = await syncCodexAppThreadMetadata(
    {
      threadId: 'thread-1',
      title: 'title',
      preview: 'preview',
      updatedAt: '2026-05-28T07:20:11.493Z',
      cwd: dir
    },
    {
      stateDbPath,
      execFile: fakeExecFile,
      sqliteCommand: 'sqlite3-test',
      timeoutMs: 1234
    }
  );

  assert.deepEqual(result, { updated: true, skipped: false, changes: 1 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, 'sqlite3-test');
  assert.match(calls[0].args[0], /^file:\/\//);
  assert.match(calls[0].args[0], /state%20%23%3F\.sqlite\?mode=rw$/);
  assert.match(calls[0].args[1], /WHERE id = 'thread-1' AND cwd = '/);
  assert.equal(calls[0].options.timeout, 1234);
});

test('syncCodexAppThreadMetadata skips if state database disappears before sqlite opens it', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codexmobile-app-state-'));
  const stateDbPath = path.join(dir, 'state.sqlite');
  await fs.writeFile(stateDbPath, '', 'utf8');
  const fakeExecFile = async (command, args, options, callback) => {
    await fs.rm(stateDbPath, { force: true });
    callback(Object.assign(new Error('unable to open database file'), { code: 1 }), '', 'unable to open database file');
  };

  const result = await syncCodexAppThreadMetadata(
    {
      threadId: 'thread-1',
      title: 'title',
      preview: 'preview',
      updatedAt: '2026-05-28T07:20:11.493Z'
    },
    {
      stateDbPath,
      execFile: fakeExecFile
    }
  );

  assert.deepEqual(result, { updated: false, skipped: true, reason: 'state-db-missing' });
});

test('syncCodexAppThreadMetadata updates a real Codex App thread row only when fresh and cwd matches', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codexmobile-app-state-'));
  const stateDbPath = path.join(dir, 'state.sqlite');
  const projectPath = path.join(dir, 'project');
  await fs.mkdir(projectPath);
  await execFileAsync('sqlite3', [
    stateDbPath,
    [
      'CREATE TABLE threads (id TEXT PRIMARY KEY, title TEXT, preview TEXT, cwd TEXT, updated_at INTEGER, updated_at_ms INTEGER);',
      `INSERT INTO threads VALUES ('thread-1', 'old', 'old preview', '${projectPath.replaceAll("'", "''")}', 1000, 1000000);`
    ].join('\n')
  ]);

  const updated = await syncCodexAppThreadMetadata(
    {
      threadId: 'thread-1',
      title: 'new title',
      preview: 'new preview',
      updatedAt: '2026-05-28T07:20:11.493Z',
      cwd: projectPath
    },
    { stateDbPath }
  );
  assert.deepEqual(updated, { updated: true, skipped: false, changes: 1 });

  const stale = await syncCodexAppThreadMetadata(
    {
      threadId: 'thread-1',
      title: 'stale title',
      preview: 'stale preview',
      updatedAt: '2026-05-28T07:20:10.493Z',
      cwd: projectPath
    },
    { stateDbPath }
  );
  assert.deepEqual(stale, { updated: false, skipped: false, changes: 0 });

  const wrongCwd = await syncCodexAppThreadMetadata(
    {
      threadId: 'thread-1',
      title: 'wrong cwd title',
      preview: 'wrong cwd preview',
      updatedAt: '2026-05-28T07:20:12.493Z',
      cwd: path.join(dir, 'other')
    },
    { stateDbPath }
  );
  assert.deepEqual(wrongCwd, { updated: false, skipped: false, changes: 0 });

  const { stdout } = await execFileAsync('sqlite3', [
    stateDbPath,
    "SELECT title || char(10) || preview || char(10) || updated_at_ms FROM threads WHERE id='thread-1';"
  ]);
  assert.deepEqual(stdout.trim().split('\n'), ['new title', 'new preview', '1779952811493']);
});

test('syncCodexAppThreadMetadata refreshes null timestamp columns', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codexmobile-app-state-'));
  const stateDbPath = path.join(dir, 'state.sqlite');
  const projectPath = path.join(dir, 'project');
  await fs.mkdir(projectPath);
  await execFileAsync('sqlite3', [
    stateDbPath,
    [
      'CREATE TABLE threads (id TEXT PRIMARY KEY, title TEXT, preview TEXT, cwd TEXT, updated_at INTEGER, updated_at_ms INTEGER);',
      `INSERT INTO threads VALUES ('thread-null', 'old', 'old preview', '${projectPath.replaceAll("'", "''")}', NULL, NULL);`
    ].join('\n')
  ]);

  const result = await syncCodexAppThreadMetadata(
    {
      threadId: 'thread-null',
      title: 'new title',
      preview: 'new preview',
      updatedAt: '2026-05-28T07:20:11.493Z',
      cwd: projectPath
    },
    { stateDbPath }
  );
  const { stdout } = await execFileAsync('sqlite3', [
    stateDbPath,
    "SELECT updated_at || char(10) || updated_at_ms FROM threads WHERE id='thread-null';"
  ]);

  assert.deepEqual(result, { updated: true, skipped: false, changes: 1 });
  assert.deepEqual(stdout.trim().split('\n'), ['1779952811', '1779952811493']);
});
