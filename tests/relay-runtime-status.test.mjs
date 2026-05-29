import assert from 'node:assert/strict';
import test from 'node:test';

import { buildRelayStatus, relayStateFrom } from '../server/relay-runtime-status.js';

test('authenticated healthy relay remains ready after historical timeout metrics', () => {
  const state = relayStateFrom({
    authenticated: true,
    macConnected: true,
    macLocalReachable: true,
    relayRequestsTimedOut: 3
  });

  assert.equal(state, 'ready');
});

test('authenticated healthy relay remains ready after historical heartbeat misses', () => {
  const state = relayStateFrom({
    authenticated: true,
    macConnected: true,
    macLocalReachable: true,
    macHeartbeatMissesTotal: 2
  });

  assert.equal(state, 'ready');
});

test('relay status exposes historical metrics without degrading a healthy Mac connection', () => {
  const status = buildRelayStatus({
    authenticated: true,
    browserSocketsCurrent: 0,
    heartbeatMs: 15000,
    idleHeartbeatMs: 240000,
    macConnectionEpoch: 1,
    macConnected: true,
    macInfo: {
      deviceName: 'test-mac',
      connectedAt: '2026-05-20T00:00:00.000Z',
      lastSeenAt: '2026-05-20T00:00:01.000Z',
      localStatus: { reachable: true, checkedAt: '2026-05-20T00:00:01.000Z' }
    },
    metrics: {
      relayRequestsTimedOut: 2,
      macHeartbeatMissesTotal: 2
    },
    pendingRelayRequests: 0,
    pendingRequestsMax: 64,
    browserPendingRequestsMax: 6,
    browserTokenRequestsPerMinute: 120,
    browserTokenRequestWindowMs: 60000,
    requestBodyMaxBytes: 2097152,
    previousRelaySecret: '',
    realtimeSocketsCurrent: 0,
    relayStartedAt: '2026-05-20T00:00:00.000Z'
  });

  assert.equal(status.relayState, 'ready');
  assert.equal(status.metrics.relayRequestsTimedOut, 2);
  assert.equal(status.metrics.macHeartbeatMissesTotal, 2);
});
