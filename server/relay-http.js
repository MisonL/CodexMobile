import fs from 'node:fs/promises';
import { once } from 'node:events';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import {
  DEFAULT_RELAY_STREAM_CHUNK_BYTES,
  DEFAULT_RELAY_WS_BUFFERED_BYTES,
  browserTokenFromHeaders,
  createRequestId,
  filterRequestHeaders,
  filterResponseHeaders,
  isRelayUnsupportedPath,
  isRelayStreamingRequest,
  logRelayEvent,
  safeJsonParse,
  safePathWithQuery
} from './relay-protocol.js';
import { clientIpFromRequest, tokenRateLimitKey } from './relay-rate-limit.js';

const mimeTypes = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.webmanifest', 'application/manifest+json; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
  ['.ico', 'image/x-icon']
]);
const compressibleExtensions = new Set(['.html', '.js', '.css', '.json', '.webmanifest', '.svg']);
const UPLOAD_STREAM_BYTES_MAX = 50 * 1024 * 1024;
const VOICE_STREAM_BYTES_MAX = 10 * 1024 * 1024;
const WS_BUFFER_CHECK_INTERVAL_MS = 10;
const WS_BUFFER_WAIT_TIMEOUT_MS = 30000;

export function sendJson(res, status, payload, headers = {}) {
  const body = Buffer.from(JSON.stringify(payload));
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store',
    ...headers
  });
  res.end(body);
}

function sendText(res, status, text, headers = {}) {
  const body = Buffer.from(String(text || ''));
  res.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'content-length': body.length,
    ...headers
  });
  res.end(body);
}

function acceptsGzip(req) {
  return /\bgzip\b/i.test(req.headers['accept-encoding'] || '');
}

function staticCacheControl(ext, filePath = '') {
  if (ext === '.html') {
    return 'no-store';
  }
  return filePath.split(path.sep).join('/').includes('/assets/')
    ? 'public, max-age=31536000, immutable'
    : 'public, max-age=3600';
}

function sendStaticContent(req, res, status, content, headers, ext) {
  let body = content;
  const nextHeaders = { ...headers };
  if (content.length >= 1024 && compressibleExtensions.has(ext) && acceptsGzip(req)) {
    body = gzipSync(content);
    nextHeaders['content-encoding'] = 'gzip';
    nextHeaders.vary = nextHeaders.vary ? `${nextHeaders.vary}, Accept-Encoding` : 'Accept-Encoding';
  }
  nextHeaders['content-length'] = body.length;
  res.writeHead(status, nextHeaders);
  res.end(body);
}

async function serveStatic(req, res, url, clientDist) {
  let requestedPath = decodeURIComponent(url.pathname);
  if (requestedPath === '/') {
    requestedPath = '/index.html';
  }
  const candidate = path.normalize(path.join(clientDist, requestedPath));
  if (candidate !== clientDist && !candidate.startsWith(`${clientDist}${path.sep}`)) {
    sendText(res, 403, 'Forbidden');
    return;
  }
  try {
    const stat = await fs.stat(candidate);
    const filePath = stat.isDirectory() ? path.join(candidate, 'index.html') : candidate;
    const ext = path.extname(filePath);
    const content = await fs.readFile(filePath);
    sendStaticContent(req, res, 200, content, {
      'content-type': mimeTypes.get(ext) || 'application/octet-stream',
      'cache-control': staticCacheControl(ext, filePath),
      'x-content-type-options': 'nosniff'
    }, ext);
  } catch {
    await serveStaticFallback(req, res, clientDist);
  }
}

async function serveStaticFallback(req, res, clientDist) {
  const indexPath = path.join(clientDist, 'index.html');
  try {
    const content = await fs.readFile(indexPath);
    sendStaticContent(req, res, 200, content, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff'
    }, '.html');
  } catch {
    sendText(res, 200, 'CodexMobile relay is running. Build the PWA with: npm run build');
  }
}

async function readRequestBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let settled = false;
    req.on('data', (chunk) => {
      if (settled) {
        return;
      }
      total += chunk.length;
      if (total > maxBytes) {
        settled = true;
        req.resume();
        reject(Object.assign(new Error('relay_body_too_large'), { status: 413 }));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!settled) {
        settled = true;
        resolve(Buffer.concat(chunks));
      }
    });
    req.on('error', (error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
  });
}

function encodeRequestBody(buffer, contentType) {
  if (!buffer?.length) {
    return { bodyEncoding: 'text', body: '' };
  }
  if (/application\/json/i.test(contentType || '')) {
    const text = buffer.toString('utf8');
    return { bodyEncoding: 'json', body: safeJsonParse(text) ?? text };
  }
  if (/^text\//i.test(contentType || '')) {
    return { bodyEncoding: 'text', body: buffer.toString('utf8') };
  }
  return { bodyEncoding: 'base64', body: buffer.toString('base64') };
}

function streamRequestLimit(pathname, fallback) {
  if (pathname === '/api/uploads') {
    return UPLOAD_STREAM_BYTES_MAX;
  }
  if (pathname === '/api/voice/transcribe') {
    return VOICE_STREAM_BYTES_MAX;
  }
  return fallback;
}

async function waitForRelayBackpressure(getBufferedAmount, maxBufferedBytes = DEFAULT_RELAY_WS_BUFFERED_BYTES) {
  const startedAt = Date.now();
  while (getBufferedAmount() > maxBufferedBytes) {
    if (Date.now() - startedAt > WS_BUFFER_WAIT_TIMEOUT_MS) {
      throw Object.assign(new Error('relay_stream_backpressure_timeout'), { status: 502 });
    }
    await new Promise((resolve) => setTimeout(resolve, WS_BUFFER_CHECK_INTERVAL_MS));
  }
}

function writeForwardedResponse(res, result) {
  const headers = filterResponseHeaders(result.headers || {});
  let body = Buffer.alloc(0);
  if (result.bodyEncoding === 'json') {
    body = Buffer.from(JSON.stringify(result.body ?? {}));
    headers['content-type'] = headers['content-type'] || 'application/json; charset=utf-8';
  } else if (result.bodyEncoding === 'base64') {
    body = Buffer.from(result.body || '', 'base64');
  } else {
    body = Buffer.from(String(result.body || ''));
    headers['content-type'] = headers['content-type'] || 'text/plain; charset=utf-8';
  }
  headers['content-length'] = body.length;
  res.writeHead(result.status || 502, headers);
  res.end(body);
}

async function writeResponseChunk(res, chunk) {
  if (res.write(chunk)) {
    return;
  }
  await once(res, 'drain');
}

export function createRelayHttpHandler({ clientDist, maxBodyBytes, requestTimeoutMs, runtime, rateLimiter, trustProxy }) {
  function sendRateLimited(res, result) {
    runtime.metrics.rateLimitedTotal += 1;
    logRelayEvent('relay.rate_limited', { retryAfter: result.retryAfter });
    sendJson(res, 429, { error: 'relay_rate_limited', retryAfter: result.retryAfter });
  }

  function sendRelayError(res, status, message) {
    if (status === 429 && String(message).includes('pending_limit_exceeded')) {
      sendJson(res, 429, { error: 'relay_rate_limited', reason: message, retryAfter: 0 });
      return;
    }
    sendJson(res, status, { error: message });
  }

  function consumeRateLimit(req, res, scope, token = '') {
    if (!rateLimiter) {
      return true;
    }
    const clientIp = clientIpFromRequest(req, trustProxy);
    const tokenPart = token ? `:${tokenRateLimitKey(token)}` : '';
    const result = rateLimiter.consume(`${scope}:${clientIp}${tokenPart}`, {
      limit: scope === 'pair' ? 10 : 60,
      windowMs: 60000
    });
    if (!result.allowed) {
      sendRateLimited(res, result);
      return false;
    }
    return true;
  }

  async function requireBrowserAuth(req, res) {
    const token = browserTokenFromHeaders(req.headers);
    if (token && !consumeRateLimit(req, res, 'token', token)) {
      return '';
    }
    try {
      if (await runtime.validateBrowserToken(token)) {
        return token;
      }
      sendJson(res, 401, { error: 'pairing_required' });
      return '';
    } catch (error) {
      sendRelayError(res, error.status || 503, error.message || 'mac_offline');
      return '';
    }
  }

  async function forwardHttpRequest(req, res, url, { authRequired = true } = {}) {
    const contentType = req.headers['content-type'] || '';
    const unsupported = isRelayUnsupportedPath(url.pathname, contentType);
    if (unsupported) {
      sendJson(res, 501, { error: unsupported });
      return;
    }
    let browserToken = '';
    if (authRequired) {
      browserToken = await requireBrowserAuth(req, res);
      if (!browserToken) {
        return;
      }
    }
    await forwardToMac(req, res, url, contentType, browserToken);
  }

  async function forwardToMac(req, res, url, contentType, browserToken = '') {
    const startedAt = Date.now();
    const requestId = createRequestId();
    try {
      runtime.metrics.relayRequestsTotal += 1;
      if (isRelayStreamingRequest(req.method, url.pathname, contentType)) {
        const result = await streamRequestToMac(req, url, requestId, browserToken);
        writeForwardedResponse(res, result);
        logForwardSuccess('relay.stream_request.completed', req, url, requestId, result, startedAt);
        return;
      }
      const buffer = await readRequestBody(req, maxBodyBytes);
      const result = await runtime.requestMac({
        type: 'http.request',
        requestId,
        method: req.method || 'GET',
        path: safePathWithQuery(url.pathname, url.search),
        headers: filterRequestHeaders(req.headers),
        timeoutMs: requestTimeoutMs,
        ...encodeRequestBody(buffer, contentType)
      }, requestTimeoutMs, {
        clientKey: browserToken ? `browser:${tokenRateLimitKey(browserToken)}` : ''
      });
      writeForwardedResponse(res, result);
      logForwardSuccess('relay.request.completed', req, url, requestId, result, startedAt);
    } catch (error) {
      runtime.metrics.relayRequestsFailed += 1;
      const status = error.status || 502;
      const message = error.message || 'relay_request_failed';
      sendRelayError(res, status, message);
      logForwardFailure(req, url, requestId, status, message, startedAt);
    }
  }

  function logForwardSuccess(event, req, url, requestId, result, startedAt) {
    logRelayEvent(event, {
      requestId,
      method: req.method || 'GET',
      path: url.pathname,
      status: result.status || 502,
      durationMs: Date.now() - startedAt
    });
  }

  function logForwardFailure(req, url, requestId, status, message, startedAt) {
    logRelayEvent('relay.request.failed', {
      requestId,
      method: req.method || 'GET',
      path: url.pathname,
      status,
      durationMs: Date.now() - startedAt,
      error: message
    }, 'warn');
  }

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

  async function streamResponseFromMac(req, res, url, browserToken) {
    const startedAt = Date.now();
    const requestId = createRequestId();
    let streamErrorHandled = false;
    try {
      runtime.metrics.relayRequestsTotal += 1;
      await runtime.requestMacStream({
        type: 'http.stream.request',
        requestId,
        method: req.method || 'GET',
        path: safePathWithQuery(url.pathname, url.search),
        headers: filterRequestHeaders(req.headers),
        timeoutMs: requestTimeoutMs
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

  async function handleApi(req, res, url) {
    if (req.method === 'GET' && url.pathname === '/api/status') {
      await handleStatus(req, res);
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/feishu/auth/callback') {
      sendJson(res, 501, { error: 'relay_unsupported', route: '/api/feishu/auth/callback' });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/pair') {
      if (!consumeRateLimit(req, res, 'pair')) {
        return;
      }
      await forwardHttpRequest(req, res, url, { authRequired: false });
      return;
    }
    await forwardHttpRequest(req, res, url, { authRequired: true });
  }

  async function handleStatus(req, res) {
    const token = browserTokenFromHeaders(req.headers);
    let authenticated = false;
    let authValidationDeferred = '';
    if (token) {
      try {
        authenticated = await runtime.validateBrowserToken(token);
      } catch (error) {
        if ((error.status || 0) >= 500) {
          authenticated = true;
          authValidationDeferred = error.message || 'mac_offline';
        }
      }
    }
    sendJson(res, 200, {
      ...runtime.currentRelayStatus(authenticated),
      ...(authValidationDeferred ? { authValidationDeferred } : {})
    });
  }

  return async function requestHandler(req, res) {
    const url = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);
    try {
      if (url.pathname === '/ws/realtime') {
        sendJson(res, 501, { error: 'relay_realtime_unsupported' });
        return;
      }
      if (url.pathname.startsWith('/api/')) {
        await handleApi(req, res, url);
        return;
      }
      if (url.pathname.startsWith('/generated/')) {
        const browserToken = await requireBrowserAuth(req, res);
        if (browserToken) {
          await streamResponseFromMac(req, res, url, browserToken);
        }
        return;
      }
      await serveStatic(req, res, url, clientDist);
    } catch (error) {
      sendJson(res, error.status || 500, { error: error.message || 'relay_internal_error' });
    }
  };
}
