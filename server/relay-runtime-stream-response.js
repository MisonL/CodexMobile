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
      settled.reject(Object.assign(new Error(payload.error || 'relay_stream_error'), { status: payload.status || 502 }));
      return;
    }
    const settled = pendingRequests.settle(payload.requestId, () => {});
    await settled.streamHandlers.onEnd?.(payload);
    settled.resolve(payload);
  }

  async function handleChunk(pending, payload) {
    if (!pending.streamStarted) {
      throw Object.assign(new Error('relay_stream_start_missing'), { status: 502 });
    }
    const expectedSequence = pending.streamSequence + 1;
    const bytes = Buffer.from(payload.data || '', payload.encoding === 'base64' ? 'base64' : 'utf8');
    if (Number(payload.sequence) !== expectedSequence || Number(payload.bytes) !== bytes.length) {
      throw Object.assign(new Error('relay_stream_chunk_invalid'), { status: 502 });
    }
    pending.streamSequence = expectedSequence;
    await pending.streamHandlers.onChunk?.(bytes, payload);
  }

  return { handle };
}
