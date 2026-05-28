import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  buildLaunchAgentPlist,
  buildMacInstallPlan
} from '../cli/launch-agent.mjs';
import { resolveRuntimePaths } from '../cli/paths.mjs';

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
  assert.match(plist, /<key>KeepAlive<\/key>\n  <true\/>/);
  assert.match(plist, /<key>ThrottleInterval<\/key>\n  <integer>10<\/integer>/);
  assert.match(plist, /<key>CODEXMOBILE_HOME<\/key>/);
  assert.match(plist, /<key>CODEX_HOME<\/key>/);
});

test('buildLaunchAgentPlist can emit a relay connector user agent', () => {
  const plist = buildLaunchAgentPlist({
    label: 'com.codexmobile.relay-connector',
    nodePath: '/usr/local/bin/node',
    cliPath: '/repo/scripts/relay-mac-client.mjs',
    workingDirectory: '/repo',
    logDir: '/Users/alice/Library/Logs/CodexMobile',
    logName: 'relay',
    programArguments: ['/usr/local/bin/node', '/repo/scripts/relay-mac-client.mjs'],
    env: {
      CODEXMOBILE_HOME: '/Users/alice/Library/Application Support/CodexMobile'
    }
  });

  assert.match(plist, /<string>com\.codexmobile\.relay-connector<\/string>/);
  assert.match(plist, /<string>\/repo\/scripts\/relay-mac-client\.mjs<\/string>/);
  assert.doesNotMatch(plist, /<string>serve<\/string>/);
  assert.match(plist, /relay\.out\.log/);
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
  assert.equal(plan.relayConfigured, false);
  assert.equal(plan.relaySkipped, 'relay-config-missing');
  assert.equal(plan.wouldWrite.length, 1);
  assert.equal(plan.wouldWrite[0].path, launchAgentPath);
  assert.match(plan.wouldWrite[0].content, /<string>serve<\/string>/);
  assert.deepEqual(plan.wouldRun, [
    'launchctl bootout gui/$(id -u)/com.codexmobile.agent',
    `launchctl bootstrap gui/$(id -u) ${launchAgentPath}`,
    'launchctl kickstart -k gui/$(id -u)/com.codexmobile.agent'
  ]);
  assert.match(plan.notes[0], /ignores only not-loaded or not-found/);
  assert.match(plan.notes.at(-1), /relay-config/);

  await assert.rejects(
    fs.stat(launchAgentPath),
    (error) => error.code === 'ENOENT'
  );
});

test('buildMacInstallPlan includes relay connector after relay config is saved', async () => {
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
    relayConfigured: true,
    dryRun: true
  });

  assert.equal(plan.relayConfigured, true);
  assert.equal(plan.relaySkipped, '');
  assert.equal(plan.wouldWrite.length, 2);
  assert.equal(plan.wouldWrite[0].path, launchAgentPath);
  assert.match(plan.wouldWrite[1].path, /com\.codexmobile\.relay-connector\.plist$/);
  assert.match(plan.wouldWrite[1].content, /relay-mac-client\.mjs/);
  assert.deepEqual(plan.wouldRun, [
    'launchctl bootout gui/$(id -u)/com.codexmobile.agent',
    `launchctl bootstrap gui/$(id -u) ${launchAgentPath}`,
    'launchctl kickstart -k gui/$(id -u)/com.codexmobile.agent',
    'launchctl bootout gui/$(id -u)/com.codexmobile.relay-connector',
    `launchctl bootstrap gui/$(id -u) ${plan.wouldWrite[1].path}`,
    'launchctl kickstart -k gui/$(id -u)/com.codexmobile.relay-connector'
  ]);
});
