import { safeJsonParse } from '../server/relay-protocol.js';

export function decodeBody(bodyEncoding, body) {
  if (!body) {
    return undefined;
  }
  if (bodyEncoding === 'json') {
    return typeof body === 'string' ? body : JSON.stringify(body);
  }
  if (bodyEncoding === 'base64') {
    return Buffer.from(body, 'base64');
  }
  return String(body);
}

export async function encodeResponseBody(response, { maxBodyBytes }) {
  const contentType = response.headers.get('content-type') || '';
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > maxBodyBytes) {
    return {
      type: 'http.error',
      status: 501,
      error: 'relay_streaming_required'
    };
  }
  if (/application\/json/i.test(contentType)) {
    const text = buffer.toString('utf8');
    return {
      bodyEncoding: 'json',
      body: safeJsonParse(text) ?? {}
    };
  }
  if (/^text\//i.test(contentType) || /charset=utf-8/i.test(contentType)) {
    return {
      bodyEncoding: 'text',
      body: buffer.toString('utf8')
    };
  }
  return {
    bodyEncoding: 'base64',
    body: buffer.toString('base64')
  };
}

export function streamRequestBody(message) {
  const method = String(message.method || 'GET').toUpperCase();
  if (['GET', 'HEAD'].includes(method)) {
    return undefined;
  }
  return decodeBody(message.bodyEncoding, message.body);
}
