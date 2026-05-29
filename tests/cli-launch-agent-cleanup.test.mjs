import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  enableMacLaunchAgent,
  installMacLaunchAgent
} from '../cli/launch-agent.mjs';
import { resolveRuntimePaths } from '../cli/paths.mjs';

async function makeTempPaths() {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'codexmobile-launch-agent-'));
  const paths = resolveRuntimePaths({
    platform: 'darwin',
    env: { CODEXMOBILE_HOME: path.join(tmp, 'data') },
    homedir: tmp,
    cwd: '/repo'
  });
  return {
    paths: {
      ...paths,
      launchAgentPath: path.join(tmp, 'Library', 'LaunchAgents', 'com.codexmobile.agent.plist')
    }
  };
}

function fakeExecFileWithRelayBootstrapFailure(calls) {
  let bootstrapCount = 0;
  return (command, args, options, callback) => {
    calls.push({ command, args, options });
    if (command === 'launchctl' && args[0] === 'bootstrap') {
      bootstrapCount += 1;
    }
    if (command === 'launchctl' && args[0] === 'bootstrap' && bootstrapCount === 2) {
      callback(Object.assign(new Error('Relay bootstrap failed'), { code: 7 }), '', 'relay failed');
      return;
    }
    callback(null, 'ok\n', '');
  };
}

function fakeExecFileWithKickstartFailure(calls, failedLabel) {
  return (command, args, options, callback) => {
    calls.push({ command, args, options });
    if (
      command === 'launchctl' &&
      args[0] === 'kickstart' &&
      args[2] === `gui/${process.getuid()}/${failedLabel}`
    ) {
      callback(Object.assign(new Error('Kickstart failed'), { code: 8 }), '', 'kickstart failed');
      return;
    }
    callback(null, 'ok\n', '');
  };
}

test('installMacLaunchAgent cleans up started services when relay bootstrap fails', async () => {
  const { paths } = await makeTempPaths();
  const calls = [];

  await assert.rejects(
    installMacLaunchAgent({
      paths,
      nodePath: '/usr/local/bin/node',
      cliPath: '/repo/bin/codexmobile.mjs',
      relayConfigured: true,
      execFile: fakeExecFileWithRelayBootstrapFailure(calls)
    }),
    (error) => {
      assert.match(error.message, /relay/i);
      assert.deepEqual(error.cleanup, [
        { label: 'com.codexmobile.agent', ok: true }
      ]);
      return true;
    }
  );
  assert.deepEqual(
    calls.map((call) => [call.command, ...call.args]),
    [
      ['plutil', '-lint', paths.launchAgentPath],
      ['plutil', '-lint', paths.relayLaunchAgentPath],
      ['launchctl', 'bootout', `gui/${process.getuid()}/com.codexmobile.agent`],
      ['launchctl', 'bootstrap', `gui/${process.getuid()}`, paths.launchAgentPath],
      ['launchctl', 'kickstart', '-k', `gui/${process.getuid()}/com.codexmobile.agent`],
      ['launchctl', 'bootout', `gui/${process.getuid()}/com.codexmobile.relay-connector`],
      ['launchctl', 'bootstrap', `gui/${process.getuid()}`, paths.relayLaunchAgentPath],
      ['launchctl', 'bootout', `gui/${process.getuid()}/com.codexmobile.agent`]
    ]
  );
});

test('installMacLaunchAgent cleans up bootstrapped service when kickstart fails', async () => {
  const { paths } = await makeTempPaths();
  const calls = [];

  await assert.rejects(
    installMacLaunchAgent({
      paths,
      nodePath: '/usr/local/bin/node',
      cliPath: '/repo/bin/codexmobile.mjs',
      relayConfigured: true,
      execFile: fakeExecFileWithKickstartFailure(calls, 'com.codexmobile.relay-connector')
    }),
    (error) => {
      assert.match(error.message, /Kickstart failed/);
      assert.deepEqual(error.cleanup, [
        { label: 'com.codexmobile.relay-connector', ok: true },
        { label: 'com.codexmobile.agent', ok: true }
      ]);
      return true;
    }
  );
  assert.deepEqual(
    calls.map((call) => [call.command, ...call.args]),
    [
      ['plutil', '-lint', paths.launchAgentPath],
      ['plutil', '-lint', paths.relayLaunchAgentPath],
      ['launchctl', 'bootout', `gui/${process.getuid()}/com.codexmobile.agent`],
      ['launchctl', 'bootstrap', `gui/${process.getuid()}`, paths.launchAgentPath],
      ['launchctl', 'kickstart', '-k', `gui/${process.getuid()}/com.codexmobile.agent`],
      ['launchctl', 'bootout', `gui/${process.getuid()}/com.codexmobile.relay-connector`],
      ['launchctl', 'bootstrap', `gui/${process.getuid()}`, paths.relayLaunchAgentPath],
      ['launchctl', 'kickstart', '-k', `gui/${process.getuid()}/com.codexmobile.relay-connector`],
      ['launchctl', 'bootout', `gui/${process.getuid()}/com.codexmobile.relay-connector`],
      ['launchctl', 'bootout', `gui/${process.getuid()}/com.codexmobile.agent`]
    ]
  );
});

test('enableMacLaunchAgent cleans up started services when relay bootstrap fails', async () => {
  const { paths } = await makeTempPaths();
  const calls = [];

  await assert.rejects(
    enableMacLaunchAgent({
      paths,
      relayConfigured: true,
      execFile: fakeExecFileWithRelayBootstrapFailure(calls)
    }),
    (error) => {
      assert.match(error.message, /relay/i);
      assert.deepEqual(error.cleanup, [
        { label: 'com.codexmobile.agent', ok: true }
      ]);
      return true;
    }
  );
  assert.deepEqual(
    calls.map((call) => [call.command, ...call.args]),
    [
      ['plutil', '-lint', paths.launchAgentPath],
      ['plutil', '-lint', paths.relayLaunchAgentPath],
      ['launchctl', 'bootout', `gui/${process.getuid()}/com.codexmobile.agent`],
      ['launchctl', 'bootstrap', `gui/${process.getuid()}`, paths.launchAgentPath],
      ['launchctl', 'kickstart', '-k', `gui/${process.getuid()}/com.codexmobile.agent`],
      ['launchctl', 'bootout', `gui/${process.getuid()}/com.codexmobile.relay-connector`],
      ['launchctl', 'bootstrap', `gui/${process.getuid()}`, paths.relayLaunchAgentPath],
      ['launchctl', 'bootout', `gui/${process.getuid()}/com.codexmobile.agent`]
    ]
  );
});

test('enableMacLaunchAgent cleans up bootstrapped service when first kickstart fails', async () => {
  const { paths } = await makeTempPaths();
  const calls = [];

  await assert.rejects(
    enableMacLaunchAgent({
      paths,
      execFile: fakeExecFileWithKickstartFailure(calls, 'com.codexmobile.agent')
    }),
    (error) => {
      assert.match(error.message, /Kickstart failed/);
      assert.deepEqual(error.cleanup, [
        { label: 'com.codexmobile.agent', ok: true }
      ]);
      return true;
    }
  );
  assert.deepEqual(
    calls.map((call) => [call.command, ...call.args]),
    [
      ['plutil', '-lint', paths.launchAgentPath],
      ['launchctl', 'bootout', `gui/${process.getuid()}/com.codexmobile.relay-connector`],
      ['launchctl', 'bootout', `gui/${process.getuid()}/com.codexmobile.agent`],
      ['launchctl', 'bootstrap', `gui/${process.getuid()}`, paths.launchAgentPath],
      ['launchctl', 'kickstart', '-k', `gui/${process.getuid()}/com.codexmobile.agent`],
      ['launchctl', 'bootout', `gui/${process.getuid()}/com.codexmobile.agent`]
    ]
  );
});
