import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  buildLaunchAgentPlist,
  buildMacInstallPlan,
  disableMacLaunchAgent,
  enableMacLaunchAgent,
  getMacLaunchAgentStatus,
  installMacLaunchAgent,
  uninstallMacLaunchAgent
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

test('buildLaunchAgentPlist emits a macOS user agent for the CLI serve command', () => {
  const plist = buildLaunchAgentPlist({
    label: 'com.codexmobile.agent',
    nodePath: '/usr/local/bin/node',
    cliPath: '/repo/bin/codexmobile.mjs',
    workingDirectory: '/repo',
    logDir: '/Users/alice/Library/Logs/CodexMobile',
    env: {
      CODEXMOBILE_HOME: '/Users/alice/Library/Application Support/CodexMobile',
      CODEX_HOME: '/Users/alice/.codex'
    }
  });

  assert.match(plist, /<string>com\.codexmobile\.agent<\/string>/);
  assert.match(plist, /<string>\/usr\/local\/bin\/node<\/string>/);
  assert.match(plist, /<string>serve<\/string>/);
  assert.match(plist, /<key>CODEXMOBILE_HOME<\/key>/);
  assert.match(plist, /<key>CODEX_HOME<\/key>/);
});

test('buildMacInstallPlan returns dry-run write actions without creating LaunchAgent file', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'codexmobile-cli-test-'));
  const paths = resolveRuntimePaths({
    platform: 'darwin',
    env: { CODEXMOBILE_HOME: path.join(tmp, 'data') },
    homedir: tmp,
    cwd: '/repo'
  });
  const launchAgentPath = path.join(tmp, 'Library', 'LaunchAgents', 'com.codexmobile.agent.plist');
  const plan = buildMacInstallPlan({
    paths: { ...paths, launchAgentPath },
    nodePath: '/usr/local/bin/node',
    cliPath: '/repo/bin/codexmobile.mjs',
    dryRun: true
  });

  assert.equal(plan.platform, 'darwin');
  assert.equal(plan.dryRun, true);
  assert.equal(plan.label, 'com.codexmobile.agent');
  assert.equal(plan.wouldWrite.length, 1);
  assert.equal(plan.wouldWrite[0].path, launchAgentPath);
  assert.match(plan.wouldWrite[0].content, /<string>serve<\/string>/);

  await assert.rejects(
    fs.stat(launchAgentPath),
    (error) => error.code === 'ENOENT'
  );
});

test('installMacLaunchAgent writes plist, lints it, and bootstraps user agent', async () => {
  const { paths } = await makeTempPaths();
  const calls = [];
  const result = await installMacLaunchAgent({
    paths,
    nodePath: '/usr/local/bin/node',
    cliPath: '/repo/bin/codexmobile.mjs',
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
      ['launchctl', 'bootstrap', `gui/${process.getuid()}`, paths.launchAgentPath],
      ['launchctl', 'kickstart', '-k', `gui/${process.getuid()}/com.codexmobile.agent`]
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

  await enableMacLaunchAgent({ paths, execFile });
  await disableMacLaunchAgent({ paths, execFile });
  const status = await getMacLaunchAgentStatus({ paths, execFile });

  assert.equal(status.label, 'com.codexmobile.agent');
  assert.deepEqual(
    calls.map((call) => [call.command, ...call.args]),
    [
      ['launchctl', 'bootstrap', `gui/${process.getuid()}`, paths.launchAgentPath],
      ['launchctl', 'kickstart', '-k', `gui/${process.getuid()}/com.codexmobile.agent`],
      ['launchctl', 'bootout', `gui/${process.getuid()}/com.codexmobile.agent`],
      ['launchctl', 'print', `gui/${process.getuid()}/com.codexmobile.agent`]
    ]
  );
});
