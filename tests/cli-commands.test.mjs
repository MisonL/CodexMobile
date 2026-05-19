import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

import { runCli } from '../cli/commands.mjs';

const execFileAsync = promisify(execFile);
const root = path.resolve(import.meta.dirname, '..');

async function makeFixture() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'codexmobile-cli-home-'));
  const codexHome = path.join(home, '.codex');
  await fs.mkdir(codexHome, { recursive: true });
  await fs.writeFile(path.join(codexHome, 'config.toml'), 'model = "gpt-5.4-mini"\n', 'utf8');
  return {
    platform: 'darwin',
    env: {
      CODEXMOBILE_HOME: path.join(home, 'Library', 'Application Support', 'CodexMobile'),
      CODEX_HOME: codexHome
    },
    homedir: home,
    cwd: root,
    execFile: (command, args, options, callback) => {
      callback(Object.assign(new Error(`${command} unavailable`), { code: 'ENOENT' }));
    },
    portProbe: async (port) => ({
      port,
      status: 'available',
      detail: 'fixture port probe'
    }),
    stdout: () => {},
    stderr: () => {}
  };
}

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

test('runCli returns status JSON with runtime paths', async () => {
  const options = await makeFixture();
  const result = await runCli(['status', '--json'], options);

  assert.equal(result.code, 0);
  assert.equal(result.output.command, 'status');
  assert.equal(result.output.paths.logDir, path.join(options.homedir, 'Library', 'Logs', 'CodexMobile'));
  assert.equal(result.output.process.managed, false);
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

test('runCli returns macOS install dry-run plan without writing files', async () => {
  const options = await makeFixture();
  const result = await runCli(['install', '--dry-run', '--json'], options);

  assert.equal(result.code, 0);
  assert.equal(result.output.command, 'install');
  assert.equal(result.output.dryRun, true);
  assert.equal(result.output.wouldWrite.length, 1);

  await assert.rejects(
    fs.stat(result.output.wouldWrite[0].path),
    (error) => error.code === 'ENOENT'
  );
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
  assert.equal(packageJson.scripts.start, 'node server/index.js');
  assert.ok(packageJson.files.includes('asr-service/'));
  assert.ok(packageJson.files.includes('bin/'));
  assert.ok(packageJson.files.includes('cli/'));
  assert.ok(packageJson.files.includes('client/dist/'));
});
