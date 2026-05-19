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
