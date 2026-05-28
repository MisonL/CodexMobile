import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { UPLOAD_ROOT } from '../server/app-config.js';
import { normalizeAttachments } from '../server/app-attachments.js';

test('normalizeAttachments rejects client supplied paths outside upload root', () => {
  assert.throws(
    () => normalizeAttachments([
      {
        id: 'image-1',
        kind: 'image',
        name: 'secret.png',
        mimeType: 'image/png',
        path: '/Users/alice/secret.png'
      }
    ]),
    /invalid_attachment_path/
  );
});

test('normalizeAttachments rejects null byte paths', () => {
  assert.throws(
    () => normalizeAttachments([
      {
        id: 'image-1',
        path: path.join(UPLOAD_ROOT, `image\u0000secret.png`)
      }
    ]),
    /invalid_attachment_path/
  );
});

test('normalizeAttachments rejects the upload root directory itself', () => {
  assert.throws(
    () => normalizeAttachments([
      {
        id: 'root',
        path: UPLOAD_ROOT
      }
    ]),
    /invalid_attachment_path/
  );
});

test('normalizeAttachments keeps uploaded files under upload root', async () => {
  const filePath = path.join(UPLOAD_ROOT, '2026-05-22', 'image-1-upload.png');
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, 'image', 'utf8');

  try {
    const attachments = normalizeAttachments([
      {
        id: 'image-1',
        kind: 'image',
        mimeType: 'image/png',
        path: filePath
      }
    ]);

    assert.deepEqual(attachments, [
      {
        id: 'image-1',
        name: 'image-1-upload.png',
        size: 0,
        mimeType: 'image/png',
        path: filePath,
        kind: 'image'
      }
    ]);
  } finally {
    await fs.rm(filePath, { force: true });
  }
});

test('normalizeAttachments rejects symlinks that resolve outside upload root', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'codexmobile-attachments-test-'));
  const uploadFolder = path.join(UPLOAD_ROOT, 'symlink-test');
  const externalFile = path.join(tmp, 'secret.txt');
  const symlinkPath = path.join(uploadFolder, 'linked-secret.txt');

  await fs.mkdir(uploadFolder, { recursive: true });
  await fs.writeFile(externalFile, 'secret', 'utf8');
  await fs.rm(symlinkPath, { force: true });
  await fs.symlink(externalFile, symlinkPath);

  try {
    assert.throws(
      () => normalizeAttachments([
        {
          id: 'link',
          path: symlinkPath
        }
      ]),
      /invalid_attachment_path/
    );
  } finally {
    await fs.rm(symlinkPath, { force: true });
    await fs.rm(uploadFolder, { recursive: true, force: true });
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
