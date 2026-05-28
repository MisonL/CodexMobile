import assert from 'node:assert/strict';
import test from 'node:test';

import { encodeResponseBody } from '../scripts/relay-mac-client-body.mjs';
import { createHttpForwarder } from '../scripts/relay-mac-client-http.mjs';

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

test('stream request end validates chunk and byte totals before closing local stream', async () => {
  const messages = [];
  const relaySocket = {
    OPEN: 1,
    readyState: 1,
    send(value) {
      messages.push(JSON.parse(value));
    }
  };
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => new Promise(() => {});
  try {
    const forwarder = createHttpForwarder({
      getRelaySocket: () => relaySocket,
      getRelayEpoch: () => 1,
      getLocalStatus: () => ({ reachable: true }),
      checkLocalStatus: async () => ({ reachable: true }),
      ensureLocalEventSocket: async () => {},
      waitForRelayBackpressure: async () => {}
    });

    await forwarder.handleHttpRequestStart({
      type: 'http.request.start',
      requestId: 'stream-1',
      method: 'POST',
      path: '/api/uploads',
      headers: {},
      timeoutMs: 1000
    });
    forwarder.handleHttpRequestChunk({
      type: 'http.request.chunk',
      requestId: 'stream-1',
      sequence: 1,
      encoding: 'base64',
      data: Buffer.from('abc').toString('base64'),
      bytes: 3
    });
    forwarder.handleHttpRequestEnd({
      type: 'http.request.end',
      requestId: 'stream-1',
      chunks: 1,
      totalBytes: 4
    });

    assert.deepEqual(messages.at(-1), {
      type: 'http.error',
      requestId: 'stream-1',
      status: 502,
      error: 'relay_stream_end_mismatch',
      macConnectionEpoch: 1
    });
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('stream request end accepts legacy end frames without totals', async () => {
  const messages = [];
  const relaySocket = {
    OPEN: 1,
    readyState: 1,
    send(value) {
      messages.push(JSON.parse(value));
    }
  };
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => new Promise(() => {});
  try {
    const forwarder = createHttpForwarder({
      getRelaySocket: () => relaySocket,
      getRelayEpoch: () => 1,
      getLocalStatus: () => ({ reachable: true }),
      checkLocalStatus: async () => ({ reachable: true }),
      ensureLocalEventSocket: async () => {},
      waitForRelayBackpressure: async () => {}
    });

    await forwarder.handleHttpRequestStart({
      type: 'http.request.start',
      requestId: 'stream-legacy',
      method: 'POST',
      path: '/api/uploads',
      headers: {},
      timeoutMs: 1000
    });
    forwarder.handleHttpRequestChunk({
      type: 'http.request.chunk',
      requestId: 'stream-legacy',
      sequence: 1,
      encoding: 'base64',
      data: Buffer.from('abc').toString('base64'),
      bytes: 3
    });
    forwarder.handleHttpRequestEnd({
      type: 'http.request.end',
      requestId: 'stream-legacy'
    });

    assert.equal(messages.some((message) => message.requestId === 'stream-legacy' && message.type === 'http.error'), false);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('stream request end rejects null totals instead of coercing them to zero', async () => {
  const messages = [];
  const relaySocket = {
    OPEN: 1,
    readyState: 1,
    send(value) {
      messages.push(JSON.parse(value));
    }
  };
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => new Promise(() => {});
  try {
    const forwarder = createHttpForwarder({
      getRelaySocket: () => relaySocket,
      getRelayEpoch: () => 1,
      getLocalStatus: () => ({ reachable: true }),
      checkLocalStatus: async () => ({ reachable: true }),
      ensureLocalEventSocket: async () => {},
      waitForRelayBackpressure: async () => {}
    });

    await forwarder.handleHttpRequestStart({
      type: 'http.request.start',
      requestId: 'stream-null-totals',
      method: 'POST',
      path: '/api/uploads',
      headers: {},
      timeoutMs: 1000
    });
    forwarder.handleHttpRequestEnd({
      type: 'http.request.end',
      requestId: 'stream-null-totals',
      chunks: null,
      totalBytes: null
    });

    assert.deepEqual(messages.at(-1), {
      type: 'http.error',
      requestId: 'stream-null-totals',
      status: 502,
      error: 'relay_stream_end_mismatch',
      macConnectionEpoch: 1
    });
  } finally {
    globalThis.fetch = previousFetch;
  }
});
