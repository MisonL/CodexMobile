import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const ROOT_DIR = path.join(import.meta.dirname, '..');

test('deploy revalidates source containment after prepare step', () => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'codexmobile-deploy-race-outside-'));
  const fakeBin = fs.mkdtempSync(path.join(os.tmpdir(), 'codexmobile-deploy-fake-bin-'));
  const link = path.join(ROOT_DIR, '.codexmobile-deploy-race-link');
  try {
    fs.writeFileSync(path.join(outside, 'README.md'), 'outside\n');
    fs.writeFileSync(path.join(fakeBin, 'npm'), [
      '#!/usr/bin/env node',
      "const fs = require('node:fs');",
      "fs.rmSync(process.env.TEST_DEPLOY_SOURCE_LINK, { recursive: true, force: true });",
      "fs.symlinkSync(process.env.TEST_DEPLOY_OUTSIDE, process.env.TEST_DEPLOY_SOURCE_LINK, 'dir');",
      ''
    ].join('\n'));
    fs.writeFileSync(path.join(fakeBin, 'git'), [
      '#!/usr/bin/env node',
      'process.exit(0);',
      ''
    ].join('\n'));
    fs.chmodSync(path.join(fakeBin, 'npm'), 0o755);
    fs.chmodSync(path.join(fakeBin, 'git'), 0o755);

    const result = spawnSync(process.execPath, [
      path.join(ROOT_DIR, 'scripts', 'deploy-hf-space.mjs'),
      '--remote',
      'https://huggingface.co/spaces/example/codexmobile-relay',
      '--source',
      path.relative(ROOT_DIR, link),
      '--force'
    ], {
      cwd: ROOT_DIR,
      env: {
        ...process.env,
        PATH: `${fakeBin}${path.delimiter}${process.env.PATH || ''}`,
        TEST_DEPLOY_OUTSIDE: outside,
        TEST_DEPLOY_SOURCE_LINK: link
      },
      encoding: 'utf8'
    });

    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}${result.stderr}`, /source must stay inside the repository/);
  } finally {
    fs.rmSync(link, { force: true });
    fs.rmSync(outside, { recursive: true, force: true });
    fs.rmSync(fakeBin, { recursive: true, force: true });
  }
});
