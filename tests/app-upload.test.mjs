import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';

import { hasSupportedImageMagic, readBody } from '../server/http-utils.js';
import { saveUpload } from '../server/app-upload.js';

function multipartBody(boundary, contentType, content) {
  return Buffer.from([
    `--${boundary}\r\n`,
    'content-disposition: form-data; name="file"; filename="sample.png"\r\n',
    `content-type: ${contentType}\r\n\r\n`,
    content,
    `\r\n--${boundary}--\r\n`
  ].join(''));
}

function uploadRequest(contentType, body) {
  const req = Readable.from([body]);
  req.headers = { 'content-type': contentType };
  return req;
}

test('saveUpload does not classify spoofed image mime as image', async () => {
  const boundary = '----codexmobile-test-upload';
  const req = uploadRequest(
    `multipart/form-data; boundary=${boundary}`,
    multipartBody(boundary, 'image/png', 'not-a-png')
  );

  const upload = await saveUpload(req);

  assert.equal(upload.kind, 'file');
  assert.equal(upload.mimeType, 'image/png');
});

test('hasSupportedImageMagic accepts exact minimum image signatures', () => {
  const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const jpegSignature = Buffer.from([0xff, 0xd8, 0xff]);
  const webpSignature = Buffer.from('RIFF0000WEBP', 'ascii');

  assert.equal(hasSupportedImageMagic(pngSignature, 'image/png'), true);
  assert.equal(hasSupportedImageMagic(jpegSignature, 'image/jpeg'), true);
  assert.equal(hasSupportedImageMagic(webpSignature, 'image/webp'), true);
});

test('readBody marks oversized JSON requests as 413', async () => {
  const req = Readable.from(['{"message":"too large"}']);
  await assert.rejects(
    readBody(req, 4),
    (error) => {
      assert.equal(error.status, 413);
      assert.equal(error.statusCode, 413);
      assert.match(error.message, /Request body too large/);
      return true;
    }
  );
});

test('readBody enforces JSON limit by bytes for multibyte text', async () => {
  const req = Readable.from(['{"message":"中文"}']);
  await assert.rejects(
    readBody(req, 16),
    (error) => {
      assert.equal(error.status, 413);
      assert.equal(error.statusCode, 413);
      return true;
    }
  );
});
