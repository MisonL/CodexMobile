import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { createMacConnectionManager } from '../server/relay-runtime-mac.js';

class FakeSocket extends EventEmitter {
  constructor() {
    super();
    this.OPEN = 1;
    this.CLOSED = 3;
    this.readyState = this.OPEN;
    this.sent = [];
    this.closed = null;
    this.terminated = false;
  }

  send(value) {
    this.sent.push(value);
  }

  close(code, reason) {
    this.readyState = this.CLOSED;
    this.closed = { code, reason: String(reason || '') };
    this.emit('close');
  }

  terminate() {
    this.readyState = this.CLOSED;
    this.terminated = true;
    this.emit('close');
  }
}

function createManager(options = {}) {
  const metrics = {
    macConnectsTotal: 0,
    macDisconnectsTotal: 0,
    macHeartbeatMissesTotal: 0,
    multiMacRejectedTotal: 0
  };
  const manager = createMacConnectionManager({
    createRequestId: () => 'connection-1',
    heartbeatMs: 1000,
    idleHeartbeatMs: 1000,
    metrics,
    pendingRequests: {
      size: options.pendingSize || 0,
      failForEpoch: (...args) => options.failForEpoch?.(...args)
    },
    hasActiveBrowserWork: () => Boolean(options.activeBrowserWork),
    broadcastStatus: () => options.broadcastStatus?.(),
    closeRealtimeForEpoch: (...args) => options.closeRealtimeForEpoch?.(...args)
  });
  return { manager, metrics };
}

test('mac connector identity can rotate after previous socket is offline and idle', () => {
  const { manager, metrics } = createManager();
  const first = new FakeSocket();
  const second = new FakeSocket();

  manager.attachSocket(first, {
    connectorInstanceId: 'cmac-first',
    deviceName: 'first-mac'
  });
  first.readyState = first.CLOSED;
  manager.attachSocket(second, {
    connectorInstanceId: 'cmac-second',
    deviceName: 'second-mac'
  });

  assert.equal(second.closed, null);
  assert.equal(metrics.multiMacRejectedTotal, 0);
  assert.equal(metrics.macConnectsTotal, 2);
  assert.equal(manager.getInfo().connectorInstanceId, 'cmac-second');
  second.close(1000, 'test_cleanup');
});

test('mac connector identity remains pinned while relay work is active', () => {
  const { manager, metrics } = createManager({ pendingSize: 1 });
  const first = new FakeSocket();
  const second = new FakeSocket();

  manager.attachSocket(first, {
    connectorInstanceId: 'cmac-first',
    deviceName: 'first-mac'
  });
  first.readyState = first.CLOSED;
  manager.attachSocket(second, {
    connectorInstanceId: 'cmac-second',
    deviceName: 'second-mac'
  });

  assert.deepEqual(second.closed, {
    code: 4009,
    reason: 'ambiguous_mac_route'
  });
  assert.equal(metrics.multiMacRejectedTotal, 1);
  assert.equal(manager.getInfo().connectorInstanceId, 'cmac-first');
});

test('missed heartbeat terminates stale Mac socket and clears active relay state', async () => {
  const failedEpochs = [];
  const closedRealtime = [];
  let broadcastCount = 0;
  const { manager, metrics } = createManager({
    failForEpoch: (...args) => failedEpochs.push(args),
    closeRealtimeForEpoch: (...args) => closedRealtime.push(args),
    broadcastStatus: () => {
      broadcastCount += 1;
    }
  });
  const socket = new FakeSocket();

  manager.attachSocket(socket, {
    connectorInstanceId: 'cmac-first',
    deviceName: 'first-mac'
  });
  manager.scheduleHeartbeat();

  await new Promise((resolve) => setTimeout(resolve, 1100));
  assert.equal(socket.sent.length >= 1, true);
  await new Promise((resolve) => setTimeout(resolve, 1100));

  assert.deepEqual(socket.closed, { code: 4000, reason: 'mac_heartbeat_missed' });
  assert.equal(manager.isConnected(), false);
  assert.equal(metrics.macHeartbeatMissesTotal, 1);
  assert.equal(metrics.macDisconnectsTotal, 1);
  assert.deepEqual(failedEpochs, [[1, 502, 'mac_offline']]);
  assert.deepEqual(closedRealtime, [[1, 'mac_offline']]);
  assert.equal(broadcastCount >= 2, true);
});
