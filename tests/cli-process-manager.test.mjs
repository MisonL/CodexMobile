import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  collectManagedProcessStatus,
  dedupePath,
  readManagedLogs,
  redactLogText,
  startManagedServer,
  stopManagedServer
} from '../cli/process-manager.mjs';
import { resolveRuntimePaths } from '../cli/paths.mjs';

async function makePaths() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'codexmobile-process-home-'));
  return resolveRuntimePaths({
    platform: 'darwin',
    env: {
      CODEXMOBILE_HOME: path.join(home, 'Library', 'Application Support', 'CodexMobile'),
      CODEX_HOME: path.join(home, '.codex')
    },
    homedir: home,
    cwd: '/repo/codexmobile'
  });
}

test('dedupePath removes duplicate Windows path entries case-insensitively', () => {
  assert.equal(
    dedupePath('C:\\A;C:\\a;C:\\B', { platform: 'win32' }),
    'C:\\A;C:\\B'
  );
});

test('startManagedServer spawns serve command and writes managed process state', async () => {
  const paths = await makePaths();
  const spawnCalls = [];
  const result = await startManagedServer({
    paths,
    nodePath: '/usr/local/bin/node',
    cliPath: '/repo/bin/codexmobile.mjs',
    env: { PATH: '/bin', CODEX_HOME: paths.codexHome },
    spawn: (command, args, options) => {
      spawnCalls.push({ command, args, options });
      return { pid: 12345, unref() {} };
    }
  });
  const state = JSON.parse(await fs.readFile(paths.processStatePath, 'utf8'));

  assert.equal(result.started, true);
  assert.equal(result.pid, 12345);
  assert.equal(spawnCalls[0].command, '/usr/local/bin/node');
  assert.deepEqual(spawnCalls[0].args, ['/repo/bin/codexmobile.mjs', 'serve']);
  assert.equal(spawnCalls[0].options.detached, true);
  assert.equal(spawnCalls[0].options.env.CODEXMOBILE_HOME, paths.dataDir);
  assert.equal(state.kind, 'codexmobile-server');
  assert.equal(state.pid, 12345);
});

test('startManagedServer passes a deduplicated Windows Path to child process', async () => {
  const paths = await makePaths();
  const spawnCalls = [];
  await startManagedServer({
    paths,
    platform: 'win32',
    env: {
      Path: 'C:\\A;C:\\B',
      PATH: 'C:\\a;C:\\C',
      CODEX_HOME: paths.codexHome
    },
    spawn: (command, args, options) => {
      spawnCalls.push({ command, args, options });
      return { pid: 12346, unref() {} };
    }
  });

  assert.equal(spawnCalls[0].options.env.Path, 'C:\\A;C:\\B;C:\\C');
  assert.equal('PATH' in spawnCalls[0].options.env, false);
  assert.equal(spawnCalls[0].options.env.CODEXMOBILE_HOME, paths.dataDir);
});

test('startManagedServer does not spawn a duplicate managed process', async () => {
  const paths = await makePaths();
  await fs.mkdir(paths.runDir, { recursive: true });
  await fs.writeFile(
    paths.processStatePath,
    JSON.stringify({
      version: 1,
      kind: 'codexmobile-server',
      pid: 222,
      command: ['/usr/local/bin/node', '/repo/bin/codexmobile.mjs', 'serve']
    }),
    'utf8'
  );
  const spawnCalls = [];
  const result = await startManagedServer({
    paths,
    isProcessRunning: (pid) => pid === 222,
    isManagedProcessAlive: () => true,
    spawn: (...args) => {
      spawnCalls.push(args);
      return { pid: 333, unref() {} };
    }
  });

  assert.equal(result.started, false);
  assert.equal(result.pid, 222);
  assert.deepEqual(spawnCalls, []);
});

test('stopManagedServer refuses to kill state that is not owned by CodexMobile', async () => {
  const paths = await makePaths();
  await fs.mkdir(paths.runDir, { recursive: true });
  await fs.writeFile(
    paths.processStatePath,
    JSON.stringify({ version: 1, kind: 'other-process', pid: 321 }),
    'utf8'
  );
  const killCalls = [];
  const result = await stopManagedServer({
    paths,
    kill: (...args) => {
      killCalls.push(args);
      return true;
    }
  });

  assert.equal(result.stopped, false);
  assert.match(result.error, /not managed by CodexMobile/);
  assert.deepEqual(killCalls, []);
});

test('stopManagedServer removes stale managed state without killing a process', async () => {
  const paths = await makePaths();
  await fs.mkdir(paths.runDir, { recursive: true });
  await fs.writeFile(
    paths.processStatePath,
    JSON.stringify({
      version: 1,
      kind: 'codexmobile-server',
      pid: 654,
      command: ['/usr/local/bin/node', '/repo/bin/codexmobile.mjs', 'serve']
    }),
    'utf8'
  );
  const killCalls = [];
  const result = await stopManagedServer({
    paths,
    isProcessRunning: () => false,
    kill: (...args) => {
      killCalls.push(args);
      return true;
    }
  });

  assert.equal(result.stopped, false);
  assert.equal(result.stale, true);
  assert.deepEqual(killCalls, []);
  await assert.rejects(
    fs.stat(paths.processStatePath),
    (error) => error.code === 'ENOENT'
  );
});

test('stopManagedServer removes stale managed state when PID is reused by another process', async () => {
  const paths = await makePaths();
  await fs.mkdir(paths.runDir, { recursive: true });
  await fs.writeFile(
    paths.processStatePath,
    JSON.stringify({
      version: 1,
      kind: 'codexmobile-server',
      pid: 655,
      command: ['/usr/local/bin/node', '/repo/bin/codexmobile.mjs', 'serve']
    }),
    'utf8'
  );
  const killCalls = [];
  const result = await stopManagedServer({
    paths,
    isProcessRunning: () => true,
    isManagedProcessAlive: () => false,
    kill: (...args) => {
      killCalls.push(args);
      return true;
    }
  });

  assert.equal(result.stopped, false);
  assert.equal(result.stale, true);
  assert.deepEqual(killCalls, []);
  await assert.rejects(
    fs.stat(paths.processStatePath),
    (error) => error.code === 'ENOENT'
  );
});

test('stopManagedServer verifies the live command before killing a managed PID', async () => {
  const paths = await makePaths();
  await fs.mkdir(paths.runDir, { recursive: true });
  await fs.writeFile(
    paths.processStatePath,
    JSON.stringify({
      version: 1,
      kind: 'codexmobile-server',
      pid: 656,
      command: ['/usr/local/bin/node', '/repo/bin/codexmobile.mjs', 'serve']
    }),
    'utf8'
  );
  const killCalls = [];
  const execCalls = [];
  const result = await stopManagedServer({
    paths,
    isProcessRunning: () => true,
    execFile: (command, args, options, callback) => {
      execCalls.push({ command, args, options });
      callback(null, '/usr/local/bin/node /repo/bin/codexmobile.mjs serve\n', '');
    },
    kill: (...args) => {
      killCalls.push(args);
      return true;
    }
  });

  assert.equal(result.stopped, true);
  assert.deepEqual(killCalls, [[656, 'SIGTERM']]);
  assert.equal(execCalls[0].command, 'ps');
});

test('collectManagedProcessStatus reports managed state without killing processes', async () => {
  const paths = await makePaths();
  await fs.mkdir(paths.runDir, { recursive: true });
  await fs.writeFile(
    paths.processStatePath,
    JSON.stringify({ version: 1, kind: 'codexmobile-server', pid: 456, startedAt: '2026-05-19T00:00:00.000Z' }),
    'utf8'
  );
  const status = await collectManagedProcessStatus({
    paths,
    isProcessRunning: (pid) => pid === 456
  });

  assert.equal(status.managed, true);
  assert.equal(status.running, true);
  assert.equal(status.pid, 456);
});

test('readManagedLogs returns tail output with secrets redacted', async () => {
  const paths = await makePaths();
  await fs.mkdir(paths.logDir, { recursive: true });
  await fs.writeFile(
    paths.serverOutLogPath,
    [
      'line 1',
      'CODEXMOBILE_RELAY_SECRET=super-secret-value',
      'CODEXMOBILE_PAIRING_CODE=123456',
      'Pairing code: 560586 (0 trusted device(s))',
      'Authorization: Bearer abc.def.ghi',
      'GET /ws?token=browser-token-value'
    ].join('\n'),
    'utf8'
  );
  const result = await readManagedLogs({ paths, lines: 8 });

  assert.equal(result.command, 'logs');
  assert.match(result.text, /CODEXMOBILE_RELAY_SECRET=\[redacted\]/);
  assert.match(result.text, /CODEXMOBILE_PAIRING_CODE=\[redacted\]/);
  assert.match(result.text, /Pairing code: \[redacted\]/);
  assert.match(result.text, /Authorization: Bearer \[redacted\]/);
  assert.match(result.text, /token=\[redacted\]/);
  assert.doesNotMatch(result.text, /super-secret-value|123456|560586|abc\.def\.ghi|browser-token-value/);
});

test('redactLogText redacts relay secret, bearer token, and token query values', () => {
  const text = [
    'relay secret CODEXMOBILE_RELAY_SECRET=secret-123',
    'pair CODEXMOBILE_PAIRING_CODE=123456',
    'Pairing code: 654321 (0 trusted device(s))',
    'Authorization: Bearer bearer-123',
    '/api/status?token=query-123'
  ].join('\n');

  assert.equal(
    redactLogText(text),
    [
      'relay secret CODEXMOBILE_RELAY_SECRET=[redacted]',
      'pair CODEXMOBILE_PAIRING_CODE=[redacted]',
      'Pairing code: [redacted] (0 trusted device(s))',
      'Authorization: Bearer [redacted]',
      '/api/status?token=[redacted]'
    ].join('\n')
  );
});
