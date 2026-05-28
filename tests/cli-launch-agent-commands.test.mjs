import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { runCli } from '../cli/commands.mjs';
import { makeFixture } from './cli-test-fixtures.mjs';

test('runCli routes LaunchAgent install and uninstall commands through injected helpers', async () => {
  const options = await makeFixture();
  const calls = [];
  const launchAgent = {
    buildMacInstallPlan: (helperOptions) => {
      calls.push({ command: 'dry-run', relayConfigured: helperOptions.relayConfigured });
      return { command: 'install', ok: true, dryRun: true };
    },
    installMacLaunchAgent: async (helperOptions) => {
      calls.push({ command: 'install', relayConfigured: helperOptions.relayConfigured });
      return { command: 'install', ok: true, installed: true };
    },
    uninstallMacLaunchAgent: async (helperOptions) => {
      calls.push({
        command: 'uninstall',
        removeData: helperOptions.removeData,
        confirmRemoveData: helperOptions.confirmRemoveData
      });
      return { command: 'uninstall', ok: true, uninstalled: true };
    },
    enableMacLaunchAgent: async (helperOptions) => {
      calls.push({ command: 'enable', relayConfigured: helperOptions.relayConfigured });
      return { command: 'enable', ok: true, enabled: true };
    },
    disableMacLaunchAgent: async () => {
      calls.push('disable');
      return { command: 'disable', ok: true, disabled: true };
    }
  };

  assert.equal((await runCli(['install', '--dry-run', '--json'], { ...options, launchAgent })).output.dryRun, true);
  assert.equal((await runCli(['install', '--json'], { ...options, launchAgent })).output.installed, true);
  assert.equal((await runCli(['uninstall', '--json'], { ...options, launchAgent })).output.uninstalled, true);
  assert.equal(
    (await runCli(['uninstall', '--remove-data', '--confirm-remove-data', '--json'], {
      ...options,
      launchAgent
    })).output.uninstalled,
    true
  );
  assert.equal((await runCli(['enable', '--json'], { ...options, launchAgent })).output.enabled, true);
  assert.equal((await runCli(['disable', '--json'], { ...options, launchAgent })).output.disabled, true);
  assert.deepEqual(calls, [
    { command: 'dry-run', relayConfigured: false },
    { command: 'install', relayConfigured: false },
    { command: 'uninstall', removeData: false, confirmRemoveData: false },
    { command: 'uninstall', removeData: true, confirmRemoveData: true },
    { command: 'enable', relayConfigured: false },
    'disable'
  ]);
});

test('runCli includes LaunchAgent cleanup details in JSON errors', async () => {
  const options = await makeFixture();
  const cleanup = [{ label: 'com.codexmobile.agent', ok: true }];
  const launchAgent = {
    installMacLaunchAgent: async () => {
      const error = new Error('install failed');
      error.cleanup = cleanup;
      throw error;
    }
  };

  const result = await runCli(['install', '--json'], { ...options, launchAgent });

  assert.equal(result.code, 1);
  assert.equal(result.output.error, 'install failed');
  assert.deepEqual(result.output.cleanup, cleanup);
});

test('runCli returns macOS install dry-run plan without writing files', async () => {
  const options = await makeFixture();
  const result = await runCli(['install', '--dry-run', '--json'], options);

  assert.equal(result.code, 0);
  assert.equal(result.output.command, 'install');
  assert.equal(result.output.dryRun, true);
  assert.equal(result.output.relayConfigured, false);
  assert.equal(result.output.relaySkipped, 'relay-config-missing');
  assert.equal(result.output.wouldWrite.length, 1);

  for (const item of result.output.wouldWrite) {
    await assert.rejects(
      fs.stat(item.path),
      (error) => error.code === 'ENOENT'
    );
  }
});

test('runCli includes relay LaunchAgent in install dry-run after relay config is saved', async () => {
  const options = await makeFixture();
  const secret = '0123456789abcdef0123456789abcdef';
  await runCli([
    'relay-config',
    '--url',
    'wss://space.example/relay/mac',
    '--secret',
    secret,
    '--json'
  ], options);
  const result = await runCli(['install', '--dry-run', '--json'], options);

  assert.equal(result.code, 0);
  assert.equal(result.output.relayConfigured, true);
  assert.equal(result.output.relaySkipped, '');
  assert.equal(result.output.wouldWrite.length, 2);
  assert.match(result.output.wouldWrite[1].path, /com\.codexmobile\.relay-connector\.plist$/);
  assert.match(result.output.wouldWrite[1].content, /relay-mac-client\.mjs/);
  assert.doesNotMatch(result.output.wouldWrite[1].content, /undefined/);
});

test('runCli enable writes relay LaunchAgent after relay config is saved later', async () => {
  const options = await makeFixture();
  const calls = [];
  const execFile = (command, args, runOptions, callback) => {
    calls.push({ command, args, options: runOptions });
    callback(null, 'ok\n', '');
  };
  const install = await runCli(['install', '--json'], { ...options, execFile });
  const secret = '0123456789abcdef0123456789abcdef';
  const configured = await runCli([
    'relay-config',
    '--url',
    'wss://space.example/relay/mac',
    '--secret',
    secret,
    '--json'
  ], { ...options, execFile });
  const enabled = await runCli(['enable', '--json'], { ...options, execFile });

  assert.equal(install.code, 0);
  assert.equal(install.output.relayInstalled, false);
  assert.equal(configured.code, 0);
  assert.equal(enabled.code, 0);
  assert.equal(enabled.output.plistWritten, true);
  assert.equal(enabled.output.relayEnabled, true);
  assert.equal(enabled.output.relayPlistWritten, true);
  const serverPlistPath = path.join(options.homedir, 'Library', 'LaunchAgents', 'com.codexmobile.agent.plist');
  const relayPlistPath = path.join(options.homedir, 'Library', 'LaunchAgents', 'com.codexmobile.relay-connector.plist');
  const serverPlist = await fs.readFile(serverPlistPath, 'utf8');
  const relayPlist = await fs.readFile(relayPlistPath, 'utf8');
  assert.match(serverPlist, /codexmobile\.mjs/);
  assert.match(relayPlist, /relay-mac-client\.mjs/);
  assert.deepEqual(
    calls.map((call) => [call.command, ...call.args]).filter((call) => call[0] === 'plutil'),
    [
      ['plutil', '-lint', path.join(options.homedir, 'Library', 'LaunchAgents', 'com.codexmobile.agent.plist')],
      ['plutil', '-lint', serverPlistPath],
      ['plutil', '-lint', relayPlistPath]
    ]
  );
});
