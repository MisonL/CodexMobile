import assert from 'node:assert/strict';
import test from 'node:test';

import { createRealtimeHandoffController } from '../server/realtime-voice-handoff.js';
import {
  createPendingRealtimeQueue,
  createRealtimeSender,
  realtimeClientFrameByteLength
} from '../server/realtime-voice.js';

test('pending realtime queue rejects messages after byte limit', () => {
  const queue = createPendingRealtimeQueue({ maxMessages: 4, maxBytes: 10 });

  queue.push('12345');
  queue.push('12345');

  assert.throws(() => queue.push('1'), /realtime_pending_queue_overflow/);
});

test('pending realtime queue flushes in order and resets byte usage', () => {
  const queue = createPendingRealtimeQueue({ maxMessages: 4, maxBytes: 20 });
  const sent = [];

  queue.push('a');
  queue.push('bb');
  queue.flush((value) => sent.push(value));
  queue.push('ccc');

  assert.deepEqual(sent, ['a', 'bb']);
  assert.equal(queue.size, 1);
  assert.equal(queue.bytes, 3);
});

test('realtime sender stops after pending queue overflow', () => {
  const sentClient = [];
  const closed = [];
  const upstream = {
    OPEN: 1,
    readyState: 0,
    send: () => assert.fail('upstream must not receive queued overflow payloads')
  };
  const pending = createPendingRealtimeQueue({ maxMessages: 1, maxBytes: 1024 });
  const sendUpstream = createRealtimeSender({
    upstream,
    pending,
    isUpstreamReady: () => false,
    sendClient: (payload) => sentClient.push(payload),
    closeBoth: () => closed.push(true)
  });

  assert.equal(sendUpstream({ type: 'input_audio_buffer.append', audio: '1234' }), true);
  assert.equal(sendUpstream({ type: 'response.create' }), false);

  assert.deepEqual(sentClient, [
    { type: 'voice.realtime.error', error: 'realtime_pending_queue_overflow' }
  ]);
  assert.deepEqual(closed, [true]);
  assert.equal(pending.size, 1);
});

test('realtime client frame byte length counts binary and chunked payloads', () => {
  assert.equal(realtimeClientFrameByteLength('中文'), Buffer.byteLength('中文'));
  assert.equal(realtimeClientFrameByteLength(Buffer.from('abc')), 3);
  assert.equal(realtimeClientFrameByteLength([Buffer.from('ab'), Buffer.from('cd')]), 4);
});

test('realtime handoff does not mark response active when send fails', () => {
  const sentClient = [];
  let responseActive = false;
  const handoff = createRealtimeHandoffController({
    provider: 'openai',
    sendClient: (payload) => sentClient.push(payload),
    sendUpstream: () => false,
    getResponseActive: () => responseActive,
    setResponseActive: (value) => {
      responseActive = value;
    }
  });

  handoff.request(['整理这个任务']);

  assert.equal(responseActive, false);
  assert.equal(sentClient.every((payload) => payload.type === 'voice.handoff.summarizing'), true);
});
