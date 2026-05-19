import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { startManagedServer } from '../cli/process-manager.mjs';
import { resolveRuntimePaths } from '../cli/paths.mjs';

async function makePaths() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'codexmobile-process-start-home-'));
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

test('startManagedServer removes stale managed state when PID is reused by another process', async () => {
  const paths = await makePaths();
  await fs.mkdir(paths.runDir, { recursive: true });
  await fs.writeFile(
    paths.processStatePath,
    JSON.stringify({
      version: 1,
      kind: 'codexmobile-server',
      pid: 223,
      command: ['/usr/local/bin/node', '/repo/bin/codexmobile.mjs', 'serve']
    }),
    'utf8'
  );
  const spawnCalls = [];
  const result = await startManagedServer({
    paths,
    isProcessRunning: () => true,
    isManagedProcessAlive: () => false,
    spawn: (...args) => {
      spawnCalls.push(args);
      return { pid: 334, unref() {} };
    }
  });
  const state = JSON.parse(await fs.readFile(paths.processStatePath, 'utf8'));

  assert.equal(result.started, true);
  assert.equal(result.pid, 334);
  assert.equal(spawnCalls.length, 1);
  assert.equal(state.pid, 334);
});

test('startManagedServer removes malformed managed state instead of treating it as running', async () => {
  const paths = await makePaths();
  await fs.mkdir(paths.runDir, { recursive: true });
  await fs.writeFile(
    paths.processStatePath,
    JSON.stringify({
      version: 1,
      kind: 'codexmobile-server',
      pid: 224
    }),
    'utf8'
  );
  const spawnCalls = [];
  const result = await startManagedServer({
    paths,
    isProcessRunning: () => true,
    spawn: (...args) => {
      spawnCalls.push(args);
      return { pid: 335, unref() {} };
    }
  });
  const state = JSON.parse(await fs.readFile(paths.processStatePath, 'utf8'));

  assert.equal(result.started, true);
  assert.equal(result.pid, 335);
  assert.equal(spawnCalls.length, 1);
  assert.equal(state.pid, 335);
  assert.deepEqual(state.command.slice(-1), ['serve']);
});
