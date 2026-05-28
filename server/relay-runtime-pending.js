export function createPendingRequestStore({
  createRequestId,
  metrics,
  onChanged,
  pendingRequestsMax,
  browserPendingRequestsMax
}) {
  const requests = new Map();

  function countForClient(clientKey) {
    if (!clientKey) {
      return 0;
    }
    let count = 0;
    for (const pending of requests.values()) {
      if (pending.clientKey === clientKey) {
        count += 1;
      }
    }
    return count;
  }

  function pendingLimitError(error) {
    metrics.pendingLimitRejectedTotal += 1;
    metrics.rateLimitedTotal += 1;
    return Object.assign(new Error(error), { status: 429 });
  }

  function assertCapacity(clientKey = '') {
    if (requests.size >= pendingRequestsMax) {
      throw pendingLimitError('relay_pending_limit_exceeded');
    }
    if (clientKey && countForClient(clientKey) >= browserPendingRequestsMax) {
      throw pendingLimitError('relay_client_pending_limit_exceeded');
    }
  }

  function deleteRequest(requestId) {
    const deleted = requests.delete(requestId);
    if (deleted) {
      onChanged?.();
    }
    return deleted;
  }

  const create = ({ envelope, timeoutMs, epoch, clientKey = '', streamHandlers = null }) => {
    const requestId = envelope.requestId || createRequestId();
    const pending = {
      resolve: () => {},
      reject: () => {},
      timer: null,
      epoch,
      clientKey,
      streamHandlers,
      streamSequence: 0,
      streamBytes: 0,
      streamStarted: false
    };
    const response = new Promise((resolve, reject) => {
      pending.resolve = resolve;
      pending.reject = reject;
    });
    pending.timer = setTimeout(() => {
      deleteRequest(requestId);
      metrics.relayRequestsTimedOut += 1;
      pending.reject(Object.assign(new Error('relay_request_timeout'), { status: 502 }));
    }, timeoutMs);

    requests.set(requestId, pending);
    onChanged?.();
    return { requestId, epoch, response };
  };

  function failForEpoch(epoch, status, error) {
    for (const [requestId, pending] of requests.entries()) {
      if (pending.epoch !== epoch) {
        continue;
      }
      clearTimeout(pending.timer);
      deleteRequest(requestId);
      pending.reject(Object.assign(new Error(error), { status }));
    }
  }

  function fail(requestId, status, error) {
    const pending = requests.get(requestId);
    if (!pending) {
      return;
    }
    clearTimeout(pending.timer);
    deleteRequest(requestId);
    pending.reject(Object.assign(new Error(error), { status }));
  }

  function settle(requestId, callback) {
    const pending = requests.get(requestId);
    if (!pending) {
      return null;
    }
    clearTimeout(pending.timer);
    deleteRequest(requestId);
    callback(pending);
    return pending;
  }

  return {
    get size() {
      return requests.size;
    },
    assertCapacity,
    create,
    delete: deleteRequest,
    fail,
    failForEpoch,
    get: (requestId) => requests.get(requestId),
    settle
  };
}
