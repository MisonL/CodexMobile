import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

import { runCli } from '../cli/commands.mjs';
import { makeFixture, root } from './cli-test-fixtures.mjs';

const execFileAsync = promisify(execFile);

test('runCli returns JSON doctor report without external dependencies', async () => {
  const options = await makeFixture();
  const result = await runCli(['doctor', '--json'], options);

  assert.equal(result.code, 0);
  assert.equal(result.output.command, 'doctor');
  assert.equal(result.output.paths.dataDir, options.env.CODEXMOBILE_HOME);
  assert.equal(result.output.checks.codexConfig.status, 'passed');
  assert.equal(result.output.checks.httpPort.status, 'available');
  assert.equal(result.output.checks.tailscale.status, 'skipped');
});

test('runCli returns a failing code when doctor required checks fail', async () => {
  const options = await makeFixture();
  const result = await runCli(['doctor', '--json'], {
    ...options,
    env: {
      ...options.env,
      CODEX_HOME: path.join(options.homedir, 'missing-codex-home')
    }
  });

  assert.equal(result.code, 1);
  assert.equal(result.output.ok, false);
  assert.equal(result.output.checks.codexConfig.status, 'failed');
});

test('runCli doctor enforces the exact Node.js version floor', async () => {
  const options = await makeFixture();
  const result = await runCli(['doctor', '--json'], {
    ...options,
    nodeVersion: '20.18.1'
  });

  assert.equal(result.code, 1);
  assert.equal(result.output.ok, false);
  assert.equal(result.output.node.status, 'failed');
  assert.equal(result.output.node.minimumVersion, '20.19.0');
});

test('runCli returns status JSON with runtime paths', async () => {
  const options = await makeFixture();
  const result = await runCli(['status', '--json'], options);

  assert.equal(result.code, 0);
  assert.equal(result.output.command, 'status');
  assert.equal(result.output.paths.logDir, path.join(options.homedir, 'Library', 'Logs', 'CodexMobile'));
  assert.equal(result.output.process.managed, false);
  assert.equal(result.output.launchAgent.relayConnector.loaded, false);
});

test('runCli routes lifecycle commands through injected process manager helpers', async () => {
  const options = await makeFixture();
  const calls = [];
  const processManager = {
    startManagedServer: async () => {
      calls.push('start');
      return { command: 'start', ok: true, started: true, pid: 111 };
    },
    stopManagedServer: async () => {
      calls.push('stop');
      return { command: 'stop', ok: true, stopped: true, pid: 111 };
    },
    restartManagedServer: async () => {
      calls.push('restart');
      return { command: 'restart', ok: true, stopped: true, started: true, pid: 112 };
    },
    readManagedLogs: async () => {
      calls.push('logs');
      return { command: 'logs', ok: true, text: 'server log' };
    }
  };

  assert.equal((await runCli(['start', '--json'], { ...options, processManager })).output.command, 'start');
  assert.equal((await runCli(['stop', '--json'], { ...options, processManager })).output.command, 'stop');
  assert.equal((await runCli(['restart', '--json'], { ...options, processManager })).output.command, 'restart');
  assert.equal((await runCli(['logs', '--json'], { ...options, processManager })).output.text, 'server log');
  assert.deepEqual(calls, ['start', 'stop', 'restart', 'logs']);
});

test('runCli saves and shows redacted relay connector config', async () => {
  const options = await makeFixture();
  const secret = '0123456789abcdef0123456789abcdef';
  const saved = await runCli([
    'relay-config',
    '--url',
    'wss://space.example/relay/mac',
    '--secret',
    secret,
    '--local-url',
    'http://127.0.0.1:3321',
    '--json'
  ], options);
  const shown = await runCli(['relay-config', '--json'], options);
  const status = await runCli(['status', '--json'], options);

  assert.equal(saved.code, 0);
  assert.equal(saved.output.command, 'relay-config');
  assert.equal(saved.output.config.relaySecret, '[redacted]');
  assert.equal(shown.code, 0);
  assert.equal(shown.output.config.relayUrl, 'wss://space.example/relay/mac');
  assert.equal(shown.output.config.relaySecret, '[redacted]');
  assert.equal(status.output.relayConfig.configured, true);
  assert.equal(status.output.relayConfig.config.relaySecret, '[redacted]');
  assert.doesNotMatch(JSON.stringify(saved.output), new RegExp(secret));
  assert.doesNotMatch(JSON.stringify(shown.output), new RegExp(secret));
  assert.doesNotMatch(JSON.stringify(status.output), new RegExp(secret));
});

test('runCli rejects weak relay connector secret', async () => {
  const options = await makeFixture();
  const result = await runCli([
    'relay-config',
    '--url',
    'wss://space.example/relay/mac',
    '--secret',
    'short-secret',
    '--json'
  ], options);

  assert.equal(result.code, 1);
  assert.equal(result.output.ok, false);
  assert.match(result.output.error, /at least 32 characters/);
});

test('bin/codexmobile.mjs supports doctor --json', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'codexmobile-cli-bin-home-'));
  const codexHome = path.join(home, '.codex');
  await fs.mkdir(codexHome, { recursive: true });
  await fs.writeFile(path.join(codexHome, 'config.toml'), 'model = "gpt-5.4-mini"\n', 'utf8');

  const { stdout } = await execFileAsync(
    process.execPath,
    [path.join(root, 'bin', 'codexmobile.mjs'), 'doctor', '--json'],
    {
      cwd: root,
      env: {
        ...process.env,
        CODEXMOBILE_HOME: path.join(home, 'Library', 'Application Support', 'CodexMobile'),
        CODEX_HOME: codexHome
      }
    }
  );
  const output = JSON.parse(stdout);

  assert.equal(output.command, 'doctor');
  assert.equal(output.checks.codexConfig.status, 'passed');
});

test('package metadata exposes CLI bin and preserves existing start script', async () => {
  const packageJson = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));

  assert.equal(packageJson.bin.codexmobile, './bin/codexmobile.mjs');
  assert.equal(packageJson.engines.node, '>=20.19.0');
  assert.equal(packageJson.scripts.start, 'node server/index.js');
  assert.equal(packageJson.scripts['smoke:relay:real-chat'], 'node scripts/relay-real-chat-smoke.mjs');
  assert.ok(packageJson.files.includes('asr-service/'));
  assert.ok(packageJson.files.includes('bin/'));
  assert.ok(packageJson.files.includes('cli/'));
  assert.ok(packageJson.files.includes('client/dist/'));
});
