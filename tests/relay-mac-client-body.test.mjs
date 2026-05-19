import assert from 'node:assert/strict';
import test from 'node:test';

import { encodeResponseBody } from '../scripts/relay-mac-client-body.mjs';

const MAX_BODY_BYTES = 1024;
const HTTP_OK = 200;

function createResponse(body, contentType = 'application/json') {
  return new Response(body, {
    status: HTTP_OK,
    headers: {
      'content-type': contentType
    }
  });
}

test('encodeResponseBody preserves invalid JSON response text instead of returning empty object', async () => {
  const encoded = await encodeResponseBody(createResponse('{not valid json'), {
    maxBodyBytes: MAX_BODY_BYTES
  });

  assert.equal(encoded.bodyEncoding, 'text');
  assert.equal(encoded.body, '{not valid json');
});
