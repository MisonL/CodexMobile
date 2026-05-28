import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { parseFilteredSessionMetadata, parseSessionIdentity, projectIdFor } from '../server/codex-data-parser.js';
import { displayNameFor } from '../server/codex-data-projects.js';

test('parseSessionIdentity reads session metadata without requiring later rows', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codexmobile-parser-'));
  const filePath = path.join(dir, 'session.jsonl');
  const cwd = path.join(dir, 'project');
  const id = 'session-1';

  await fs.writeFile(
    filePath,
    [
      JSON.stringify({ type: 'session_meta', payload: { id, cwd } }),
      '{malformed',
      JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'hello' } })
    ].join('\n'),
    'utf8'
  );

  assert.deepEqual(await parseSessionIdentity(filePath), {
    id,
    cwd,
    projectId: projectIdFor(cwd)
  });
});

test('parseSessionIdentity returns null when session metadata is absent', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codexmobile-parser-'));
  const filePath = path.join(dir, 'session.jsonl');

  await fs.writeFile(filePath, `${JSON.stringify({ type: 'event_msg', payload: {} })}\n`, 'utf8');

  assert.equal(await parseSessionIdentity(filePath), null);
});

test('parseFilteredSessionMetadata filters by identity during metadata scan', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codexmobile-parser-'));
  const filePath = path.join(dir, 'session.jsonl');
  const cwd = path.join(dir, 'project');
  const id = 'session-1';

  await fs.writeFile(
    filePath,
    [
      JSON.stringify({ type: 'session_meta', payload: { id, cwd, model: 'gpt-test' } }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'hello' } })
    ].join('\n'),
    'utf8'
  );

  const skipped = await parseFilteredSessionMetadata({
    filePath,
    sessionIndex: new Map(),
    mobileSessionIndex: new Map(),
    includeIdentity: () => false
  });
  const included = await parseFilteredSessionMetadata({
    filePath,
    sessionIndex: new Map(),
    mobileSessionIndex: new Map(),
    includeIdentity: (identity) => identity.projectId === projectIdFor(cwd)
  });

  assert.equal(skipped, null);
  assert.equal(included.id, id);
  assert.equal(included.messageCount, 1);
});

test('displayNameFor handles missing project paths', () => {
  assert.equal(displayNameFor(null), '');
  assert.equal(displayNameFor(undefined), '');
  assert.equal(displayNameFor(''), '');
});
