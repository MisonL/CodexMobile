import {
  browserTokenFromHeaders,
  createRequestId,
  filterRequestHeaders,
  isRelayUnsupportedPath,
  isRelayStreamingRequest,
  isRelayStreamingResponseRequest,
  logRelayEvent,
  safePathWithQuery
} from './relay-protocol.js';
import {
  clientIpFromRequest,
  consumeBrowserTokenRequest,
  tokenRateLimitKey
} from './relay-rate-limit.js';
import {
  encodeRequestBody,
  readRequestBody,
  writeForwardedResponse
} from './relay-http-body.js';
import { createRelayHttpStreams } from './relay-http-stream.js';
import { serveStatic } from './relay-http-static.js';

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

export function createRelayHttpHandler({
  clientDist,
  maxBodyBytes,
  requestTimeoutMs,
  runtime,
  rateLimiter,
  trustProxy,
  browserTokenRequestsPerMinute = 120,
  browserTokenRequestWindowMs = 60000
}) {
  const streams = createRelayHttpStreams({ runtime, maxBodyBytes, requestTimeoutMs, sendRelayError });

  function sendRateLimited(res, result, reason = '') {
    runtime.metrics.rateLimitedTotal += 1;
    logRelayEvent('relay.rate_limited', { reason, retryAfter: result.retryAfter });
    sendJson(res, 429, {
      error: 'relay_rate_limited',
      ...(reason ? { reason } : {}),
      retryAfter: result.retryAfter
    });
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

  function consumeTokenRequestLimit(res, token) {
    const result = consumeBrowserTokenRequest(rateLimiter, token, {
      limit: browserTokenRequestsPerMinute,
      windowMs: browserTokenRequestWindowMs
    });
    if (!result.allowed) {
      runtime.metrics.browserTokenRateLimitedTotal += 1;
      sendRateLimited(res, result, 'relay_token_request_limit_exceeded');
      return false;
    }
    runtime.metrics.browserTokenRequestsTotal += 1;
    return true;
  }

  async function requireBrowserAuth(req, res) {
    const token = browserTokenFromHeaders(req.headers);
    if (token && !runtime.hasCachedBrowserToken(token) && !consumeRateLimit(req, res, 'token', token)) {
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
      if (!consumeTokenRequestLimit(res, browserToken)) {
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
        const result = await streams.streamRequestToMac(req, url, requestId, browserToken);
        writeForwardedResponse(res, result);
        logForwardSuccess('relay.stream_request.completed', req, url, requestId, result, startedAt);
        return;
      }
      const buffer = await readRequestBody(req, maxBodyBytes);
      if (isRelayStreamingResponseRequest(req.method, url.pathname)) {
        await streams.streamResponseFromMac(req, res, url, browserToken, {
          requestId,
          startedAt,
          countMetric: false,
          ...encodeRequestBody(buffer, contentType)
        });
        return;
      }
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
        sendJson(res, 501, { error: 'relay_realtime_http_upgrade_required' });
        return;
      }
      if (url.pathname.startsWith('/api/')) {
        await handleApi(req, res, url);
        return;
      }
      if (url.pathname.startsWith('/generated/')) {
        const browserToken = await requireBrowserAuth(req, res);
        if (browserToken) {
          if (!consumeTokenRequestLimit(res, browserToken)) {
            return;
          }
          await streams.streamResponseFromMac(req, res, url, browserToken);
        }
        return;
      }
      await serveStatic(req, res, url, clientDist);
    } catch (error) {
      sendJson(res, error.status || 500, { error: error.message || 'relay_internal_error' });
    }
  };
}
