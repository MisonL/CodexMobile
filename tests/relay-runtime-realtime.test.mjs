import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { createRealtimeTunnelManager } from '../server/relay-runtime-realtime.js';

class FakeSocket extends EventEmitter {
  constructor() {
    super();
    this.OPEN = 1;
    this.CONNECTING = 0;
    this.CLOSED = 3;
    this.readyState = this.OPEN;
    this.bufferedAmount = 0;
    this.sent = [];
    this.closed = null;
  }

  send(value) {
    this.sent.push(value);
  }

  close(code, reason) {
    this.readyState = this.CLOSED;
    this.closed = { code, reason: String(reason || '') };
    this.emit('close', code, Buffer.from(String(reason || '')));
  }
}

function createManager({ maxFrameBytes = 8 } = {}) {
  const macSocket = new FakeSocket();
  const realtimeSockets = new Map();
  const manager = createRealtimeTunnelManager({
    realtimeSockets,
    createRequestId: () => 'realtime-1',
    getMacSocket: () => macSocket,
    getMacConnectionEpoch: () => 1,
    assertMacAvailable: () => {},
    browserTokenKey: () => 'token-key',
    metrics: { realtimeTunnelsTotal: 0, realtimeTunnelsClosedTotal: 0 },
    scheduleHeartbeat: () => {},
    maxFrameBytes
  });
  return { macSocket, manager, realtimeSockets };
}

test('realtime tunnel closes oversized browser frames before forwarding to Mac', () => {
  const { macSocket, manager } = createManager({ maxFrameBytes: 4 });
  const browserSocket = new FakeSocket();
  manager.acceptSocket(browserSocket, 'valid-token');

  browserSocket.emit('message', Buffer.alloc(5), true);

  assert.equal(macSocket.sent.some((item) => String(item).includes('realtime.frame')), false);
  assert.equal(macSocket.sent.length, 2);
  assert.match(macSocket.sent[0], /realtime.open/);
  assert.deepEqual(browserSocket.closed, {
    code: 1009,
    reason: 'relay_realtime_frame_too_large'
  });
});

test('realtime open forwards token only as a frame field', () => {
  const { macSocket, manager } = createManager();
  const browserSocket = new FakeSocket();
  manager.acceptSocket(browserSocket, 'valid-token');

  const openFrame = JSON.parse(macSocket.sent[0]);

  assert.equal(openFrame.type, 'realtime.open');
  assert.equal(openFrame.path, '/ws/realtime');
  assert.equal(openFrame.token, 'valid-token');
  assert.doesNotMatch(openFrame.path, /token=/);
});

test('realtime tunnel rejects oversized text frames before forwarding to Mac', () => {
  const { macSocket, manager } = createManager({ maxFrameBytes: 4 });
  const browserSocket = new FakeSocket();
  manager.acceptSocket(browserSocket, 'valid-token');

  browserSocket.emit('message', '12345', false);

  assert.equal(macSocket.sent.some((item) => String(item).includes('realtime.frame')), false);
  assert.deepEqual(browserSocket.closed, {
    code: 1009,
    reason: 'relay_realtime_frame_too_large'
  });
});
