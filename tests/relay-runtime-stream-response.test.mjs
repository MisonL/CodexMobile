import assert from 'node:assert/strict';
import test from 'node:test';

import { createPendingRequestStore } from '../server/relay-runtime-pending.js';
import { createStreamResponseHandler } from '../server/relay-runtime-stream-response.js';

const TEST_TIMEOUT_MS = 1000;
const ERROR_STATUS_BAD_GATEWAY = 502;
const TEST_EPOCH = 1;
const TEST_REQUEST_LIMIT = 10;
const EXPECTED_CHANGED_COUNT_AFTER_SETTLE = 2;
const HTTP_OK = 200;
const FIRST_CHUNK_SEQUENCE = 1;
const INVALID_CHUNK_SEQUENCE = 2;
const TEST_CHUNK_TEXT = 'hello';
const TEST_CHUNK_BYTES = Buffer.byteLength(TEST_CHUNK_TEXT);

function createStore() {
  const metrics = {
    pendingLimitRejectedTotal: 0,
    rateLimitedTotal: 0,
    relayRequestsTimedOut: 0
  };
  let changedCount = 0;
  return {
    metrics,
    changedCount: () => changedCount,
    store: createPendingRequestStore({
      createRequestId: () => 'request-1',
      metrics,
      onChanged: () => {
        changedCount += 1;
      },
      pendingRequestsMax: TEST_REQUEST_LIMIT,
      browserPendingRequestsMax: TEST_REQUEST_LIMIT
    })
  };
}

function createStreamRequest(store) {
  return store.create({
    envelope: { requestId: 'stream-request-1' },
    timeoutMs: TEST_TIMEOUT_MS,
    epoch: TEST_EPOCH,
    streamHandlers: {
      onStart: async () => {},
      onChunk: async () => {},
      onEnd: async () => {},
      onError: async () => {}
    }
  });
}

async function captureRejection(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected promise to reject');
}

function cleanupPending(store, requestId) {
  store.settle(requestId, (pending) => {
    pending.reject(new Error('test cleanup'));
  });
}

test('stream chunk before start settles pending request', async () => {
  const { store, changedCount } = createStore();
  const { requestId, response } = createStreamRequest(store);
  response.catch(() => {});
  const handler = createStreamResponseHandler({ pendingRequests: store });

  try {
    const error = await captureRejection(handler.handle({
      type: 'http.response.chunk',
      requestId,
      macConnectionEpoch: TEST_EPOCH,
      sequence: FIRST_CHUNK_SEQUENCE,
      encoding: 'base64',
      data: Buffer.from(TEST_CHUNK_TEXT).toString('base64'),
      bytes: TEST_CHUNK_BYTES
    }));

    assert.match(error.message, /relay_stream_start_missing/);
    assert.equal(error.status, ERROR_STATUS_BAD_GATEWAY);
    assert.equal(store.size, 0);
    assert.equal(changedCount(), EXPECTED_CHANGED_COUNT_AFTER_SETTLE);
    await assert.rejects(response, /relay_stream_start_missing/);
  } finally {
    cleanupPending(store, requestId);
  }
});

test('invalid stream chunk settles pending request', async () => {
  const { store, changedCount } = createStore();
  const { requestId, response } = createStreamRequest(store);
  response.catch(() => {});
  const handler = createStreamResponseHandler({ pendingRequests: store });

  await handler.handle({
    type: 'http.response.start',
    requestId,
    macConnectionEpoch: TEST_EPOCH,
    status: HTTP_OK,
    headers: {}
  });

  try {
    const error = await captureRejection(handler.handle({
      type: 'http.response.chunk',
      requestId,
      macConnectionEpoch: TEST_EPOCH,
      sequence: INVALID_CHUNK_SEQUENCE,
      encoding: 'base64',
      data: Buffer.from(TEST_CHUNK_TEXT).toString('base64'),
      bytes: TEST_CHUNK_BYTES
    }));

    assert.match(error.message, /relay_stream_chunk_invalid/);
    assert.equal(error.status, ERROR_STATUS_BAD_GATEWAY);
    assert.equal(store.size, 0);
    assert.equal(changedCount(), EXPECTED_CHANGED_COUNT_AFTER_SETTLE);
    await assert.rejects(response, /relay_stream_chunk_invalid/);
  } finally {
    cleanupPending(store, requestId);
  }
});
