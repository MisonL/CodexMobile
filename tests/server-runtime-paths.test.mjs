import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import {
  CODEXMOBILE_DATA_ROOT,
  CODEXMOBILE_GENERATED_ROOT,
  CODEXMOBILE_STATE_DIR,
  CODEXMOBILE_UPLOAD_ROOT,
  resolveCodexMobileDataRoot,
  resolveCodexMobileRuntimePaths
} from '../server/runtime-paths.js';
import {
  FEISHU_AUTH_STATE,
  IMAGE_PROMPT_STATE,
  UPLOAD_ROOT
} from '../server/app-config.js';
import { DATA_DIR } from '../server/auth.js';
import { DELETED_MESSAGES_PATH, HIDDEN_SESSIONS_PATH } from '../server/codex-data-hidden-state.js';
import { GENERATED_ROOT } from '../server/image-generator-api.js';

test('server runtime paths default to repository .codexmobile root', () => {
  const rootDir = path.resolve('/repo/codexmobile');
  const paths = resolveCodexMobileRuntimePaths({
    env: {},
    rootDir
  });

  assert.equal(paths.dataRoot, path.join(rootDir, '.codexmobile'));
  assert.equal(paths.stateDir, path.join(rootDir, '.codexmobile', 'state'));
  assert.equal(paths.uploadRoot, path.join(rootDir, '.codexmobile', 'uploads'));
  assert.equal(paths.generatedRoot, path.join(rootDir, '.codexmobile', 'generated'));
});

test('server runtime paths derive all writable state from CODEXMOBILE_HOME', () => {
  const cwd = path.resolve('/repo/codexmobile');
  const paths = resolveCodexMobileRuntimePaths({
    env: { CODEXMOBILE_HOME: '/tmp/codexmobile-home' },
    cwd,
    rootDir: cwd
  });

  assert.equal(paths.dataRoot, '/tmp/codexmobile-home');
  assert.equal(paths.stateDir, '/tmp/codexmobile-home/state');
  assert.equal(paths.uploadRoot, '/tmp/codexmobile-home/uploads');
  assert.equal(paths.generatedRoot, '/tmp/codexmobile-home/generated');
  assert.equal(paths.larkAgentDir, '/tmp/codexmobile-home/lark-cli-agent');
  assert.equal(paths.larkGuardDir, '/tmp/codexmobile-home/lark-cli-guard');
});

test('relative CODEXMOBILE_HOME is resolved from the server process cwd', () => {
  assert.equal(
    resolveCodexMobileDataRoot({
      env: { CODEXMOBILE_HOME: 'runtime' },
      cwd: '/repo/codexmobile',
      rootDir: '/repo/codexmobile'
    }),
    path.join('/repo/codexmobile', 'runtime')
  );
});

test('runtime paths resolve relative CODEXMOBILE_HOME from explicit cwd instead of rootDir', () => {
  const paths = resolveCodexMobileRuntimePaths({
    env: { CODEXMOBILE_HOME: 'runtime' },
    cwd: '/Users/alice',
    rootDir: '/repo/codexmobile'
  });

  assert.equal(paths.dataRoot, '/Users/alice/runtime');
  assert.equal(paths.modelCacheDir, '/Users/alice/runtime/model-cache');
});

test('server modules derive writable paths from runtime path constants', () => {
  assert.equal(DATA_DIR, CODEXMOBILE_STATE_DIR);
  assert.equal(UPLOAD_ROOT, CODEXMOBILE_UPLOAD_ROOT);
  assert.equal(GENERATED_ROOT, CODEXMOBILE_GENERATED_ROOT);
  assert.equal(IMAGE_PROMPT_STATE, path.join(CODEXMOBILE_STATE_DIR, 'image-prompts.json'));
  assert.equal(FEISHU_AUTH_STATE, path.join(CODEXMOBILE_STATE_DIR, 'feishu-auth.json'));
  assert.equal(DELETED_MESSAGES_PATH, path.join(CODEXMOBILE_STATE_DIR, 'deleted-messages.json'));
  assert.equal(HIDDEN_SESSIONS_PATH, path.join(CODEXMOBILE_STATE_DIR, 'hidden-sessions.json'));
  assert.ok(CODEXMOBILE_DATA_ROOT);
});
