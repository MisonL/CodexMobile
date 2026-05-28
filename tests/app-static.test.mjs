import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { serveFileFromRoot } from '../server/app-static.js';

function createResponse() {
  return {
    status: 0,
    headers: {},
    body: '',
    writeHead(status, headers = {}) {
      this.status = status;
      this.headers = headers;
    },
    end(body = '') {
      this.body = Buffer.isBuffer(body) ? body.toString('utf8') : String(body);
    }
  };
}

test('serveFileFromRoot rejects symlinks that resolve outside root', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'codexmobile-static-test-'));
  const root = path.join(tmp, 'root');
  const outside = path.join(tmp, 'outside.txt');
  const link = path.join(root, 'linked.txt');
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(outside, 'secret', 'utf8');
  await fs.symlink(outside, link);

  try {
    const res = createResponse();
    const handled = await serveFileFromRoot({ headers: {} }, res, root, '/linked.txt', 'no-store');

    assert.equal(handled, true);
    assert.equal(res.status, 403);
    assert.equal(res.body, 'Forbidden');
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('serveFileFromRoot still serves real files inside root', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'codexmobile-static-test-'));
  const root = path.join(tmp, 'root');
  const file = path.join(root, 'ok.txt');
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(file, 'ok', 'utf8');

  try {
    const res = createResponse();
    const handled = await serveFileFromRoot({ headers: {} }, res, root, '/ok.txt', 'no-store');

    assert.equal(handled, true);
    assert.equal(res.status, 200);
    assert.equal(res.body, 'ok');
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
