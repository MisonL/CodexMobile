import {
  fail,
  previousSecret,
  relayUrl,
  request,
  secret
} from './relay-smoke-env.mjs';
import {
  connectMac,
  expectRejectedMacSecret
} from './relay-smoke-support.mjs';

export async function verifyRelayStartup() {
  await expectRejectedMacSecret(relayUrl);

  let result = await request('/api/projects');
  result = await request('/api/status');
  if (
    result.response.status !== 200 ||
    result.data.mode !== 'relay' ||
    result.data.relayState !== 'pairing_required' ||
    result.data.macConnected !== false ||
    result.data.limits?.pendingRequestsMax !== 2 ||
    result.data.limits?.browserPendingRequestsMax !== 1 ||
    result.data.limits?.requestBodyMaxBytes !== 1024 ||
    result.data.limits?.heartbeatMs !== 100 ||
    result.data.limits?.idleHeartbeatMs !== 500
  ) {
    fail('/api/status should expose relay mode before Mac connects', result);
  }

  result = await request('/api/projects');
  if (result.response.status !== 401 || result.data.error !== 'pairing_required') {
    fail('unauthenticated API should return pairing_required', result);
  }

  result = await request('/api/projects', { headers: { authorization: 'Bearer valid-token' } });
  if (result.response.status !== 503 || result.data.error !== 'mac_offline') {
    fail('authenticated API without Mac should return mac_offline', result);
  }

  result = await request('/generated/test.png');
  if (result.response.status !== 401) {
    fail('unauthenticated generated asset should return 401', result);
  }

  result = await request('/api/feishu/auth/callback?code=test&state=test');
  if (result.response.status !== 501 || result.data.error !== 'relay_unsupported') {
    fail('Feishu OAuth callback should be explicitly unsupported in relay Phase 1', result);
  }
}

export async function verifyRelaySecretRotationGraceWindow() {
  const previousMac = await connectMac({ relayUrl, secret: previousSecret, reachable: true });
  previousMac.ws.close();
  await new Promise((resolve) => setTimeout(resolve, 100));

  const currentMac = await connectMac({ relayUrl, secret, reachable: true });
  const result = await request('/api/status', { headers: { authorization: 'Bearer valid-token' } });
  currentMac.ws.close();
  if (
    result.response.status !== 200 ||
    result.data.macConnected !== true ||
    result.data.secrets?.previousConfigured !== true ||
    Object.keys(result.data.secrets || {}).join(',') !== 'previousConfigured'
  ) {
    fail('relay should accept current and previous Mac secrets without exposing secret values', result);
  }
}

export async function verifyMacOfflineState() {
  const offlineMac = await connectMac({ relayUrl, secret, reachable: false });
  const result = await request('/api/projects', { headers: { authorization: 'Bearer valid-token' } });
  if (result.response.status !== 503 || result.data.error !== 'mac_local_offline') {
    fail('Mac connected with local offline should return mac_local_offline', result);
  }
  offlineMac.ws.close();
  await new Promise((resolve) => setTimeout(resolve, 100));
}

export async function verifyForwardedHttp(mac) {
  let result = await request('/api/pair', { method: 'POST', body: { code: '123456' } });
  if (result.response.status !== 200 || result.data.token !== 'valid-token') {
    fail('pair should be forwarded to Mac and return Mac token', result);
  }

  result = await request('/api/projects', { headers: { authorization: 'Bearer valid-token' } });
  if (result.response.status !== 200 || result.data.projects?.[0]?.id !== 'mac-project') {
    fail('/api/projects should be forwarded to Mac', result);
  }

  result = await request('/api/chat/send', {
    method: 'POST',
    headers: {
      authorization: 'Bearer valid-token',
      'content-type': 'application/json'
    },
    body: JSON.stringify({ message: 'x'.repeat(2048) })
  });
  if (result.response.status !== 413 || result.data.error !== 'relay_body_too_large') {
    fail('oversized relay body should return 413', result);
  }

  return mac;
}

export async function verifyCachedTokenBypassesValidationRateLimit(mac) {
  for (let index = 0; index < 64; index += 1) {
    const result = await request('/api/projects', { headers: { authorization: 'Bearer valid-token' } });
    if (result.response.status !== 200 || result.data.projects?.[0]?.id !== 'mac-project') {
      fail('cached valid token should not consume token validation miss limit', { index, result });
    }
  }
  return mac;
}

export async function verifyBrowserPendingLimit(mac) {
  mac.ws.close();
  await new Promise((resolve) => setTimeout(resolve, 100));
  const delayedMac = await connectMac({ relayUrl, secret, reachable: true, delayProjects: true });
  const first = request('/api/projects', { headers: { authorization: 'Bearer valid-token' } });
  await new Promise((resolve) => setTimeout(resolve, 100));
  const limited = await request('/api/projects', { headers: { authorization: 'Bearer valid-token' } });
  if (
    limited.response.status !== 429 ||
    limited.data.error !== 'relay_rate_limited' ||
    limited.data.reason !== 'relay_client_pending_limit_exceeded'
  ) {
    fail('same browser should be limited when pending request limit is reached', limited);
  }
  const result = await first;
  if (result.response.status !== 200 || result.data.projects?.[0]?.id !== 'mac-project') {
    fail('first pending request should still complete after pending limit rejection', result);
  }
  return delayedMac;
}

export async function verifyGlobalPendingLimit(mac) {
  mac.ws.close();
  await new Promise((resolve) => setTimeout(resolve, 100));
  const delayedMac = await connectMac({ relayUrl, secret, reachable: true, delayProjects: true });
  const first = request('/api/projects', { headers: { authorization: 'Bearer valid-token-a' } });
  const second = request('/api/projects', { headers: { authorization: 'Bearer valid-token-b' } });
  await new Promise((resolve) => setTimeout(resolve, 100));
  const limited = await request('/api/projects', { headers: { authorization: 'Bearer valid-token-c' } });
  if (
    limited.response.status !== 429 ||
    limited.data.error !== 'relay_rate_limited' ||
    limited.data.reason !== 'relay_pending_limit_exceeded'
  ) {
    fail('global pending request limit should reject extra relay requests', limited);
  }
  for (const result of await Promise.all([first, second])) {
    if (result.response.status !== 200 || result.data.projects?.[0]?.id !== 'mac-project') {
      fail('requests already admitted before global limit should still complete', result);
    }
  }
  return delayedMac;
}
