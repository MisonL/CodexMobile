import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  createSmokeRuntime,
  terminateSmokeChildren
} from '../scripts/relay-real-chat-smoke-runtime.mjs';
import {
  resolveRelaySecret
} from '../scripts/relay-real-chat-smoke.mjs';
import { copyCodexRuntime, defaultRelayBaseUrl } from '../scripts/relay-real-chat-smoke-utils.mjs';

test('copyCodexRuntime writes copied credentials with owner-only permissions', async () => {
  const sourceHome = await fs.mkdtemp(path.join(os.tmpdir(), 'codexmobile-real-chat-source-'));
  const targetHome = await fs.mkdtemp(path.join(os.tmpdir(), 'codexmobile-real-chat-target-'));
  const previousSourceHome = process.env.CODEXMOBILE_REAL_CHAT_SOURCE_CODEX_HOME;
  process.env.CODEXMOBILE_REAL_CHAT_SOURCE_CODEX_HOME = sourceHome;

  try {
    await fs.writeFile(path.join(sourceHome, 'auth.json'), '{"token":"secret"}\n', { mode: 0o644 });
    await copyCodexRuntime(targetHome);
    const stat = await fs.stat(path.join(targetHome, 'auth.json'));

    assert.equal(stat.mode & 0o777, 0o600);
  } finally {
    if (previousSourceHome === undefined) {
      delete process.env.CODEXMOBILE_REAL_CHAT_SOURCE_CODEX_HOME;
    } else {
      process.env.CODEXMOBILE_REAL_CHAT_SOURCE_CODEX_HOME = previousSourceHome;
    }
    await fs.rm(sourceHome, { recursive: true, force: true });
    await fs.rm(targetHome, { recursive: true, force: true });
  }
});

test('resolveRelaySecret only defaults for the local relay fixture', () => {
  assert.equal(
    resolveRelaySecret({
      baseUrl: defaultRelayBaseUrl(),
      env: {}
    }),
    'local-test-secret-12345678901234567890'
  );
  assert.equal(
    resolveRelaySecret({
      baseUrl: 'https://example-relay.test',
      env: { CODEXMOBILE_RELAY_SECRET: 'configured-secret-0123456789abcdef' }
    }),
    'configured-secret-0123456789abcdef'
  );
  assert.throws(
    () => resolveRelaySecret({
      baseUrl: 'https://example-relay.test',
      env: {}
    }),
    /CODEXMOBILE_RELAY_SECRET is required/
  );
});

test('createSmokeRuntime removes temp homes when runtime copy fails', async () => {
  const sourceHome = await fs.mkdtemp(path.join(os.tmpdir(), 'codexmobile-real-chat-bad-source-'));
  const previousSourceHome = process.env.CODEXMOBILE_REAL_CHAT_SOURCE_CODEX_HOME;
  process.env.CODEXMOBILE_REAL_CHAT_SOURCE_CODEX_HOME = sourceHome;
  const before = new Set(await fs.readdir(os.tmpdir()));

  try {
    await fs.mkdir(path.join(sourceHome, 'auth.json'));
    let copyError = null;
    try {
      await createSmokeRuntime({
        macUrl: 'ws://127.0.0.1:9791/relay/mac',
        relaySecret: 'local-test-secret-12345678901234567890',
        localPort: 3321,
        connectorId: 'cleanup-test',
        rootDir: process.cwd()
      });
    } catch (error) {
      copyError = error;
    }
    assert.ok(copyError);
    assert.ok(['EISDIR', 'ENOTSUP', 'EPERM', 'EACCES'].includes(copyError.code), copyError.message);
    const after = await fs.readdir(os.tmpdir());
    const leaked = after.filter((name) => (
      !before.has(name) &&
      (name.startsWith('codexmobile-real-chat-codehome.') ||
        name.startsWith('codexmobile-real-chat-mobilehome.'))
    ));
    assert.deepEqual(leaked, []);
  } finally {
    if (previousSourceHome === undefined) {
      delete process.env.CODEXMOBILE_REAL_CHAT_SOURCE_CODEX_HOME;
    } else {
      process.env.CODEXMOBILE_REAL_CHAT_SOURCE_CODEX_HOME = previousSourceHome;
    }
    await fs.rm(sourceHome, { recursive: true, force: true });
  }
});

test('terminateSmokeChildren escalates SIGTERM survivors to SIGKILL', async () => {
  const calls = [];
  const survivor = {
    exitCode: null,
    signalCode: null,
    killed: false,
    kill(signal) {
      this.killed = true;
      calls.push(['survivor', signal]);
      return true;
    }
  };
  const graceful = {
    exitCode: null,
    signalCode: null,
    killed: false,
    kill(signal) {
      this.killed = true;
      calls.push(['graceful', signal]);
      if (signal === 'SIGTERM') {
        this.signalCode = signal;
      }
      return true;
    }
  };
  const exited = {
    exitCode: 0,
    signalCode: null,
    killed: false,
    kill(signal) {
      calls.push(['exited', signal]);
      return true;
    }
  };

  await terminateSmokeChildren([survivor, graceful, exited], {
    graceMs: 0,
    sleepFn: async () => {}
  });

  assert.deepEqual(calls, [
    ['graceful', 'SIGTERM'],
    ['survivor', 'SIGTERM'],
    ['survivor', 'SIGKILL']
  ]);
  assert.equal(survivor.killed, true);
});
