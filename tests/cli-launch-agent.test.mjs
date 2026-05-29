import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { disableMacLaunchAgent, enableMacLaunchAgent, getMacLaunchAgentStatus, installMacLaunchAgent, uninstallMacLaunchAgent } from '../cli/launch-agent.mjs';
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
    tmp,
    paths: {
      ...paths,
      launchAgentPath: path.join(tmp, 'Library', 'LaunchAgents', 'com.codexmobile.agent.plist')
    }
  };
}

function fakeExecFile(calls) {
  return (command, args, options, callback) => {
    calls.push({ command, args, options });
    callback(null, 'ok\n', '');
  };
}

function fakeExecFileWithLoadedService(calls) {
  return (command, args, options, callback) => {
    calls.push({ command, args, options });
    if (command === 'launchctl' && args[0] === 'bootstrap') {
      callback(Object.assign(new Error('Bootstrap failed: 5: Input/output error'), { code: 5 }), '', 'service already loaded');
      return;
    }
    callback(null, 'ok\n', '');
  };
}

function fakeExecFileWithMissingService(calls) {
  return (command, args, options, callback) => {
    calls.push({ command, args, options });
    if (command === 'launchctl' && args[0] === 'bootout') {
      callback(Object.assign(new Error('Boot-out failed: 3: No such process'), { code: 3 }), '', 'No such process');
      return;
    }
    callback(null, 'ok\n', '');
  };
}

function fakeExecFileWithBootoutFailure(calls) {
  return (command, args, options, callback) => {
    calls.push({ command, args, options });
    if (command === 'launchctl' && args[0] === 'bootout') {
      callback(Object.assign(new Error('Boot-out failed: 5: Input/output error'), { code: 5 }), '', 'Input/output error');
      return;
    }
    callback(null, 'ok\n', '');
  };
}

function pathsWithoutRelayLaunchAgentPath(paths) {
  const { relayLaunchAgentPath, ...rest } = paths;
  return rest;
}

function fallbackRelayLaunchAgentPath(paths) {
  return path.join(path.dirname(paths.launchAgentPath), 'com.codexmobile.relay-connector.plist');
}

test('installMacLaunchAgent writes plist, lints it, and bootstraps user agent', async () => {
  const { paths } = await makeTempPaths();
  const calls = [];
  const result = await installMacLaunchAgent({
    paths,
    nodePath: '/usr/local/bin/node',
    cliPath: '/repo/bin/codexmobile.mjs',
    relayConfigured: true,
    execFile: fakeExecFile(calls)
  });
  const plist = await fs.readFile(paths.launchAgentPath, 'utf8');

  assert.equal(result.command, 'install');
  assert.equal(result.installed, true);
  assert.equal(result.label, 'com.codexmobile.agent');
  assert.match(plist, /<string>com\.codexmobile\.agent<\/string>/);
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
      ['launchctl', 'kickstart', '-k', `gui/${process.getuid()}/com.codexmobile.relay-connector`]
    ]
  );
});

test('installMacLaunchAgent skips relay connector until relay config is saved', async () => {
  const { paths } = await makeTempPaths();
  const calls = [];
  const result = await installMacLaunchAgent({
    paths,
    nodePath: '/usr/local/bin/node',
    cliPath: '/repo/bin/codexmobile.mjs',
    execFile: fakeExecFile(calls)
  });

  assert.equal(result.installed, true);
  assert.equal(result.relayInstalled, false);
  assert.equal(result.relaySkipped, 'relay-config-missing');
  await assert.rejects(
    fs.stat(paths.relayLaunchAgentPath),
    (error) => error.code === 'ENOENT'
  );
  assert.deepEqual(
    calls.map((call) => [call.command, ...call.args]),
    [
      ['plutil', '-lint', paths.launchAgentPath],
      ['launchctl', 'bootout', `gui/${process.getuid()}/com.codexmobile.relay-connector`],
      ['launchctl', 'bootout', `gui/${process.getuid()}/com.codexmobile.agent`],
      ['launchctl', 'bootstrap', `gui/${process.getuid()}`, paths.launchAgentPath],
      ['launchctl', 'kickstart', '-k', `gui/${process.getuid()}/com.codexmobile.agent`]
    ]
  );
});

test('installMacLaunchAgent removes stale relay plist when relay is skipped', async () => {
  const { paths } = await makeTempPaths();
  const calls = [];
  await fs.mkdir(path.dirname(paths.relayLaunchAgentPath), { recursive: true });
  await fs.writeFile(paths.relayLaunchAgentPath, '<plist/>', 'utf8');

  const result = await installMacLaunchAgent({
    paths,
    nodePath: '/usr/local/bin/node',
    cliPath: '/repo/bin/codexmobile.mjs',
    execFile: fakeExecFile(calls)
  });

  assert.equal(result.relayInstalled, false);
  await assert.rejects(
    fs.stat(paths.relayLaunchAgentPath),
    (error) => error.code === 'ENOENT'
  );
});

test('installMacLaunchAgent is idempotent when the user agent is already loaded', async () => {
  const { paths } = await makeTempPaths();
  const calls = [];
  const result = await installMacLaunchAgent({
    paths,
    nodePath: '/usr/local/bin/node',
    cliPath: '/repo/bin/codexmobile.mjs',
    relayConfigured: true,
    execFile: fakeExecFileWithLoadedService(calls)
  });

  assert.equal(result.ok, true);
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
      ['launchctl', 'kickstart', '-k', `gui/${process.getuid()}/com.codexmobile.relay-connector`]
    ]
  );
});

test('installMacLaunchAgent ignores missing bootout target and continues bootstrap', async () => {
  const { paths } = await makeTempPaths();
  const calls = [];
  const result = await installMacLaunchAgent({
    paths,
    nodePath: '/usr/local/bin/node',
    cliPath: '/repo/bin/codexmobile.mjs',
    relayConfigured: true,
    execFile: fakeExecFileWithMissingService(calls)
  });

  assert.equal(result.ok, true);
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
      ['launchctl', 'kickstart', '-k', `gui/${process.getuid()}/com.codexmobile.relay-connector`]
    ]
  );
});

test('installMacLaunchAgent surfaces unexpected bootout failures', async () => {
  const { paths } = await makeTempPaths();
  const calls = [];

  await assert.rejects(
    installMacLaunchAgent({
      paths,
      nodePath: '/usr/local/bin/node',
      cliPath: '/repo/bin/codexmobile.mjs',
      relayConfigured: true,
      execFile: fakeExecFileWithBootoutFailure(calls)
    }),
    /Input\/output error/
  );
  assert.deepEqual(
    calls.map((call) => [call.command, ...call.args]),
    [
      ['plutil', '-lint', paths.launchAgentPath],
      ['plutil', '-lint', paths.relayLaunchAgentPath],
      ['launchctl', 'bootout', `gui/${process.getuid()}/com.codexmobile.agent`]
    ]
  );
});

test('uninstallMacLaunchAgent removes plist and preserves user data by default', async () => {
  const { paths } = await makeTempPaths();
  const calls = [];
  await fs.mkdir(path.dirname(paths.launchAgentPath), { recursive: true });
  await fs.mkdir(paths.dataDir, { recursive: true });
  await fs.writeFile(paths.launchAgentPath, '<plist version="1.0"></plist>\n', 'utf8');
  await fs.writeFile(path.join(paths.dataDir, 'keep.txt'), 'keep', 'utf8');
  const result = await uninstallMacLaunchAgent({
    paths,
    execFile: fakeExecFile(calls)
  });

  assert.equal(result.command, 'uninstall');
  assert.equal(result.uninstalled, true);
  await assert.rejects(
    fs.stat(paths.launchAgentPath),
    (error) => error.code === 'ENOENT'
  );
  assert.equal(await fs.readFile(path.join(paths.dataDir, 'keep.txt'), 'utf8'), 'keep');
  assert.equal(result.dataRemoved, false);
});

test('uninstallMacLaunchAgent removes derived relay plist when path is omitted', async () => {
  const { paths } = await makeTempPaths();
  const calls = [];
  const relayPath = fallbackRelayLaunchAgentPath(paths);
  await fs.mkdir(path.dirname(paths.launchAgentPath), { recursive: true });
  await fs.writeFile(paths.launchAgentPath, '<plist version="1.0"></plist>\n', 'utf8');
  await fs.writeFile(relayPath, '<plist version="1.0"></plist>\n', 'utf8');

  await uninstallMacLaunchAgent({
    paths: pathsWithoutRelayLaunchAgentPath(paths),
    execFile: fakeExecFile(calls)
  });

  await assert.rejects(
    fs.stat(paths.launchAgentPath),
    (error) => error.code === 'ENOENT'
  );
  await assert.rejects(
    fs.stat(relayPath),
    (error) => error.code === 'ENOENT'
  );
});

test('uninstallMacLaunchAgent requires confirmation before removing user data', async () => {
  const { paths } = await makeTempPaths();
  await fs.mkdir(paths.dataDir, { recursive: true });
  await fs.writeFile(path.join(paths.dataDir, 'keep.txt'), 'keep', 'utf8');
  const result = await uninstallMacLaunchAgent({
    paths,
    removeData: true,
    confirmRemoveData: false,
    execFile: fakeExecFile([])
  });

  assert.equal(result.ok, false);
  assert.match(result.error, /confirm-remove-data/);
  assert.equal(await fs.readFile(path.join(paths.dataDir, 'keep.txt'), 'utf8'), 'keep');
});

test('enable, disable, and status call launchctl with stable label', async () => {
  const { paths } = await makeTempPaths();
  const calls = [];
  const execFile = fakeExecFile(calls);

  const enabled = await enableMacLaunchAgent({ paths, execFile, relayConfigured: true });
  await disableMacLaunchAgent({ paths, execFile });
  const status = await getMacLaunchAgentStatus({ paths, execFile });

  assert.equal(enabled.relayEnabled, true);
  assert.equal(enabled.plistWritten, true);
  assert.equal(enabled.relayPlistWritten, true);
  assert.equal(status.label, 'com.codexmobile.agent');
  assert.equal(status.relayConnector.label, 'com.codexmobile.relay-connector');
  assert.equal(status.relayConnector.loaded, true);
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
      ['launchctl', 'bootout', `gui/${process.getuid()}/com.codexmobile.agent`],
      ['launchctl', 'bootout', `gui/${process.getuid()}/com.codexmobile.relay-connector`],
      ['launchctl', 'print', `gui/${process.getuid()}/com.codexmobile.agent`],
      ['launchctl', 'print', `gui/${process.getuid()}/com.codexmobile.relay-connector`]
    ]
  );
});

test('getMacLaunchAgentStatus derives relay plist path when path is omitted', async () => {
  const { paths } = await makeTempPaths();
  const calls = [];
  const relayPath = fallbackRelayLaunchAgentPath(paths);
  const status = await getMacLaunchAgentStatus({
    paths: pathsWithoutRelayLaunchAgentPath(paths),
    execFile: fakeExecFile(calls)
  });

  assert.equal(status.relayConnector.path, relayPath);
  assert.deepEqual(
    calls.map((call) => [call.command, ...call.args]),
    [
      ['launchctl', 'print', `gui/${process.getuid()}/com.codexmobile.agent`],
      ['launchctl', 'print', `gui/${process.getuid()}/com.codexmobile.relay-connector`]
    ]
  );
});

test('enableMacLaunchAgent is idempotent when the user agent is already loaded', async () => {
  const { paths } = await makeTempPaths();
  const calls = [];
  const result = await enableMacLaunchAgent({
    paths,
    relayConfigured: true,
    execFile: fakeExecFileWithLoadedService(calls)
  });

  assert.equal(result.ok, true);
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
      ['launchctl', 'kickstart', '-k', `gui/${process.getuid()}/com.codexmobile.relay-connector`]
    ]
  );
});
