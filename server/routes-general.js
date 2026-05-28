import { getCodexQuota } from './codex-quota.js';
import { listProjects, refreshCodexCache, refreshProjectCache } from './codex-data.js';
import { sendJson } from './http-utils.js';
import { broadcast } from './app-sockets.js';
import { remoteAddress } from './app-auth.js';

export function createGeneralRouteHandler({
  getQuota = getCodexQuota,
  list = listProjects,
  refreshCodex = refreshCodexCache,
  refreshProjects = refreshProjectCache,
  publish = broadcast
} = {}) {
  return async function handleGeneralRouteWithDeps(req, res, { method, pathname }) {
    if (method === 'POST' && pathname === '/api/sync') {
      const snapshot = await refreshCodex();
      publish({ type: 'sync-complete', syncedAt: snapshot.syncedAt, projects: snapshot.projects });
      sendJson(res, 200, { success: true, ...snapshot });
      return true;
    }

    if (method === 'GET' && pathname === '/api/projects') {
      let projects = list();
      if (!projects.length) {
        try {
          projects = (await refreshProjects()).projects;
        } catch (error) {
          console.warn(`[projects] refresh failed remote=${remoteAddress(req)} message=${error.message || 'unknown'}`);
          sendJson(res, 500, { error: 'Failed to refresh project cache' });
          return true;
        }
      }
      sendJson(res, 200, { projects });
      return true;
    }

    if (method === 'GET' && pathname === '/api/quotas/codex') {
      try {
        sendJson(res, 200, await getQuota());
      } catch (error) {
        console.warn(`[quota] codex quota failed remote=${remoteAddress(req)} message=${error.message || 'unknown'}`);
        sendJson(res, 500, { error: 'Failed to query Codex quota' });
      }
      return true;
    }

    return false;
  };
}

const defaultGeneralRouteHandler = createGeneralRouteHandler();

export async function handleGeneralRoute(req, res, { method, pathname }) {
  return defaultGeneralRouteHandler(req, res, { method, pathname });
}
