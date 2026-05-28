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

function createStreamRequestWithHandlers(store, streamHandlers) {
  return store.create({
    envelope: { requestId: 'stream-request-1' },
    timeoutMs: TEST_TIMEOUT_MS,
    epoch: TEST_EPOCH,
    streamHandlers
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

test('stream end validates chunk and byte totals before settling', async () => {
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
  await handler.handle({
    type: 'http.response.chunk',
    requestId,
    macConnectionEpoch: TEST_EPOCH,
    sequence: FIRST_CHUNK_SEQUENCE,
    encoding: 'base64',
    data: Buffer.from(TEST_CHUNK_TEXT).toString('base64'),
    bytes: TEST_CHUNK_BYTES
  });

  try {
    const error = await captureRejection(handler.handle({
      type: 'http.response.end',
      requestId,
      macConnectionEpoch: TEST_EPOCH,
      chunks: FIRST_CHUNK_SEQUENCE,
      totalBytes: TEST_CHUNK_BYTES + 1
    }));

    assert.match(error.message, /relay_stream_end_mismatch/);
    assert.equal(error.status, ERROR_STATUS_BAD_GATEWAY);
    assert.equal(store.size, 0);
    assert.equal(changedCount(), EXPECTED_CHANGED_COUNT_AFTER_SETTLE);
    await assert.rejects(response, /relay_stream_end_mismatch/);
  } finally {
    cleanupPending(store, requestId);
  }
});

test('unknown stream payload settles pending request instead of resolving successfully', async () => {
  const { store, changedCount } = createStore();
  const { requestId, response } = createStreamRequest(store);
  response.catch(() => {});
  const handler = createStreamResponseHandler({ pendingRequests: store });

  try {
    const error = await captureRejection(handler.handle({
      type: 'http.response.trailer',
      requestId,
      macConnectionEpoch: TEST_EPOCH
    }));

    assert.match(error.message, /relay_stream_payload_unsupported/);
    assert.equal(error.status, ERROR_STATUS_BAD_GATEWAY);
    assert.equal(store.size, 0);
    assert.equal(changedCount(), EXPECTED_CHANGED_COUNT_AFTER_SETTLE);
    await assert.rejects(response, /relay_stream_payload_unsupported/);
  } finally {
    cleanupPending(store, requestId);
  }
});

test('duplicate stream end after settle is ignored', async () => {
  const { store } = createStore();
  const { requestId, response } = createStreamRequest(store);
  const handler = createStreamResponseHandler({ pendingRequests: store });

  await handler.handle({
    type: 'http.response.start',
    requestId,
    macConnectionEpoch: TEST_EPOCH,
    status: HTTP_OK,
    headers: {}
  });
  await handler.handle({
    type: 'http.response.end',
    requestId,
    macConnectionEpoch: TEST_EPOCH,
    chunks: 0,
    totalBytes: 0
  });

  await assert.doesNotReject(async () => handler.handle({
    type: 'http.response.end',
    requestId,
    macConnectionEpoch: TEST_EPOCH,
    chunks: 0,
    totalBytes: 0
  }));
  assert.equal(store.size, 0);
  await response;
});

test('stream start handler failure rejects pending request', async () => {
  const { store } = createStore();
  const { requestId, response } = createStreamRequestWithHandlers(store, {
    onStart: async () => {
      throw new Error('start failed');
    }
  });
  response.catch(() => {});
  const handler = createStreamResponseHandler({ pendingRequests: store });

  try {
    const error = await captureRejection(handler.handle({
      type: 'http.response.start',
      requestId,
      macConnectionEpoch: TEST_EPOCH,
      status: HTTP_OK,
      headers: {}
    }));

    assert.match(error.message, /start failed/);
    assert.equal(store.size, 0);
    await assert.rejects(response, /start failed/);
  } finally {
    cleanupPending(store, requestId);
  }
});

test('stream end handler failure rejects pending request', async () => {
  const { store } = createStore();
  const { requestId, response } = createStreamRequestWithHandlers(store, {
    onStart: async () => {},
    onEnd: async () => {
      throw new Error('end failed');
    }
  });
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
      type: 'http.response.end',
      requestId,
      macConnectionEpoch: TEST_EPOCH,
      chunks: 0,
      totalBytes: 0
    }));

    assert.match(error.message, /end failed/);
    assert.equal(store.size, 0);
    await assert.rejects(response, /end failed/);
  } finally {
    cleanupPending(store, requestId);
  }
});

test('stream error handler failure still rejects pending response', async () => {
  const { store } = createStore();
  const { requestId, response } = createStreamRequestWithHandlers(store, {
    onError: async () => {
      throw new Error('write failed');
    }
  });
  response.catch(() => {});
  const handler = createStreamResponseHandler({ pendingRequests: store });

  try {
    const error = await captureRejection(handler.handle({
      type: 'http.stream.error',
      requestId,
      macConnectionEpoch: TEST_EPOCH,
      status: 503,
      error: 'mac_stream_failed'
    }));

    assert.match(error.message, /write failed/);
    assert.equal(error.status, 503);
    assert.equal(store.size, 0);
    await assert.rejects(response, /mac_stream_failed/);
  } finally {
    cleanupPending(store, requestId);
  }
});
