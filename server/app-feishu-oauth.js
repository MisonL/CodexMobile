import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { getLarkDocsStatus } from './lark-cli.js';
import { htmlEscape, sendHtml } from './http-utils.js';
import { FEISHU_APP_ID, FEISHU_APP_SECRET, FEISHU_AUTH_STATE, FEISHU_AUTH_STATE_MAX_AGE_MS, FEISHU_DOCS_HOME_URL, FEISHU_REDIRECT_URI, PORT, PUBLIC_URL } from './app-config.js';
import { remoteAddress } from './app-auth.js';

let feishuAuthState = { token: null, pendingStates: {} };

export async function loadFeishuAuthState() {
  try {
    const raw = await fs.readFile(FEISHU_AUTH_STATE, 'utf8');
    const parsed = JSON.parse(raw);
    feishuAuthState = {
      token: parsed?.token && typeof parsed.token === 'object' ? parsed.token : null,
      pendingStates: parsed?.pendingStates && typeof parsed.pendingStates === 'object' ? parsed.pendingStates : {}
    };
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.warn('[feishu] Failed to read auth state:', error.message);
    }
    feishuAuthState = { token: null, pendingStates: {} };
  }
}

export async function saveFeishuAuthState() {
  await fs.mkdir(path.dirname(FEISHU_AUTH_STATE), { recursive: true });
  await fs.writeFile(FEISHU_AUTH_STATE, JSON.stringify(feishuAuthState, null, 2), 'utf8');
}

export function cleanupFeishuPendingStates() {
  const now = Date.now();
  const nextStates = {};
  for (const [state, payload] of Object.entries(feishuAuthState.pendingStates || {})) {
    const createdAt = Number(payload?.createdAt || 0);
    if (createdAt && now - createdAt <= FEISHU_AUTH_STATE_MAX_AGE_MS) {
      nextStates[state] = payload;
    }
  }
  feishuAuthState.pendingStates = nextStates;
}

export function requestOrigin(req) {
  const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  const proto = forwardedProto || (req.socket.encrypted ? 'https' : 'http');
  const host = req.headers['x-forwarded-host'] || req.headers.host || `127.0.0.1:${PORT}`;
  return `${proto}://${String(host).split(',')[0].trim()}`;
}

export function feishuRedirectUri(req) {
  if (FEISHU_REDIRECT_URI) {
    return FEISHU_REDIRECT_URI;
  }
  const base = PUBLIC_URL || requestOrigin(req);
  return new URL('/api/feishu/auth/callback', base.endsWith('/') ? base : `${base}/`).toString();
}

export function feishuConfigured() {
  return Boolean(FEISHU_APP_ID && FEISHU_APP_SECRET);
}

export function feishuTokenValid() {
  const expiresAt = Number(feishuAuthState.token?.expiresAt || 0);
  return Boolean(feishuAuthState.token?.accessToken && expiresAt && expiresAt > Date.now() + 60_000);
}

export function feishuUserSummary() {
  const user = feishuAuthState.token?.user || {};
  const name = user.name || user.enName || user.email || user.enterpriseEmail || user.openId || '';
  return name ? {
    name,
    email: user.email || user.enterpriseEmail || '',
    openId: user.openId || ''
  } : null;
}

export async function publicDocsStatus(authenticated) {
  try {
    return await getLarkDocsStatus({ authenticated });
  } catch (error) {
    return {
      provider: 'feishu',
      integration: 'lark-cli',
      label: '飞书文档',
      configured: feishuConfigured(),
      connected: authenticated ? feishuTokenValid() : false,
      user: authenticated ? feishuUserSummary() : null,
      homeUrl: FEISHU_DOCS_HOME_URL,
      cliInstalled: false,
      skillsInstalled: false,
      capabilities: [],
      codexEnabled: false,
      error: error.message || 'lark-cli status failed'
    };
  }
}

export async function feishuJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      accept: 'application/json',
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...(options.headers || {})
    }
  });
  const text = await response.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text.slice(0, 1000) };
  }
  if (!response.ok || Number(data.code || 0) !== 0) {
    const error = new Error(data.msg || data.message || `Feishu API request failed: ${response.status}`);
    error.statusCode = response.status;
    error.response = data;
    throw error;
  }
  return data;
}

export async function getFeishuAppAccessToken() {
  if (!feishuConfigured()) {
    const error = new Error('Feishu app credentials are not configured');
    error.statusCode = 400;
    throw error;
  }
  const data = await feishuJson('https://open.feishu.cn/open-apis/auth/v3/app_access_token/internal', {
    method: 'POST',
    body: JSON.stringify({
      app_id: FEISHU_APP_ID,
      app_secret: FEISHU_APP_SECRET
    })
  });
  return data.app_access_token;
}

export async function exchangeFeishuCode(code) {
  const appAccessToken = await getFeishuAppAccessToken();
  const data = await feishuJson('https://open.feishu.cn/open-apis/authen/v1/access_token', {
    method: 'POST',
    headers: { authorization: `Bearer ${appAccessToken}` },
    body: JSON.stringify({
      grant_type: 'authorization_code',
      code
    })
  });
  const token = data.data || data;
  const now = Date.now();
  feishuAuthState.token = {
    accessToken: token.access_token,
    refreshToken: token.refresh_token || '',
    expiresAt: now + Math.max(0, Number(token.expires_in || 0)) * 1000,
    refreshExpiresAt: token.refresh_expires_in ? now + Number(token.refresh_expires_in) * 1000 : 0,
    user: {
      name: token.name || '',
      enName: token.en_name || '',
      email: token.email || '',
      enterpriseEmail: token.enterprise_email || '',
      openId: token.open_id || '',
      unionId: token.union_id || '',
      userId: token.user_id || '',
      tenantKey: token.tenant_key || ''
    },
    updatedAt: new Date().toISOString()
  };
  await saveFeishuAuthState();
  return feishuAuthState.token;
}

export async function handleFeishuCallback(req, res, url) {
  const code = String(url.searchParams.get('code') || '').trim();
  const state = String(url.searchParams.get('state') || '').trim();
  const error = String(url.searchParams.get('error') || '').trim();
  cleanupFeishuPendingStates();
  const pending = state ? feishuAuthState.pendingStates[state] : null;
  if (!pending) {
    sendHtml(res, 400, '<!doctype html><meta charset="utf-8"><p>飞书授权已过期，请回到 CodexMobile 重新连接。</p>');
    return;
  }
  delete feishuAuthState.pendingStates[state];
  await saveFeishuAuthState();
  if (error) {
    sendHtml(res, 400, `<!doctype html><meta charset="utf-8"><p>飞书授权失败：${htmlEscape(error)}</p>`);
    return;
  }
  if (!code) {
    sendHtml(res, 400, '<!doctype html><meta charset="utf-8"><p>飞书授权失败：没有收到授权码。</p>');
    return;
  }
  try {
    await exchangeFeishuCode(code);
    const backUrl = new URL('/', pending.redirectUri).toString();
    res.writeHead(302, { location: `${backUrl}?feishu=connected` });
    res.end();
  } catch (callbackError) {
    console.warn(`[feishu] OAuth callback failed remote=${remoteAddress(req)} message=${callbackError.message}`);
    sendHtml(res, 502, `<!doctype html><meta charset="utf-8"><p>飞书授权失败：${htmlEscape(callbackError.message)}</p>`);
  }
}

export async function startFeishuBrowserAuth(req) {
  if (!feishuConfigured()) {
    const error = new Error('Feishu app credentials are not configured');
    error.statusCode = 400;
    throw error;
  }
  cleanupFeishuPendingStates();
  const state = crypto.randomBytes(24).toString('base64url');
  const redirectUri = feishuRedirectUri(req);
  feishuAuthState.pendingStates[state] = { createdAt: Date.now(), redirectUri };
  await saveFeishuAuthState();
  const authUrl = new URL('https://open.feishu.cn/open-apis/authen/v1/index');
  authUrl.searchParams.set('app_id', FEISHU_APP_ID);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('state', state);
  return { url: authUrl.toString(), redirectUri };
}

export async function logoutFeishuBrowserAuth() {
  feishuAuthState.token = null;
  await saveFeishuAuthState();
}
