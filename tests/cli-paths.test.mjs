import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import {
  resolveRuntimePaths,
  resolveUserDataDir
} from '../cli/paths.mjs';

test('resolveUserDataDir uses macOS Application Support by default', () => {
  assert.equal(
    resolveUserDataDir({
      platform: 'darwin',
      env: {},
      homedir: '/Users/alice'
    }),
    '/Users/alice/Library/Application Support/CodexMobile'
  );
});

test('resolveUserDataDir uses Windows APPDATA by default', () => {
  assert.equal(
    resolveUserDataDir({
      platform: 'win32',
      env: { APPDATA: 'C:\\Users\\alice\\AppData\\Roaming' },
      homedir: 'C:\\Users\\alice'
    }),
    'C:\\Users\\alice\\AppData\\Roaming\\CodexMobile'
  );
});

test('resolveUserDataDir uses XDG data home on Linux', () => {
  assert.equal(
    resolveUserDataDir({
      platform: 'linux',
      env: { XDG_DATA_HOME: '/home/alice/.local/share' },
      homedir: '/home/alice'
    }),
    '/home/alice/.local/share/codexmobile'
  );
});

test('resolveUserDataDir allows CODEXMOBILE_HOME override', () => {
  assert.equal(
    resolveUserDataDir({
      platform: 'darwin',
      env: { CODEXMOBILE_HOME: '/tmp/cm' },
      homedir: '/Users/alice'
    }),
    '/tmp/cm'
  );
});

test('resolveRuntimePaths returns stable data, log, config, and LaunchAgent paths', () => {
  const paths = resolveRuntimePaths({
    platform: 'darwin',
    env: {},
    homedir: '/Users/alice',
    cwd: '/repo/codexmobile'
  });

  assert.equal(paths.dataDir, '/Users/alice/Library/Application Support/CodexMobile');
  assert.equal(paths.logDir, '/Users/alice/Library/Logs/CodexMobile');
  assert.equal(paths.configPath, '/Users/alice/Library/Application Support/CodexMobile/config.json');
  assert.equal(paths.codexHome, '/Users/alice/.codex');
  assert.equal(paths.launchAgentPath, '/Users/alice/Library/LaunchAgents/com.codexmobile.agent.plist');
  assert.equal(paths.repoRoot, path.resolve('/repo/codexmobile'));
});

test('resolveRuntimePaths allows CODEX_HOME override', () => {
  const paths = resolveRuntimePaths({
    platform: 'linux',
    env: {
      CODEXMOBILE_HOME: '/tmp/cm',
      CODEX_HOME: '/tmp/codex-home'
    },
    homedir: '/home/alice',
    cwd: '/repo/codexmobile'
  });

  assert.equal(paths.dataDir, '/tmp/cm');
  assert.equal(paths.codexHome, '/tmp/codex-home');
  assert.equal(paths.codexConfigPath, '/tmp/codex-home/config.toml');
});
