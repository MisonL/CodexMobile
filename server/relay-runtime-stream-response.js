const HTTP_BAD_GATEWAY = 502;

export function createStreamResponseHandler({ pendingRequests }) {
  async function handle(payload) {
    const pending = pendingRequests.get(payload.requestId);
    if (!pending || !pending.streamHandlers || (payload.macConnectionEpoch && payload.macConnectionEpoch !== pending.epoch)) {
      return;
    }
    if (payload.type === 'http.response.start') {
      pending.streamStarted = true;
      await pending.streamHandlers.onStart?.(payload);
      return;
    }
    if (payload.type === 'http.response.chunk') {
      await handleChunk(pending, payload);
      return;
    }
    if (payload.type === 'http.stream.error') {
      const settled = pendingRequests.settle(payload.requestId, () => {});
      await settled.streamHandlers.onError?.(payload);
      settled.reject(Object.assign(new Error(payload.error || 'relay_stream_error'), { status: payload.status || HTTP_BAD_GATEWAY }));
      return;
    }
    const settled = pendingRequests.settle(payload.requestId, () => {});
    await settled.streamHandlers.onEnd?.(payload);
    settled.resolve(payload);
  }

  async function handleChunk(pending, payload) {
    if (!pending.streamStarted) {
      throw settleStreamError(payload.requestId, 'relay_stream_start_missing');
    }
    const expectedSequence = pending.streamSequence + 1;
    const bytes = Buffer.from(payload.data || '', payload.encoding === 'base64' ? 'base64' : 'utf8');
    if (Number(payload.sequence) !== expectedSequence || Number(payload.bytes) !== bytes.length) {
      throw settleStreamError(payload.requestId, 'relay_stream_chunk_invalid');
    }
    pending.streamSequence = expectedSequence;
    await pending.streamHandlers.onChunk?.(bytes, payload);
  }

  function settleStreamError(requestId, message) {
    const error = Object.assign(new Error(message), { status: HTTP_BAD_GATEWAY });
    const settled = pendingRequests.settle(requestId, () => {});
    settled?.reject(error);
    return error;
  }

  return { handle };
}
