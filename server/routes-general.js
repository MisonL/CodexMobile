import { getCodexQuota } from './codex-quota.js';
import { listProjects, refreshCodexCache } from './codex-data.js';
import { sendJson } from './http-utils.js';
import { broadcast } from './app-sockets.js';
import { remoteAddress } from './app-auth.js';

export async function handleGeneralRoute(req, res, { method, pathname }) {
  if (method === 'POST' && pathname === '/api/sync') {
    const snapshot = await refreshCodexCache();
    broadcast({ type: 'sync-complete', syncedAt: snapshot.syncedAt, projects: snapshot.projects });
    sendJson(res, 200, { success: true, ...snapshot });
    return true;
  }

  if (method === 'GET' && pathname === '/api/projects') {
    sendJson(res, 200, { projects: listProjects() });
    return true;
  }

  if (method === 'GET' && pathname === '/api/quotas/codex') {
    try {
      sendJson(res, 200, await getCodexQuota());
    } catch (error) {
      console.warn(`[quota] codex quota failed remote=${remoteAddress(req)} message=${error.message || 'unknown'}`);
      sendJson(res, 500, { error: 'Failed to query Codex quota' });
    }
    return true;
  }

  return false;
}
