import { DEFAULT_RELAY_WS_BUFFERED_BYTES } from '../server/relay-protocol.js';

const WS_BUFFER_CHECK_INTERVAL_MS = 10;
const WS_BUFFER_WAIT_TIMEOUT_MS = 30000;

export async function waitForSocketBackpressure(
  socket,
  {
    maxBufferedBytes = DEFAULT_RELAY_WS_BUFFERED_BYTES,
    errorMessage = 'relay_realtime_backpressure_timeout'
  } = {}
) {
  const startedAt = Date.now();
  while ((socket?.bufferedAmount || 0) > maxBufferedBytes) {
    if (Date.now() - startedAt > WS_BUFFER_WAIT_TIMEOUT_MS) {
      throw Object.assign(new Error(errorMessage), { status: 502 });
    }
    await new Promise((resolve) => setTimeout(resolve, WS_BUFFER_CHECK_INTERVAL_MS));
  }
}
