import { once } from 'node:events';
import {
  DEFAULT_RELAY_WS_BUFFERED_BYTES,
  filterResponseHeaders,
  safeJsonParse
} from './relay-protocol.js';

const UPLOAD_STREAM_BYTES_MAX = 50 * 1024 * 1024;
const VOICE_STREAM_BYTES_MAX = 10 * 1024 * 1024;
const WS_BUFFER_CHECK_INTERVAL_MS = 10;
const WS_BUFFER_WAIT_TIMEOUT_MS = 30000;

export async function readRequestBody(req, maxBytes) {
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

export function encodeRequestBody(buffer, contentType) {
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

export function streamRequestLimit(pathname, fallback) {
  if (pathname === '/api/uploads') {
    return UPLOAD_STREAM_BYTES_MAX;
  }
  if (pathname === '/api/voice/transcribe') {
    return VOICE_STREAM_BYTES_MAX;
  }
  return fallback;
}

export async function waitForRelayBackpressure(getBufferedAmount, maxBufferedBytes = DEFAULT_RELAY_WS_BUFFERED_BYTES) {
  const startedAt = Date.now();
  while (getBufferedAmount() > maxBufferedBytes) {
    if (Date.now() - startedAt > WS_BUFFER_WAIT_TIMEOUT_MS) {
      throw Object.assign(new Error('relay_stream_backpressure_timeout'), { status: 502 });
    }
    await new Promise((resolve) => setTimeout(resolve, WS_BUFFER_CHECK_INTERVAL_MS));
  }
}

export function writeForwardedResponse(res, result) {
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

export async function writeResponseChunk(res, chunk) {
  if (res.write(chunk)) {
    return;
  }
  await once(res, 'drain');
}
