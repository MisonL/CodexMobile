import {
  browserTokenFromHeaders,
  filterRequestHeaders,
  sendWsJson
} from '../server/relay-protocol.js';
import {
  REQUEST_TIMEOUT_MS,
  buildLocalUrl
} from './relay-mac-client-config.mjs';
import {
  decodeBody,
  streamRequestBody
} from './relay-mac-client-body.mjs';
import { createHttpResponseSender } from './relay-mac-client-http-response.mjs';

export function createHttpForwarder({
  getRelaySocket,
  getRelayEpoch,
  getLocalStatus,
  checkLocalStatus,
  ensureLocalEventSocket,
  waitForRelayBackpressure
}) {
  const requestStreams = new Map();

  function sendRelayMessage(payload) {
    const socket = getRelaySocket();
    if (!socket || socket.readyState !== socket.OPEN) {
      return false;
    }
    return sendWsJson(socket, {
      ...payload,
      macConnectionEpoch: getRelayEpoch()
    });
  }
  const responseSender = createHttpResponseSender({
    sendRelayMessage,
    waitForRelayBackpressure
  });

  async function ensureLocalReachable() {
    if (!getLocalStatus().reachable) {
      await checkLocalStatus();
    }
    return getLocalStatus().reachable;
  }

  async function handleAuthValidate(message) {
    const requestId = message.requestId;
    try {
      const status = await checkLocalStatus();
      if (!status.reachable) {
        sendRelayMessage({
          type: 'auth.validate.result',
          requestId,
          valid: false,
          error: 'mac_local_offline'
        });
        return;
      }
      const response = await fetch(buildLocalUrl('/api/status'), {
        headers: {
          authorization: `Bearer ${message.token || ''}`,
          accept: 'application/json'
        },
        signal: AbortSignal.timeout(10000)
      });
      const data = await response.json().catch(() => ({}));
      sendRelayMessage({
        type: 'auth.validate.result',
        requestId,
        valid: Boolean(response.ok && data?.auth?.authenticated)
      });
      if (response.ok && data?.auth?.authenticated) {
        await ensureLocalEventSocket(message.token);
      }
    } catch {
      sendRelayMessage({
        type: 'auth.validate.result',
        requestId,
        valid: false,
        error: 'mac_local_offline'
      });
    }
  }

  async function handleHttpRequest(message) {
    const requestId = message.requestId;
    if (!(await ensureLocalReachable())) {
      sendHttpError(requestId, Object.assign(new Error('mac_local_offline'), { status: 503 }));
      return;
    }
    try {
      const response = await fetchLocalHttp(message);
      await responseSender.sendBuffered(requestId, response);
    } catch (error) {
      sendHttpError(requestId, error);
    }
  }

  async function fetchLocalHttp(message) {
    const browserToken = browserTokenFromHeaders(message.headers || {});
    if (browserToken) {
      await ensureLocalEventSocket(browserToken);
    }
    const method = String(message.method || 'GET').toUpperCase();
    return fetch(buildLocalUrl(message.path), {
      method,
      headers: filterRequestHeaders(message.headers || {}),
      body: ['GET', 'HEAD'].includes(method) ? undefined : decodeBody(message.bodyEncoding, message.body),
      signal: AbortSignal.timeout(message.timeoutMs || REQUEST_TIMEOUT_MS)
    });
  }

  function sendHttpError(requestId, error) {
    sendRelayMessage({
      type: 'http.error',
      requestId,
      status: error?.status || 502,
      error: error?.name === 'TimeoutError' ? 'relay_request_timeout' : error?.message || 'local_request_failed'
    });
  }

  async function handleHttpStreamRequest(message) {
    const requestId = message.requestId;
    if (!(await ensureLocalReachable())) {
      sendStreamError(requestId, Object.assign(new Error('mac_local_offline'), { status: 503 }));
      return;
    }
    try {
      const browserToken = browserTokenFromHeaders(message.headers || {});
      if (browserToken) {
        await ensureLocalEventSocket(browserToken);
      }
      const response = await fetch(buildLocalUrl(message.path), {
        method: message.method || 'GET',
        headers: filterRequestHeaders(message.headers || {}),
        body: streamRequestBody(message),
        signal: AbortSignal.timeout(message.timeoutMs || REQUEST_TIMEOUT_MS)
      });
      await responseSender.sendStreaming(requestId, response);
    } catch (error) {
      sendStreamError(requestId, error);
    }
  }

  function createStreamController() {
    let controller;
    const stream = new ReadableStream({
      start(nextController) {
        controller = nextController;
      }
    });
    return { stream, controller };
  }

  function closeRequestStream(requestId, error) {
    const entry = requestStreams.get(requestId);
    if (!entry) {
      return;
    }
    requestStreams.delete(requestId);
    try {
      if (error) {
        entry.controller.error(error);
      } else {
        entry.controller.close();
      }
    } catch {}
  }

  async function handleHttpRequestStart(message) {
    const requestId = message.requestId;
    const { stream, controller } = createStreamController();
    requestStreams.set(requestId, { controller, sequence: 0 });
    if (!(await ensureLocalReachable())) {
      closeRequestStream(requestId, new Error('mac_local_offline'));
      sendRelayMessage({
        type: 'http.error',
        requestId,
        status: 503,
        error: 'mac_local_offline'
      });
      return;
    }
    try {
      const browserToken = browserTokenFromHeaders(message.headers || {});
      if (browserToken) {
        await ensureLocalEventSocket(browserToken);
      }
      forwardStreamRequest(message, stream);
    } catch (error) {
      closeRequestStream(requestId, error);
      sendStreamError(requestId, error);
    }
  }

  function forwardStreamRequest(message, stream) {
    fetch(buildLocalUrl(message.path), {
      method: message.method || 'POST',
      headers: filterRequestHeaders(message.headers || {}),
      body: stream,
      duplex: 'half',
      signal: AbortSignal.timeout(message.timeoutMs || REQUEST_TIMEOUT_MS)
    })
      .then((response) => responseSender.sendBuffered(message.requestId, response))
      .catch((error) => sendStreamError(message.requestId, error))
      .finally(() => requestStreams.delete(message.requestId));
  }

  function sendStreamError(requestId, error) {
    sendRelayMessage({
      type: 'http.error',
      requestId,
      status: error?.status || 502,
      error: error?.name === 'TimeoutError' ? 'relay_request_timeout' : error?.message || 'local_request_failed'
    });
  }

  function handleHttpRequestChunk(message) {
    const entry = requestStreams.get(message.requestId);
    if (!entry) {
      sendStreamError(message.requestId, Object.assign(new Error('relay_stream_missing'), { status: 502 }));
      return;
    }
    try {
      const chunk = message.encoding === 'base64'
        ? Buffer.from(message.data || '', 'base64')
        : Buffer.from(String(message.data || ''));
      const expectedSequence = entry.sequence + 1;
      if (Number(message.sequence) !== expectedSequence) {
        throw Object.assign(new Error('relay_stream_sequence_mismatch'), { status: 502 });
      }
      if (Number(message.bytes) !== chunk.length) {
        throw Object.assign(new Error('relay_stream_chunk_size_mismatch'), { status: 502 });
      }
      entry.sequence = expectedSequence;
      entry.controller.enqueue(chunk);
    } catch (error) {
      closeRequestStream(message.requestId, error);
      sendStreamError(message.requestId, error);
    }
  }

  function handleHttpRequestEnd(message) {
    if (!requestStreams.has(message.requestId)) {
      sendStreamError(message.requestId, Object.assign(new Error('relay_stream_missing'), { status: 502 }));
      return;
    }
    closeRequestStream(message.requestId);
  }

  function handleHttpRequestError(message) {
    closeRequestStream(message.requestId, new Error(message.error || 'relay_stream_aborted'));
  }

  return {
    handleAuthValidate,
    handleHttpRequest,
    handleHttpRequestChunk,
    handleHttpRequestEnd,
    handleHttpRequestError,
    handleHttpRequestStart,
    handleHttpStreamRequest
  };
}
