import assert from 'node:assert/strict';
import test from 'node:test';

import {
  detectPortOwners,
  isCodexMobileServerCommand,
  takeOverPort
} from '../cli/service-takeover.mjs';

test('isCodexMobileServerCommand recognizes supported server entrypoints', () => {
  assert.equal(isCodexMobileServerCommand('node server/index.js'), true);
  assert.equal(isCodexMobileServerCommand('node /repo/bin/codexmobile.mjs serve'), true);
  assert.equal(isCodexMobileServerCommand('node other-server.js'), false);
  assert.equal(
    isCodexMobileServerCommand('node server/index.js', { repoRoot: '/repo/codexmobile', cwd: '/repo/codexmobile' }),
    true
  );
  assert.equal(
    isCodexMobileServerCommand('node server/index.js', { repoRoot: '/repo/codexmobile', cwd: '/repo/other' }),
    false
  );
});

test('detectPortOwners uses process cwd to avoid taking over unrelated server/index.js', async () => {
  const execFile = (command, args, _options, callback) => {
    if (command === 'lsof' && args.includes('-tiTCP:3321')) {
      callback(null, '123\n456\n', '');
      return;
    }
    if (command === 'ps' && args.includes('123')) {
      callback(null, 'node server/index.js\n', '');
      return;
    }
    if (command === 'ps' && args.includes('456')) {
      callback(null, 'node server/index.js\n', '');
      return;
    }
    if (command === 'lsof' && args.includes('123')) {
      callback(null, 'p123\nn/repo/codexmobile\n', '');
      return;
    }
    if (command === 'lsof' && args.includes('456')) {
      callback(null, 'p456\nn/repo/other\n', '');
      return;
    }
    callback(Object.assign(new Error('unexpected'), { code: 1 }), '', 'unexpected');
  };

  const result = await detectPortOwners({
    port: 3321,
    repoRoot: '/repo/codexmobile',
    execFile
  });

  assert.deepEqual(result.owners.map((owner) => ({
    pid: owner.pid,
    cwd: owner.cwd,
    codexMobile: owner.codexMobile
  })), [
    { pid: 123, cwd: '/repo/codexmobile', codexMobile: true },
    { pid: 456, cwd: '/repo/other', codexMobile: false }
  ]);
});

test('takeOverPort requires confirmation before stopping unmanaged CodexMobile server', async () => {
  const result = await takeOverPort({
    detectPortOwners: async () => ({
      port: 3321,
      owners: [{ pid: 123, command: 'node server/index.js', codexMobile: true }]
    })
  });

  assert.equal(result.ok, false);
  assert.equal(result.action, 'confirm-required');
});

test('takeOverPort blocks non-CodexMobile port owners', async () => {
  const result = await takeOverPort({
    yes: true,
    detectPortOwners: async () => ({
      port: 3321,
      owners: [{ pid: 123, command: 'python -m http.server', codexMobile: false }]
    })
  });

  assert.equal(result.ok, false);
  assert.equal(result.action, 'blocked');
});

test('takeOverPort blocks setup when port owner detection is unavailable', async () => {
  const result = await takeOverPort({
    yes: true,
    detectPortOwners: async () => ({
      port: 3321,
      supported: false,
      owners: [],
      error: 'lsof unavailable'
    })
  });

  assert.equal(result.ok, false);
  assert.equal(result.action, 'unsupported');
  assert.match(result.error, /lsof unavailable/);
});

test('takeOverPort dry-run reports takeover without killing', async () => {
  const killed = [];
  const result = await takeOverPort({
    dryRun: true,
    confirm: true,
    kill: (pid) => killed.push(pid),
    detectPortOwners: async () => ({
      port: 3321,
      owners: [{ pid: 123, command: 'node server/index.js', codexMobile: true }]
    })
  });

  assert.equal(result.ok, true);
  assert.equal(result.action, 'would-stop-unmanaged');
  assert.deepEqual(killed, []);
});

test('takeOverPort validateOnly verifies safe owners without killing', async () => {
  const killed = [];
  const result = await takeOverPort({
    validateOnly: true,
    kill: (pid) => killed.push(pid),
    detectPortOwners: async () => ({
      port: 3321,
      owners: [{ pid: 123, command: 'node server/index.js', codexMobile: true }]
    })
  });

  assert.equal(result.ok, true);
  assert.equal(result.action, 'verified');
  assert.deepEqual(killed, []);
});

test('takeOverPort stops confirmed unmanaged CodexMobile server', async () => {
  const killed = [];
  let calls = 0;
  const result = await takeOverPort({
    confirm: true,
    kill: (pid, signal) => killed.push({ pid, signal }),
    detectPortOwners: async () => {
      calls += 1;
      return {
        port: 3321,
        owners: calls === 1
          ? [{ pid: 123, command: 'node server/index.js', codexMobile: true }]
          : []
      };
    }
  });

  assert.equal(result.ok, true);
  assert.equal(result.action, 'stopped-unmanaged');
  assert.deepEqual(killed, [{ pid: 123, signal: 'SIGTERM' }]);
  assert.equal(result.waitMs >= 0, true);
});

test('takeOverPort tolerates a process that exits before SIGTERM', async () => {
  let calls = 0;
  const result = await takeOverPort({
    confirm: true,
    kill: () => {
      throw Object.assign(new Error('gone'), { code: 'ESRCH' });
    },
    detectPortOwners: async () => {
      calls += 1;
      return {
        port: 3321,
        owners: calls === 1
          ? [{ pid: 123, command: 'node server/index.js', codexMobile: true }]
          : []
      };
    }
  });

  assert.equal(result.ok, true);
  assert.equal(result.action, 'stopped-unmanaged');
});

test('takeOverPort does not treat lost detection during wait as cleared', async () => {
  let calls = 0;
  const result = await takeOverPort({
    confirm: true,
    kill: () => {},
    detectPortOwners: async () => {
      calls += 1;
      if (calls === 1) {
        return {
          port: 3321,
          owners: [{ pid: 123, command: 'node server/index.js', codexMobile: true }]
        };
      }
      return {
        port: 3321,
        supported: false,
        owners: [],
        error: 'lsof unavailable'
      };
    }
  });

  assert.equal(result.ok, false);
  assert.equal(result.action, 'port-still-listening');
  assert.match(result.error, /lsof unavailable/);
});

test('takeOverPort reports a timeout if the port is not released', async () => {
  const result = await takeOverPort({
    confirm: true,
    waitTimeoutMs: 1,
    waitIntervalMs: 1,
    kill: () => {},
    detectPortOwners: async () => ({
      port: 3321,
      owners: [{ pid: 123, command: 'node server/index.js', codexMobile: true }]
    })
  });

  assert.equal(result.ok, false);
  assert.equal(result.action, 'port-still-listening');
});
