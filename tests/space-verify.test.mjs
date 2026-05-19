import assert from 'node:assert/strict';
import test from 'node:test';

import {
  normalizeSpaceBaseUrl,
  verifySpace
} from '../scripts/verify-hf-space.mjs';
import {
  detailFor,
  startSpaceFixture,
  statusFor
} from './space-verify-fixture.mjs';

test('normalizeSpaceBaseUrl accepts Space HTTP URLs and Mac relay WebSocket URLs', () => {
  assert.equal(normalizeSpaceBaseUrl('https://example.hf.space/'), 'https://example.hf.space');
  assert.equal(normalizeSpaceBaseUrl('wss://example.hf.space/relay/mac'), 'https://example.hf.space');
  assert.equal(normalizeSpaceBaseUrl('ws://127.0.0.1:7860/relay/mac'), 'http://127.0.0.1:7860');
});

test('verifySpace performs public read-only checks without a browser token', async () => {
  const fixture = await startSpaceFixture();
  try {
    const report = await verifySpace({ spaceUrl: fixture.url, timeoutMs: 1000 });
    assert.equal(report.ok, true);
    assert.equal(statusFor(report, 'pwa'), 'passed');
    assert.equal(statusFor(report, 'status'), 'passed');
    assert.equal(statusFor(report, 'realtimeHttpFallback'), 'passed');
    assert.equal(statusFor(report, 'unauthenticatedProjects'), 'passed');
    assert.equal(statusFor(report, 'authenticatedProjects'), 'skipped');
  } finally {
    await fixture.close();
  }
});

test('verifySpace allows safe relay secret metadata without exposing secret values', async () => {
  const fixture = await startSpaceFixture({ exposeSecretMetadata: true });
  try {
    const report = await verifySpace({ spaceUrl: fixture.url, timeoutMs: 1000 });
    assert.equal(report.ok, true);
    assert.equal(statusFor(report, 'status'), 'passed');
  } finally {
    await fixture.close();
  }
});

test('verifySpace rejects status responses that expose actual secret values', async () => {
  const fixture = await startSpaceFixture({ exposeSecretValue: true });
  try {
    const report = await verifySpace({ spaceUrl: fixture.url, timeoutMs: 1000 });
    assert.equal(report.ok, false);
    assert.equal(statusFor(report, 'status'), 'failed');
    assert.match(detailFor(report, 'status'), /secret/i);
  } finally {
    await fixture.close();
  }
});

test('verifySpace fails when Space serves fallback text instead of the built PWA', async () => {
  const fixture = await startSpaceFixture({ fallbackPwa: true });
  try {
    const report = await verifySpace({ spaceUrl: fixture.url, timeoutMs: 1000 });
    assert.equal(report.ok, false);
    assert.equal(statusFor(report, 'pwa'), 'failed');
    assert.match(detailFor(report, 'pwa'), /fallback/i);
  } finally {
    await fixture.close();
  }
});

test('verifySpace can pair, verify browser websocket, and send chat when explicitly requested', async () => {
  const fixture = await startSpaceFixture({ authenticated: true });
  try {
    const report = await verifySpace({
      spaceUrl: fixture.url,
      pairCode: '123456',
      chatMessage: 'verification',
      checkRealtime: true,
      timeoutMs: 1000,
      requireMac: true
    });
    assert.equal(report.ok, true);
    assert.equal(statusFor(report, 'pair'), 'passed');
    assert.equal(statusFor(report, 'authenticatedProjects'), 'passed');
    assert.equal(statusFor(report, 'browserWebSocket'), 'passed');
    assert.equal(statusFor(report, 'realtimeWebSocket'), 'passed');
    assert.equal(statusFor(report, 'chatSend'), 'passed');
  } finally {
    await fixture.close();
  }
});

test('verifySpace does not open realtime websocket unless explicitly requested', async () => {
  const fixture = await startSpaceFixture({ authenticated: true });
  try {
    const report = await verifySpace({
      spaceUrl: fixture.url,
      token: 'valid-token',
      timeoutMs: 1000
    });
    assert.equal(report.ok, true);
    assert.equal(statusFor(report, 'realtimeWebSocket'), 'skipped');
    assert.equal(fixture.realtimeConnections(), 0);
  } finally {
    await fixture.close();
  }
});

test('verifySpace distinguishes realtime tunnel errors from strict provider readiness', async () => {
  const fixture = await startSpaceFixture({
    authenticated: true,
    realtimeEvent: { type: 'voice.realtime.error', error: 'fixture_provider_error' }
  });
  try {
    const relaxed = await verifySpace({
      spaceUrl: fixture.url,
      token: 'valid-token',
      checkRealtime: true,
      timeoutMs: 1000
    });
    assert.equal(relaxed.ok, true);
    assert.equal(statusFor(relaxed, 'realtimeWebSocket'), 'passed');
    assert.match(detailFor(relaxed, 'realtimeWebSocket'), /fixture_provider_error/);

    const strict = await verifySpace({
      spaceUrl: fixture.url,
      token: 'valid-token',
      timeoutMs: 1000,
      requireRealtimeReady: true
    });
    assert.equal(strict.ok, false);
    assert.equal(statusFor(strict, 'realtimeWebSocket'), 'failed');
    assert.match(detailFor(strict, 'realtimeWebSocket'), /voice\.realtime\.error/);
  } finally {
    await fixture.close();
  }
});

test('verifySpace fails realtime tunnel check when Mac availability is missing', async () => {
  const fixture = await startSpaceFixture({
    authenticated: true,
    realtimeEvent: { type: 'voice.realtime.error', error: 'mac_offline' }
  });
  try {
    const report = await verifySpace({
      spaceUrl: fixture.url,
      token: 'valid-token',
      checkRealtime: true,
      timeoutMs: 1000
    });
    assert.equal(report.ok, false);
    assert.equal(statusFor(report, 'realtimeWebSocket'), 'failed');
    assert.match(detailFor(report, 'realtimeWebSocket'), /mac_offline/);
  } finally {
    await fixture.close();
  }
});

test('verifySpace reports realtime websocket close before matching event', async () => {
  const fixture = await startSpaceFixture({
    authenticated: true,
    realtimeClose: { code: 1011, reason: 'local_realtime_rejected' }
  });
  try {
    const report = await verifySpace({
      spaceUrl: fixture.url,
      token: 'valid-token',
      checkRealtime: true,
      timeoutMs: 100
    });
    assert.equal(report.ok, false);
    assert.equal(statusFor(report, 'realtimeWebSocket'), 'failed');
    assert.match(detailFor(report, 'realtimeWebSocket'), /closed before matching event/);
    assert.match(detailFor(report, 'realtimeWebSocket'), /1011/);
    assert.match(detailFor(report, 'realtimeWebSocket'), /local_realtime_rejected/);
  } finally {
    await fixture.close();
  }
});

test('verifySpace accepts realtime event when server closes immediately after sending it', async () => {
  const fixture = await startSpaceFixture({
    authenticated: true,
    closeAfterRealtimeEvent: true
  });
  try {
    const report = await verifySpace({
      spaceUrl: fixture.url,
      token: 'valid-token',
      checkRealtime: true,
      timeoutMs: 1000
    });
    assert.equal(report.ok, true);
    assert.equal(statusFor(report, 'realtimeWebSocket'), 'passed');
  } finally {
    await fixture.close();
  }
});
