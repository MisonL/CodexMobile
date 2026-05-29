import assert from 'node:assert/strict';
import test from 'node:test';

import {
  authenticatedFromStatus,
  canUseAppShellFromStatus,
  connectionStateFromStatus
} from '../client/src/relay-status.js';
import {
  ApiError,
  clearToken,
  getToken,
  isPairingRequiredError,
  readStoredValue,
  setToken
} from '../client/src/api.js';
import { hasAssistantResultForTurn, hasVisibleAssistantForTurn } from '../client/src/app-core-utils.js';
import {
  mergeServerMessagesWithLocalState,
  upsertAssistantMessage,
  upsertStatusMessage
} from '../client/src/app-message-state.js';
import { realtimeCloseMessage } from '../client/src/hooks/useRealtimeVoiceDialog.js';
import {
  handleRealtimeVoiceEvent,
  realtimeVoiceErrorMessage
} from '../client/src/hooks/voice-realtime-events.js';

function createMemoryStorage({ failWrites = false } = {}) {
  const entries = new Map();
  return {
    getItem: (key) => entries.get(key) || null,
    setItem: (key, value) => {
      if (failWrites) {
        throw new Error('storage_disabled');
      }
      entries.set(key, String(value));
    },
    removeItem: (key) => entries.delete(key)
  };
}

async function withLocalStorage(storage, callback) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: storage
  });
  try {
    await callback();
  } finally {
    if (previous) {
      Object.defineProperty(globalThis, 'localStorage', previous);
    } else {
      delete globalThis.localStorage;
    }
  }
}

test('deferred relay auth validation preserves app shell without marking status authenticated', () => {
  const status = {
    mode: 'relay',
    authenticated: false,
    requiresPairing: true,
    relayState: 'pairing_required',
    macConnected: false,
    authValidationDeferred: 'mac_offline'
  };

  assert.equal(authenticatedFromStatus(status), false);
  assert.equal(canUseAppShellFromStatus(status), true);
  assert.equal(connectionStateFromStatus(status), 'mac_offline');
});

test('unauthenticated relay status still requires pairing without deferred validation', () => {
  const status = {
    mode: 'relay',
    authenticated: false,
    requiresPairing: true,
    relayState: 'pairing_required',
    macConnected: false
  };

  assert.equal(authenticatedFromStatus(status), false);
  assert.equal(connectionStateFromStatus(status), 'pairing_required');
});

test('pairing token persists in browser storage until explicitly cleared', async () => {
  await withLocalStorage(createMemoryStorage(), async () => {
    setToken('device-token-1');
    assert.equal(getToken(), 'device-token-1');
    clearToken();
    assert.equal(getToken(), '');
  });
});

test('pairing fails visibly when browser storage cannot persist the token', async () => {
  await withLocalStorage(createMemoryStorage({ failWrites: true }), async () => {
    assert.throws(
      () => setToken('device-token-1'),
      /无法保存配对凭据/
    );
    assert.equal(getToken(), '');
  });
});

test('non-critical preferences fall back when browser storage is unavailable', async () => {
  await withLocalStorage(createMemoryStorage({ failWrites: true }), async () => {
    assert.equal(readStoredValue('codexmobile.theme', 'light'), 'light');
  });
});

test('pairing-required errors are detected from relay and legacy local responses', () => {
  assert.equal(isPairingRequiredError(new ApiError('需要重新配对这台 Mac。', {
    status: 401,
    code: 'pairing_required'
  })), true);
  assert.equal(isPairingRequiredError(new ApiError('Pairing required', {
    status: 401,
    code: 'Pairing required'
  })), true);
  assert.equal(isPairingRequiredError(new ApiError('Mac 连接器未在线。', {
    status: 503,
    code: 'mac_offline'
  })), false);
});

test('deferred auth validation is relay scoped only', () => {
  assert.equal(authenticatedFromStatus({
    authenticated: false,
    authValidationDeferred: 'mac_offline'
  }), false);
  assert.equal(canUseAppShellFromStatus({
    authenticated: false,
    authValidationDeferred: 'mac_offline'
  }), false);
});

test('realtime voice close reasons are visible to mobile users', () => {
  assert.equal(realtimeCloseMessage({ reason: 'mac_offline' }), 'Mac 连接器未在线');
  assert.equal(realtimeCloseMessage({ reason: 'relay_realtime_backpressure' }), '实时语音连接拥塞，请稍后重试');
  assert.equal(realtimeCloseMessage({ reason: 'local_realtime_rejected' }), 'local_realtime_rejected');
  assert.equal(realtimeCloseMessage({ reason: 'fixture_realtime_done' }), '');
});

test('realtime voice error codes are visible to mobile users', () => {
  assert.equal(realtimeVoiceErrorMessage('realtime_audio_frame_too_large'), '实时语音数据过大');
  assert.equal(realtimeVoiceErrorMessage({ message: 'realtime_pending_queue_overflow' }), '实时语音请求积压过多，请稍后重试');
  assert.equal(realtimeVoiceErrorMessage('provider_error'), 'provider_error');
});

test('realtime voice error closes realtime mode and returns to idle', () => {
  const modes = [];
  let stopped = false;
  let error = '';
  const ctx = {
    openRef: { current: true },
    realtimeRef: { current: true },
    awaitingResponseRef: { current: true },
    bargeInStartedAtRef: { current: 0 },
    setErrorBriefly: (message) => {
      error = message;
      modes.push('error');
    },
    setMode: (mode) => modes.push(mode),
    stopRealtime: () => {
      stopped = true;
    }
  };

  handleRealtimeVoiceEvent(ctx, {
    type: 'voice.realtime.error',
    error: 'realtime_pending_queue_overflow'
  });

  assert.equal(error, '实时语音请求积压过多，请稍后重试');
  assert.equal(stopped, true);
  assert.equal(ctx.awaitingResponseRef.current, false);
  assert.equal(modes.at(-1), 'idle');
});

test('turn refresh requires exact assistant turn match when turnId is known', () => {
  const messages = [
    { role: 'user', content: 'latest user', turnId: 'turn-new' },
    { id: 'message-old', role: 'assistant', content: 'previous assistant', turnId: 'turn-old' }
  ];

  assert.equal(hasVisibleAssistantForTurn(messages, { turnId: 'turn-new' }), false);
  assert.equal(hasVisibleAssistantForTurn(messages, { messageId: 'message-old' }), true);
  assert.equal(hasVisibleAssistantForTurn(messages, {}), true);
});

test('completed mobile turns accept latest assistant fallback when persisted messages lack turn metadata', () => {
  const messages = [
    { role: 'user', content: 'latest user' },
    { id: 'persisted-assistant', role: 'assistant', content: 'complete answer' }
  ];

  assert.equal(hasVisibleAssistantForTurn(messages, { turnId: 'turn-new' }), false);
  assert.equal(
    hasAssistantResultForTurn(messages, {
      turnId: 'turn-new',
      hadAssistantText: true,
      allowLatestAssistantFallback: true
    }),
    true
  );
  assert.equal(
    hasAssistantResultForTurn(messages, {
      turnId: 'turn-new',
      status: 'completed',
      allowLatestAssistantFallback: true
    }),
    true
  );
  assert.equal(hasAssistantResultForTurn(messages, { turnId: 'turn-new' }), false);
});

test('completed mobile fallback refuses mismatched assistant message ids', () => {
  const messages = [
    { role: 'user', content: 'latest user' },
    { id: 'persisted-assistant', role: 'assistant', content: 'complete answer' }
  ];

  assert.equal(
    hasAssistantResultForTurn(messages, {
      turnId: 'turn-new',
      messageId: 'assistant-from-other-turn',
      status: 'completed',
      allowLatestAssistantFallback: true
    }),
    false
  );
});

test('completed mobile fallback ignores assistants before the latest user', () => {
  const messages = [
    { id: 'assistant-old', role: 'assistant', content: 'previous answer' },
    { role: 'user', content: 'latest user' }
  ];

  assert.equal(hasAssistantResultForTurn(messages, { turnId: 'turn-new', hadAssistantText: true }), false);
});

test('terminal status without kind replaces running turn status', () => {
  const running = upsertStatusMessage([], {
    sessionId: 'session-1',
    turnId: 'turn-1',
    kind: 'turn',
    status: 'running',
    label: '正在思考中'
  });
  const next = upsertStatusMessage(running, {
    sessionId: 'session-1',
    turnId: 'turn-1',
    status: 'completed',
    label: '已中止'
  });

  assert.equal(next.length, 1);
  assert.equal(next[0].kind, 'turn');
  assert.equal(next[0].status, 'completed');
  assert.equal(next[0].label, '已中止');
});

test('final assistant update replaces preview fallback for the same turn', () => {
  const withPreview = upsertAssistantMessage([], {
    sessionId: 'session-1',
    turnId: 'turn-1',
    preview: true,
    content: 'partial answer'
  });
  const next = upsertAssistantMessage(withPreview, {
    sessionId: 'session-1',
    turnId: 'turn-1',
    messageId: 'item-1',
    content: 'complete answer'
  });

  assert.equal(next.length, 1);
  assert.equal(next[0].id, 'item-1');
  assert.equal(next[0].content, 'complete answer');
  assert.equal(next[0].preview, undefined);
});

test('reconnect message refresh preserves pending local turn state', () => {
  const current = [
    {
      id: 'local-1',
      role: 'user',
      content: 'latest user',
      sessionId: 'session-1',
      turnId: 'turn-1'
    },
    {
      id: 'activity-1',
      role: 'activity',
      content: '正在处理',
      sessionId: 'session-1',
      turnId: 'turn-1',
      status: 'running'
    }
  ];
  const serverMessages = [
    {
      id: 'persisted-user',
      role: 'user',
      content: 'latest user',
      sessionId: 'session-1',
      turnId: 'turn-1'
    }
  ];

  const next = mergeServerMessagesWithLocalState(current, serverMessages, {
    activeRuns: [{ sessionId: 'session-1', turnId: 'turn-1' }]
  });

  assert.deepEqual(next.map((message) => message.id), ['persisted-user', 'activity-1']);
});

test('reconnect message refresh drops local preview once assistant is persisted', () => {
  const current = [
    {
      id: 'assistant-turn-1',
      role: 'assistant',
      content: 'partial answer',
      sessionId: 'session-1',
      turnId: 'turn-1',
      preview: true
    }
  ];
  const serverMessages = [
    {
      id: 'assistant-1',
      role: 'assistant',
      content: 'complete answer',
      sessionId: 'session-1',
      turnId: 'turn-1'
    }
  ];

  const next = mergeServerMessagesWithLocalState(current, serverMessages, {
    activeRuns: [{ sessionId: 'session-1', turnId: 'turn-1' }]
  });

  assert.deepEqual(next.map((message) => message.id), ['assistant-1']);
});

test('reconnect message refresh drops inactive local activity', () => {
  const current = [
    {
      id: 'activity-1',
      role: 'activity',
      content: '正在处理',
      sessionId: 'session-1',
      turnId: 'turn-1',
      status: 'running'
    }
  ];

  const next = mergeServerMessagesWithLocalState(current, []);

  assert.deepEqual(next, []);
});
