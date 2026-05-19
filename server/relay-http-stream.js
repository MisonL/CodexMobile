import {
  DEFAULT_RELAY_STREAM_CHUNK_BYTES,
  createRequestId,
  filterRequestHeaders,
  filterResponseHeaders,
  logRelayEvent,
  safePathWithQuery
} from './relay-protocol.js';
import { tokenRateLimitKey } from './relay-rate-limit.js';
import {
  streamRequestLimit,
  waitForRelayBackpressure,
  writeResponseChunk
} from './relay-http-body.js';

export function createRelayHttpStreams({ runtime, maxBodyBytes, requestTimeoutMs, sendRelayError }) {
  async function streamRequestToMac(req, url, requestId, browserToken) {
    const totalLimit = streamRequestLimit(url.pathname, maxBodyBytes);
    const start = await runtime.beginMacRequest({
      type: 'http.request.start',
      requestId,
      method: req.method || 'GET',
      path: safePathWithQuery(url.pathname, url.search),
      headers: filterRequestHeaders(req.headers),
      timeoutMs: requestTimeoutMs,
      totalBytes: Number(req.headers['content-length']) || 0
    }, requestTimeoutMs, {
      clientKey: browserToken ? `browser:${tokenRateLimitKey(browserToken)}` : ''
    });
    start.response.catch(() => {});
    try {
      const { chunks, totalBytes } = await sendRequestChunksToMac(req, start.requestId, totalLimit);
      runtime.sendMacRequestFrame(start.requestId, {
        type: 'http.request.end',
        chunks,
        totalBytes
      });
      return await start.response;
    } catch (error) {
      notifyMacRequestStreamError(start.requestId, error);
      throw error;
    }
  }

  async function streamResponseFromMac(req, res, url, browserToken, options = {}) {
    const startedAt = options.startedAt || Date.now();
    const requestId = options.requestId || createRequestId();
    let streamErrorHandled = false;
    try {
      if (options.countMetric !== false) {
        runtime.metrics.relayRequestsTotal += 1;
      }
      await runtime.requestMacStream({
        type: 'http.stream.request',
        requestId,
        method: req.method || 'GET',
        path: safePathWithQuery(url.pathname, url.search),
        headers: filterRequestHeaders(req.headers),
        timeoutMs: requestTimeoutMs,
        bodyEncoding: options.bodyEncoding || 'text',
        body: options.body || ''
      }, {
        onStart: (payload) => writeStreamResponseStart(res, payload),
        onChunk: (chunk) => writeResponseChunk(res, chunk),
        onEnd: () => endStreamResponse(res),
        onError: (payload) => {
          streamErrorHandled = true;
          writeStreamResponseError(res, payload);
        }
      }, requestTimeoutMs, {
        clientKey: browserToken ? `browser:${tokenRateLimitKey(browserToken)}` : ''
      });
      logRelayEvent('relay.stream_response.completed', {
        requestId,
        method: req.method || 'GET',
        path: url.pathname,
        durationMs: Date.now() - startedAt
      });
    } catch (error) {
      handleStreamResponseFailure({ req, res, url, requestId, startedAt, error, streamErrorHandled });
    }
  }

  async function sendRequestChunksToMac(req, requestId, totalLimit) {
    let chunks = 0;
    let totalBytes = 0;
    for await (const chunk of req) {
      totalBytes += chunk.length;
      if (totalBytes > totalLimit) {
        throw Object.assign(new Error('relay_body_too_large'), { status: 413 });
      }
      for (let offset = 0; offset < chunk.length; offset += DEFAULT_RELAY_STREAM_CHUNK_BYTES) {
        const slice = chunk.subarray(offset, offset + DEFAULT_RELAY_STREAM_CHUNK_BYTES);
        chunks += 1;
        runtime.sendMacRequestFrame(requestId, {
          type: 'http.request.chunk',
          sequence: chunks,
          encoding: 'base64',
          data: slice.toString('base64'),
          bytes: slice.length
        });
        await waitForRelayBackpressure(runtime.macBufferedAmount);
      }
    }
    return { chunks, totalBytes };
  }

  function handleStreamResponseFailure({ req, res, url, requestId, startedAt, error, streamErrorHandled }) {
    runtime.metrics.relayRequestsFailed += 1;
    if (!streamErrorHandled) {
      writeStreamResponseError(res, {
        status: error.status || 502,
        error: error.message || 'relay_stream_failed'
      });
    }
    logRelayEvent('relay.stream_response.failed', {
      requestId,
      method: req.method || 'GET',
      path: url.pathname,
      status: error.status || 502,
      durationMs: Date.now() - startedAt,
      error: error.message || 'relay_stream_failed'
    }, 'warn');
  }

  function writeStreamResponseStart(res, payload) {
    if (res.headersSent) {
      return;
    }
    res.writeHead(payload.status || 200, filterResponseHeaders(payload.headers || {}));
  }

  function endStreamResponse(res) {
    if (!res.headersSent) {
      res.writeHead(204, { 'cache-control': 'no-store' });
    }
    res.end();
  }

  function writeStreamResponseError(res, payload) {
    const error = payload.error || 'relay_stream_failed';
    if (!res.headersSent) {
      sendRelayError(res, payload.status || 502, error);
      return;
    }
    res.destroy(Object.assign(new Error(error), { status: payload.status || 502 }));
  }

  function notifyMacRequestStreamError(requestId, error) {
    try {
      runtime.sendMacRequestFrame(requestId, {
        type: 'http.request.error',
        status: error.status || 502,
        error: error.message || 'relay_stream_aborted'
      });
    } catch {}
    runtime.failMacRequest(requestId, error.status || 502, error.message || 'relay_stream_aborted');
  }

  return {
    streamRequestToMac,
    streamResponseFromMac
  };
}
