import { pairDevice } from './auth.js';
import { readBody, sendJson } from './http-utils.js';
import { MAX_JSON_BYTES } from './app-config.js';
import { isAuthenticated, requireAuth, remoteAddress } from './app-auth.js';
import { handleFeishuCallback } from './app-feishu-oauth.js';
import { publicStatus } from './app-status.js';
import { handleChatRoute } from './routes-chat.js';
import { handleFeishuRoute } from './routes-feishu.js';
import { handleGeneralRoute } from './routes-general.js';
import { handleMediaRoute } from './routes-media.js';
import { handleSessionRoute } from './routes-sessions.js';

export async function handleApi(req, res, url) {
  const method = req.method || 'GET';
  const pathname = url.pathname;
  const parts = pathname.split('/').filter(Boolean);

  if (method === 'GET' && pathname === '/api/status') {
    sendJson(res, 200, await publicStatus(await isAuthenticated(req)));
    return;
  }

  if (method === 'POST' && pathname === '/api/pair') {
    const body = await readBody(req, MAX_JSON_BYTES);
    const paired = await pairDevice({
      code: body.code,
      deviceName: body.deviceName,
      userAgent: req.headers['user-agent'],
      remoteAddress: remoteAddress(req)
    });
    sendJson(res, paired ? 200 : 403, paired || { error: 'Invalid pairing code' });
    return;
  }

  if (method === 'GET' && pathname === '/api/feishu/auth/callback') {
    await handleFeishuCallback(req, res, url);
    return;
  }

  if (!(await requireAuth(req, res, pathname))) {
    return;
  }

  for (const handler of [handleGeneralRoute, handleFeishuRoute, handleSessionRoute, handleMediaRoute, handleChatRoute]) {
    if (await handler(req, res, { method, pathname, url, parts })) {
      return;
    }
  }

  sendJson(res, 404, { error: 'Not found' });
}
