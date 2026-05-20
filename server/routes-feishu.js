import { logoutLarkCli, startLarkCliAuth } from './lark-cli.js';
import { readBody, sendJson } from './http-utils.js';
import { MAX_JSON_BYTES } from './app-config.js';
import {
  logoutFeishuBrowserAuth,
  publicDocsStatus,
  startFeishuBrowserAuth
} from './app-feishu-oauth.js';
import { remoteAddress } from './app-auth.js';

export async function handleFeishuRoute(req, res, { method, pathname }) {
  if (method === 'GET' && pathname === '/api/feishu/status') {
    sendJson(res, 200, await publicDocsStatus(true));
    return true;
  }

  if (method === 'POST' && pathname === '/api/feishu/cli/auth/start') {
    try {
      const auth = await startLarkCliAuth();
      sendJson(res, 200, { success: true, ...auth, docs: await publicDocsStatus(true) });
    } catch (error) {
      const statusCode = error.statusCode || 502;
      console.warn(`[lark-cli] auth start failed remote=${remoteAddress(req)} message=${error.message}`);
      sendJson(res, statusCode, { error: error.message || '飞书 CLI 授权失败' });
    }
    return true;
  }

  if (method === 'POST' && pathname === '/api/feishu/cli/auth/logout') {
    try {
      await logoutLarkCli();
      sendJson(res, 200, { success: true, docs: await publicDocsStatus(true) });
    } catch (error) {
      const statusCode = error.statusCode || 502;
      console.warn(`[lark-cli] auth logout failed remote=${remoteAddress(req)} message=${error.message}`);
      sendJson(res, statusCode, { error: error.message || '断开飞书 CLI 授权失败' });
    }
    return true;
  }

  if (method === 'POST' && pathname === '/api/feishu/auth/start') {
    try {
      sendJson(res, 200, await startFeishuBrowserAuth(req));
    } catch (error) {
      sendJson(res, error.statusCode || 500, { error: error.message || 'Feishu auth failed' });
    }
    return true;
  }

  if (method === 'POST' && pathname === '/api/feishu/auth/logout') {
    await readBody(req, MAX_JSON_BYTES).catch(() => ({}));
    await logoutFeishuBrowserAuth();
    sendJson(res, 200, { success: true, ...(await publicDocsStatus(true)) });
    return true;
  }

  return false;
}
