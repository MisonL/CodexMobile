const HTTP_BAD_GATEWAY = 502;

export function createStreamResponseHandler({ pendingRequests }) {
  const requireSettled = (requestId) => {
    const settled = pendingRequests.settle(requestId, () => {});
    if (!settled?.streamHandlers) {
      throw Object.assign(new Error('relay_stream_missing'), { status: HTTP_BAD_GATEWAY });
    }
    return settled;
  };

  const settleStreamError = (requestId, errorOrMessage) => {
    const error = errorOrMessage instanceof Error
      ? Object.assign(errorOrMessage, { status: errorOrMessage.status || HTTP_BAD_GATEWAY })
      : Object.assign(new Error(errorOrMessage), { status: HTTP_BAD_GATEWAY });
    const settled = pendingRequests.settle(requestId, () => {});
    settled?.reject(error);
    return error;
  };

  const streamErrorFromPayload = (payload) => {
    return Object.assign(new Error(payload.error || 'relay_stream_error'), {
      status: payload.status || HTTP_BAD_GATEWAY
    });
  };

  const handleChunk = async (pending, payload) => {
    if (!pending.streamStarted) {
      throw settleStreamError(payload.requestId, 'relay_stream_start_missing');
    }
    const expectedSequence = pending.streamSequence + 1;
    const bytes = Buffer.from(payload.data || '', payload.encoding === 'base64' ? 'base64' : 'utf8');
    if (Number(payload.sequence) !== expectedSequence || Number(payload.bytes) !== bytes.length) {
      throw settleStreamError(payload.requestId, 'relay_stream_chunk_invalid');
    }
    pending.streamSequence = expectedSequence;
    pending.streamBytes += bytes.length;
    await pending.streamHandlers.onChunk?.(bytes, payload);
  };

  const handleEnd = async (pending, payload) => {
    if (!pending.streamStarted) {
      throw settleStreamError(payload.requestId, 'relay_stream_start_missing');
    }
    const chunks = Number(payload.chunks);
    const totalBytes = Number(payload.totalBytes);
    if (
      !Number.isFinite(chunks) ||
      !Number.isFinite(totalBytes) ||
      chunks !== pending.streamSequence ||
      totalBytes !== pending.streamBytes
    ) {
      throw settleStreamError(payload.requestId, 'relay_stream_end_mismatch');
    }
    const settled = requireSettled(payload.requestId);
    try {
      await settled.streamHandlers.onEnd?.(payload);
      settled.resolve(payload);
    } catch (error) {
      settled.reject(Object.assign(error, { status: error.status || HTTP_BAD_GATEWAY }));
      throw error;
    }
  };

  const handle = async (payload) => {
    const pending = pendingRequests.get(payload.requestId);
    if (!pending || !pending.streamHandlers || (payload.macConnectionEpoch && payload.macConnectionEpoch !== pending.epoch)) {
      return;
    }
    if (payload.type === 'http.response.start') {
      pending.streamStarted = true;
      try {
        await pending.streamHandlers.onStart?.(payload);
      } catch (error) {
        throw settleStreamError(payload.requestId, error);
      }
      return;
    }
    if (payload.type === 'http.response.chunk') {
      await handleChunk(pending, payload);
      return;
    }
    if (payload.type === 'http.stream.error') {
      const settled = requireSettled(payload.requestId);
      const streamError = streamErrorFromPayload(payload);
      try {
        await settled.streamHandlers.onError?.(payload);
      } catch (error) {
        settled.reject(streamError);
        throw Object.assign(error, { status: error.status || streamError.status });
      }
      settled.reject(streamError);
      return;
    }
    if (payload.type === 'http.response.end') {
      await handleEnd(pending, payload);
      return;
    }
    throw settleStreamError(payload.requestId, 'relay_stream_payload_unsupported');
  };

  return { handle };
}
