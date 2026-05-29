import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { runCli } from '../cli/commands.mjs';
import { makeFixture } from './cli-test-fixtures.mjs';

function loadedLaunchAgentExecFile(command, args, _options, callback) {
  if (command === 'launchctl' && args[0] === 'print') {
    callback(null, 'loaded\n', '');
    return;
  }
  callback(Object.assign(new Error(`${command} unavailable`), { code: 'ENOENT' }), '', '');
}

test('runCli setup saves relay config, takes over old server, and installs services', async () => {
  const options = await makeFixture();
  const secret = '0123456789abcdef0123456789abcdef';
  const calls = [];
  const cleanupCalls = [];
  const launchAgent = {
    installMacLaunchAgent: async (helperOptions) => {
      calls.push({ command: 'install', relayConfigured: helperOptions.relayConfigured });
      return { command: 'install', ok: true, installed: true, relayInstalled: helperOptions.relayConfigured };
    }
  };
  const result = await runCli([
    'setup',
    '--space-url',
    'https://space.example',
    '--secret',
    secret,
    '--yes',
    '--json'
  ], {
    ...options,
    launchAgent,
    processManager: {
      removeManagedState: async ({ paths }) => cleanupCalls.push(paths.dataDir)
    },
    takeOverPort: async () => ({ ok: true, action: 'stopped-unmanaged', stoppedPids: [1234] })
  });
  const relayConfig = JSON.parse(await fs.readFile(
    path.join(options.env.CODEXMOBILE_HOME, 'relay.json'),
    'utf8'
  ));

  assert.equal(result.code, 0);
  assert.equal(result.output.command, 'setup');
  assert.equal(result.output.relayConfigured, true);
  assert.equal(result.output.takeover.action, 'stopped-unmanaged');
  assert.deepEqual(calls, [{ command: 'install', relayConfigured: true }]);
  assert.deepEqual(cleanupCalls, [options.env.CODEXMOBILE_HOME]);
  assert.equal(relayConfig.relayUrl, 'wss://space.example/relay/mac');
  assert.equal(relayConfig.relaySecret, secret);
  assert.doesNotMatch(JSON.stringify(result.output), new RegExp(secret));
});

test('runCli setup interactively asks for relay values only when needed', async () => {
  const options = await makeFixture();
  const answers = {
    'Space URL': 'https://interactive.example',
    'Relay secret': 'interactive-secret-0123456789abcdef'
  };
  const questions = [];
  const result = await runCli(['setup', '--json'], {
    ...options,
    prompt: async ({ question }) => {
      questions.push(question);
      return answers[question];
    },
    launchAgent: {
      installMacLaunchAgent: async () => ({ command: 'install', ok: true, installed: true })
    },
    takeOverPort: async () => ({ ok: true, action: 'none' })
  });
  const relayConfig = JSON.parse(await fs.readFile(
    path.join(options.env.CODEXMOBILE_HOME, 'relay.json'),
    'utf8'
  ));

  assert.equal(result.code, 0);
  assert.deepEqual(questions, ['Space URL', 'Relay secret']);
  assert.equal(relayConfig.relayUrl, 'wss://interactive.example/relay/mac');
});

test('runCli setup dry-run does not prompt or install', async () => {
  const options = await makeFixture();
  let installed = false;
  const result = await runCli(['setup', '--dry-run', '--json'], {
    ...options,
    prompt: async () => {
      throw new Error('dry-run should not prompt');
    },
    launchAgent: {
      installMacLaunchAgent: async () => {
        installed = true;
        return { command: 'install', ok: true };
      }
    },
    takeOverPort: async (takeoverOptions) => ({
      ok: true,
      action: takeoverOptions.dryRun ? 'would-stop-unmanaged' : 'stopped-unmanaged'
    })
  });

  assert.equal(result.code, 0);
  assert.equal(result.output.dryRun, true);
  assert.equal(result.output.takeover.action, 'would-stop-unmanaged');
  assert.equal(installed, false);
});

test('runCli setup requires relay secret unless relay is explicitly skipped', async () => {
  const options = await makeFixture();
  const result = await runCli(['setup', '--yes', '--json'], {
    ...options,
    launchAgent: {
      installMacLaunchAgent: async () => {
        throw new Error('setup without relay secret should not install');
      }
    },
    takeOverPort: async () => ({ ok: true, action: 'none' })
  });

  assert.equal(result.code, 1);
  assert.match(result.output.error, /Relay secret is required/);
});

test('runCli setup --no-relay ignores existing relay config for service install', async () => {
  const options = await makeFixture();
  await runCli([
    'relay-config',
    '--url',
    'wss://space.example/relay/mac',
    '--secret',
    '0123456789abcdef0123456789abcdef',
    '--json'
  ], options);
  const calls = [];
  const result = await runCli(['setup', '--no-relay', '--yes', '--json'], {
    ...options,
    launchAgent: {
      installMacLaunchAgent: async (helperOptions) => {
        calls.push(helperOptions.relayConfigured);
        return { command: 'install', ok: true, installed: true };
      }
    },
    takeOverPort: async () => ({ ok: true, action: 'none' })
  });

  assert.equal(result.code, 0);
  assert.equal(result.output.relayConfigured, false);
  assert.equal(result.output.status.relayConfig.configured, false);
  assert.deepEqual(calls, [false]);
  await assert.rejects(
    fs.stat(path.join(options.env.CODEXMOBILE_HOME, 'relay.json')),
    (error) => error.code === 'ENOENT'
  );
});

test('runCli setup validates port owner when LaunchAgent is already loaded', async () => {
  const options = await makeFixture();
  const launchAgentPath = path.join(
    options.homedir,
    'Library',
    'LaunchAgents',
    'com.codexmobile.agent.plist'
  );
  await fs.mkdir(path.dirname(launchAgentPath), { recursive: true });
  await fs.writeFile(launchAgentPath, '<plist/>', 'utf8');
  const calls = [];
  const result = await runCli(['setup', '--secret', '0123456789abcdef0123456789abcdef', '--yes', '--json'], {
    ...options,
    execFile: loadedLaunchAgentExecFile,
    launchAgent: {
      installMacLaunchAgent: async () => ({ command: 'install', ok: true, installed: true })
    },
    takeOverPort: async (takeoverOptions) => {
      calls.push({ validateOnly: takeoverOptions.validateOnly, yes: takeoverOptions.yes });
      return {
        ok: true,
        action: 'verified',
        port: 3321,
        owners: [{ pid: 123, codexMobile: true }]
      };
    }
  });

  assert.equal(result.code, 0);
  assert.equal(result.output.takeover.action, 'launch-agent-verified');
  assert.deepEqual(calls, [{ validateOnly: true, yes: undefined }]);
});

test('runCli setup blocks loaded LaunchAgent install when another process owns the port', async () => {
  const options = await makeFixture();
  const launchAgentPath = path.join(
    options.homedir,
    'Library',
    'LaunchAgents',
    'com.codexmobile.agent.plist'
  );
  await fs.mkdir(path.dirname(launchAgentPath), { recursive: true });
  await fs.writeFile(launchAgentPath, '<plist/>', 'utf8');
  let installed = false;
  const result = await runCli(['setup', '--secret', '0123456789abcdef0123456789abcdef', '--yes', '--json'], {
    ...options,
    execFile: loadedLaunchAgentExecFile,
    launchAgent: {
      installMacLaunchAgent: async () => {
        installed = true;
        return { command: 'install', ok: true, installed: true };
      }
    },
    takeOverPort: async (takeoverOptions) => {
      assert.equal(takeoverOptions.validateOnly, true);
      return {
        ok: false,
        action: 'blocked',
        error: 'Port is occupied by a non-CodexMobile process.'
      };
    }
  });

  assert.equal(result.code, 1);
  assert.equal(result.output.ok, false);
  assert.match(result.output.error, /non-CodexMobile/);
  assert.equal(installed, false);
});

test('runCli setup blocks install when an unknown process owns the port', async () => {
  const options = await makeFixture();
  let installed = false;
  const result = await runCli(['setup', '--secret', '0123456789abcdef0123456789abcdef', '--yes', '--json'], {
    ...options,
    launchAgent: {
      installMacLaunchAgent: async () => {
        installed = true;
        return { command: 'install', ok: true };
      }
    },
    takeOverPort: async () => ({
      ok: false,
      action: 'blocked',
      error: 'Port is occupied by a non-CodexMobile process.'
    })
  });

  assert.equal(result.code, 1);
  assert.equal(result.output.ok, false);
  assert.match(result.output.error, /non-CodexMobile/);
  assert.equal(installed, false);
});
