import fs from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import { WebSocketServer } from 'ws';
import {
  getPairingCode,
  getTrustedDeviceCount,
  initializeAuth,
  verifyToken
} from './auth.js';
import { refreshCodexCache, refreshProjectCache } from './codex-data.js';
import { sendJson } from './http-utils.js';
import { startVoiceRealtimeProxy } from './realtime-voice.js';
import { handleApi } from './api-router.js';
import {
  HOST,
  HTTPS_PFX_PASSPHRASE,
  HTTPS_PFX_PATH,
  HTTPS_PORT,
  PORT,
  PUBLIC_URL
} from './app-config.js';
import { remoteAddress } from './app-auth.js';
import { loadFeishuAuthState } from './app-feishu-oauth.js';
import { loadRecentImagePrompts } from './app-image-prompts.js';
import { addBrowserSocket, broadcast } from './app-sockets.js';
import { publicStatus } from './app-status.js';
import { serveStatic } from './app-static.js';

async function requestHandler(req, res) {
  const url = new URL(req.url || '/', `http://${req.headers.host || `127.0.0.1:${PORT}`}`);
  try {
    if (url.pathname.startsWith('/api/')) {
      await handleApi(req, res, url);
      return;
    }
    await serveStatic(req, res, url);
  } catch (error) {
    console.error('[server] Request failed:', error);
    sendJson(res, 500, { error: error.message || 'Internal server error' });
  }
}

function createUpgradeHandler(wss, realtimeWss) {
  return async (req, socket, head) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || `127.0.0.1:${PORT}`}`);
    if (url.pathname !== '/ws' && url.pathname !== '/ws/realtime') {
      socket.destroy();
      return;
    }

    const token = url.searchParams.get('token') || '';
    const ok = await verifyToken(token, { remoteAddress: remoteAddress(req) });
    if (!ok) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    if (url.pathname === '/ws/realtime') {
      realtimeWss.handleUpgrade(req, socket, head, (ws) => {
        startVoiceRealtimeProxy(ws, { remoteAddress: remoteAddress(req) });
      });
      return;
    }

    wss.handleUpgrade(req, socket, head, async (ws) => {
      addBrowserSocket(ws);
      ws.send(JSON.stringify({ type: 'connected', status: await publicStatus(true) }));
    });
  };
}

async function startHttpServer(handleUpgrade) {
  const auth = await initializeAuth();
  await refreshProjectCache().catch((error) => console.warn('[sync] Initial project refresh failed:', error.message));
  const server = http.createServer(requestHandler);
  server.on('upgrade', handleUpgrade);
  server.listen(PORT, HOST, () => {
    console.log(`CodexMobile listening on http://${HOST}:${PORT}`);
    console.log(`Pairing code: ${getPairingCode()} (${getTrustedDeviceCount()} trusted device(s)${auth.fixedPairingCode ? ', fixed' : ''})`);
    console.log('Use Tailscale and open http://<this-pc-tailscale-ip>:3321 on iPhone.');
    refreshCodexCache()
      .then((snapshot) => broadcast({ type: 'sync-complete', syncedAt: snapshot.syncedAt, projects: snapshot.projects }))
      .catch((error) => console.warn('[sync] Initial cache refresh failed:', error.message));
  });
}

async function startHttpsServer(handleUpgrade) {
  try {
    const pfx = await fs.readFile(HTTPS_PFX_PATH);
    const httpsServer = https.createServer({ pfx, passphrase: HTTPS_PFX_PASSPHRASE }, requestHandler);
    httpsServer.on('upgrade', handleUpgrade);
    httpsServer.listen(HTTPS_PORT, HOST, () => {
      console.log(`CodexMobile HTTPS listening on https://${HOST}:${HTTPS_PORT}`);
      if (PUBLIC_URL) {
        console.log(`Public/private URL: ${PUBLIC_URL}`);
      } else {
        console.log(`Use Tailscale HTTPS: https://<your-device>.<your-tailnet>.ts.net:${HTTPS_PORT}/`);
      }
    });
  } catch (error) {
    if (error.code === 'ENOENT') {
      console.log(`CodexMobile HTTPS disabled: certificate not found at ${HTTPS_PFX_PATH}`);
    } else {
      console.warn(`[server] Failed to start HTTPS listener: ${error.message}`);
    }
  }
}

async function main() {
  await loadFeishuAuthState();
  await loadRecentImagePrompts();
  const handleUpgrade = createUpgradeHandler(
    new WebSocketServer({ noServer: true }),
    new WebSocketServer({ noServer: true })
  );
  await startHttpServer(handleUpgrade);
  await startHttpsServer(handleUpgrade);
}

main().catch((error) => {
  console.error('[server] Failed to start:', error);
  process.exitCode = 1;
});
