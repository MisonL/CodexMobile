import {
  DEFAULT_RELAY_STREAM_CHUNK_BYTES,
  filterResponseHeaders
} from '../server/relay-protocol.js';
import { MAX_BODY_BYTES } from './relay-mac-client-config.mjs';
import { encodeResponseBody } from './relay-mac-client-body.mjs';

export function createHttpResponseSender({
  sendRelayMessage,
  waitForRelayBackpressure
}) {
  async function sendBuffered(requestId, response) {
    const encoded = await encodeResponseBody(response, { maxBodyBytes: MAX_BODY_BYTES });
    if (encoded.type === 'http.error') {
      sendRelayMessage({ ...encoded, requestId });
      return;
    }
    sendRelayMessage({
      type: 'http.response',
      requestId,
      status: response.status,
      headers: filterResponseHeaders(response.headers),
      ...encoded
    });
  }

  async function sendStreaming(requestId, response) {
    sendRelayMessage({
      type: 'http.response.start',
      requestId,
      status: response.status,
      headers: filterResponseHeaders(response.headers)
    });
    let sequence = 0;
    let totalBytes = 0;
    if (response.body) {
      for await (const chunk of response.body) {
        const buffer = Buffer.from(chunk);
        for (let offset = 0; offset < buffer.length; offset += DEFAULT_RELAY_STREAM_CHUNK_BYTES) {
          const slice = buffer.subarray(offset, offset + DEFAULT_RELAY_STREAM_CHUNK_BYTES);
          sequence += 1;
          totalBytes += slice.length;
          sendRelayMessage({
            type: 'http.response.chunk',
            requestId,
            sequence,
            encoding: 'base64',
            data: slice.toString('base64'),
            bytes: slice.length
          });
          await waitForRelayBackpressure();
        }
      }
    }
    sendRelayMessage({
      type: 'http.response.end',
      requestId,
      chunks: sequence,
      totalBytes
    });
  }

  return {
    sendBuffered,
    sendStreaming
  };
}
