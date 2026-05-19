import { once } from 'node:events';
import WebSocket from 'ws';
import {
  baseUrl,
  fail,
  relayUrl,
  request,
  secret
} from './relay-smoke-env.mjs';
import {
  connectMac,
  nextBrowserEvent
} from './relay-smoke-support.mjs';

export async function verifyDifferentMacDoesNotReplaceActiveMac(mac) {
  await expectMissingConnectorIdRejected();
  await expectDifferentMacRejected();
  const status = await request('/api/status', { headers: { authorization: 'Bearer valid-token' } });
  if (status.data.macDeviceName !== 'test-mac' || status.data.metrics?.multiMacRejectedTotal !== 1) {
    fail('different Mac connector should be rejected without replacing active Mac', status);
  }
  const result = await request('/api/projects', { headers: { authorization: 'Bearer valid-token' } });
  if (result.response.status !== 200 || result.data.projects?.[0]?.id !== 'mac-project') {
    fail('active Mac should continue serving after different Mac rejection', result);
  }
  return mac;
}

export async function verifyIdleAndActiveHeartbeat(mac) {
  await new Promise((resolve) => setTimeout(resolve, 250));
  const idlePings = mac.messages.filter((message) => message.type === 'ping').length;
  if (idlePings !== 0) {
    fail('idle relay should not ping Mac at active heartbeat frequency', mac.messages);
  }

  const ws = new WebSocket(`${baseUrl.replace('http:', 'ws:')}/ws?token=valid-token`);
  await once(ws, 'open');
  await new Promise((resolve) => setTimeout(resolve, 250));
  const activePings = mac.messages.filter((message) => message.type === 'ping').length;
  ws.close();
  if (activePings < 1) {
    fail('relay should use active heartbeat while browser socket is connected', mac.messages);
  }
}

export async function verifyBrowserEvents(mac) {
  const ws = new WebSocket(`${baseUrl.replace('http:', 'ws:')}/ws?token=valid-token`);
  await once(ws, 'open');
  const statusPromise = nextBrowserEvent(ws, 'relay-status');
  const relayHello = mac.messages.find((message) => message.type === 'relay.hello');
  mac.ws.send(JSON.stringify({
    type: 'mac.status',
    macConnectionEpoch: relayHello.macConnectionEpoch,
    localStatus: { reachable: true, checkedAt: new Date().toISOString(), status: 200 }
  }));
  const relayStatus = await statusPromise;
  if (!relayStatus.macConnected || relayStatus.localStatus?.reachable !== true) {
    fail('browser ws should receive relay-status when Mac status changes', relayStatus);
  }
  const eventPromise = nextBrowserEvent(ws, 'status-update');
  const result = await request('/api/chat/send', {
    method: 'POST',
    headers: { authorization: 'Bearer valid-token' },
    body: { projectId: 'mac-project', message: 'hello' }
  });
  if (result.response.status !== 202 || !result.data.accepted) {
    fail('/api/chat/send should return 202', result);
  }
  const event = await eventPromise;
  if (event.status !== 'running') {
    fail('browser ws should receive forwarded Mac status-update event', event);
  }
  ws.close();
}

export async function verifyReconnectAndUnsupportedRoutes() {
  const delayedMac = await connectMac({ relayUrl, secret, reachable: true, delayProjects: true });
  const pending = request('/api/projects', { headers: { authorization: 'Bearer valid-token' } });
  await new Promise((resolve) => setTimeout(resolve, 100));
  const replacementMac = await connectMac({ relayUrl, secret, reachable: true });
  let result = await pending;
  if (result.response.status !== 502 || result.data.error !== 'mac_reconnected') {
    fail('old epoch pending request should fail on reconnect', result);
  }
  delayedMac.ws.close();
  replacementMac.ws.close();

  result = await request('/ws/realtime?token=valid-token');
  if (result.response.status !== 501 || result.data.error !== 'relay_realtime_http_upgrade_required') {
    fail('/ws/realtime HTTP fallback should require WebSocket upgrade', result);
  }
}

async function expectDifferentMacRejected() {
  const ws = new WebSocket(relayUrl, {
    headers: { authorization: `Bearer ${secret}` }
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error('timed out waiting for different Mac rejection'));
    }, 3000);
    ws.on('open', () => {
      ws.send(JSON.stringify({
        type: 'mac.hello',
        protocolVersion: 1,
        connectorInstanceId: 'other-mac',
        deviceName: 'other-mac',
        clientVersion: '0.1.0',
        localStatus: { reachable: true, checkedAt: new Date().toISOString() },
        capabilities: ['http', 'events']
      }));
    });
    ws.on('message', (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.type === 'relay.hello') {
        clearTimeout(timer);
        ws.close();
        reject(new Error('different Mac connector should not receive relay.hello'));
      }
    });
    ws.on('close', (code, reason) => {
      clearTimeout(timer);
      if (code === 4009 && String(reason) === 'ambiguous_mac_route') {
        resolve();
        return;
      }
      reject(new Error(`expected 4009 ambiguous_mac_route, got ${code}:${reason}`));
    });
    ws.on('error', reject);
  });
}

async function expectMissingConnectorIdRejected() {
  const ws = new WebSocket(relayUrl, {
    headers: { authorization: `Bearer ${secret}` }
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error('timed out waiting for missing connectorInstanceId rejection'));
    }, 3000);
    ws.on('open', () => {
      ws.send(JSON.stringify({
        type: 'mac.hello',
        protocolVersion: 1,
        connectorInstanceId: '',
        deviceName: 'missing-id-mac',
        clientVersion: '0.1.0',
        localStatus: { reachable: true, checkedAt: new Date().toISOString() },
        capabilities: ['http', 'events']
      }));
    });
    ws.on('message', (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.type === 'relay.hello') {
        clearTimeout(timer);
        ws.close();
        reject(new Error('missing connectorInstanceId should not receive relay.hello'));
      }
    });
    ws.on('close', (code, reason) => {
      clearTimeout(timer);
      if (code === 4002 && String(reason) === 'invalid_connector_instance_id') {
        resolve();
        return;
      }
      reject(new Error(`expected 4002 invalid_connector_instance_id, got ${code}:${reason}`));
    });
    ws.on('error', reject);
  });
}
