import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import WebSocket from 'ws';
import {
  copyCodexRuntime,
  defaultRelayBaseUrl,
  freePort,
  relayUrls,
  requestJson,
  resetDefaultDockerRelay,
  sanitizeEvent,
  sleep,
  startProcess,
  waitFor
} from './relay-real-chat-smoke-utils.mjs';

const ROOT_DIR = path.resolve(import.meta.dirname, '..');
const DEFAULT_RELAY_SECRET = 'local-test-secret-12345678901234567890';
const EXPECTED_REPLY = process.env.CODEXMOBILE_REAL_CHAT_EXPECT || 'CodexMobile真实链路OK';
const CHAT_MESSAGE = process.env.CODEXMOBILE_REAL_CHAT_MESSAGE ||
  `这是 CodexMobile 本地 Docker relay 真实链路 smoke test。请只回复：${EXPECTED_REPLY}`;
const TIMEOUT_MS = Number(process.env.CODEXMOBILE_REAL_CHAT_TIMEOUT_MS || 180000);
const CLEANUP_GRACE_MS = 800;
const WS_OPEN_TIMEOUT_MS = 10000;
const TERMINAL_EVENT_TIMEOUT_MS = 30000;

function isChildStillRunning(child) {
  return child?.exitCode === null && child?.signalCode === null;
}

export async function terminateSmokeChildren(children, { graceMs = CLEANUP_GRACE_MS, sleepFn = sleep } = {}) {
  for (const child of [...children].reverse()) {
    if (isChildStillRunning(child)) {
      child.kill('SIGTERM');
    }
  }
  await sleepFn(graceMs);
  for (const child of children) {
    if (isChildStillRunning(child)) {
      child.kill('SIGKILL');
    }
  }
}

export function resolveRelaySecret({ baseUrl, env = process.env } = {}) {
  const configured = String(env.CODEXMOBILE_RELAY_SECRET || '').trim();
  if (configured) {
    return configured;
  }
  if (baseUrl === defaultRelayBaseUrl()) {
    return DEFAULT_RELAY_SECRET;
  }
  throw new Error('CODEXMOBILE_RELAY_SECRET is required when CODEXMOBILE_RELAY_BASE_URL is not the default local relay.');
}

export async function createSmokeRuntime({ macUrl, relaySecret, localPort, connectorId }) {
  const codexHome = await fs.mkdtemp(path.join(os.tmpdir(), 'codexmobile-real-chat-codehome.'));
  const mobileHome = await fs.mkdtemp(path.join(os.tmpdir(), 'codexmobile-real-chat-mobilehome.'));
  const children = [];

  const startLocalServer = () => {
    const logPath = path.join(mobileHome, 'server.log');
    const child = startProcess({
      command: 'npm',
      args: ['start'],
      cwd: ROOT_DIR,
      logPath,
      env: {
        HOST: '127.0.0.1',
        PORT: String(localPort),
        CODEX_HOME: codexHome,
        CODEXMOBILE_HOME: mobileHome
      }
    });
    children.push(child);
    return { child, logPath };
  };

  const startConnector = (logName) => {
    const logPath = path.join(mobileHome, logName);
    const child = startProcess({
      command: 'npm',
      args: ['run', 'relay:mac'],
      cwd: ROOT_DIR,
      logPath,
      env: {
        CODEX_HOME: codexHome,
        CODEXMOBILE_HOME: mobileHome,
        CODEXMOBILE_RELAY_URL: macUrl,
        CODEXMOBILE_RELAY_SECRET: relaySecret,
        CODEXMOBILE_RELAY_LOCAL_URL: `http://127.0.0.1:${localPort}`,
        CODEXMOBILE_RELAY_DEVICE_NAME: 'real-chat-smoke',
        CODEXMOBILE_RELAY_CONNECTOR_ID: connectorId,
        CODEXMOBILE_RELAY_KEEPALIVE_MS: '0'
      }
    });
    children.push(child);
    return { child, logPath };
  };

  const cleanup = async ({ keepLogs = false } = {}) => {
    await terminateSmokeChildren(children);
    await fs.rm(codexHome, { recursive: true, force: true });
    if (!keepLogs) {
      await fs.rm(mobileHome, { recursive: true, force: true });
    }
  };

  try {
    await copyCodexRuntime(codexHome);
  } catch (error) {
    await Promise.all([
      fs.rm(codexHome, { recursive: true, force: true }),
      fs.rm(mobileHome, { recursive: true, force: true })
    ]);
    throw error;
  }
  return {
    codexHome,
    mobileHome,
    startLocalServer,
    startConnector,
    cleanup
  };
}

async function connectLocalMac({ baseUrl, runtime }) {
  const server = runtime.startLocalServer();
  const pairCode = await waitFor(async () => {
    const log = await fs.readFile(server.logPath, 'utf8').catch(() => '');
    return log.match(/Pairing code: (\d{6})/)?.[1] || '';
  }, 'local server pairing code');

  const connector = runtime.startConnector('connector.log');
  const connected = await waitFor(async () => {
    const { data } = await requestJson(`${baseUrl}/api/status`);
    return data.macConnected ? data : null;
  }, 'docker relay macConnected');

  return { connected, connector, pairCode };
}

async function performPairing({ baseUrl, pairCode }) {
  const pair = await requestJson(`${baseUrl}/api/pair`, {
    method: 'POST',
    body: JSON.stringify({ code: pairCode, deviceName: 'real-chat-smoke-browser' })
  });
  if (!pair.response.ok || !pair.data.token) {
    throw new Error(`pair failed status=${pair.response.status}`);
  }
  const { token } = pair.data;

  const projects = await requestJson(`${baseUrl}/api/projects`, {
    headers: { authorization: `Bearer ${token}` }
  });
  const project = projects.data.projects?.find((item) => item.path === ROOT_DIR) || projects.data.projects?.[0];
  if (!project?.id) {
    throw new Error(`missing project after pair status=${projects.response.status}`);
  }

  return { project, token };
}

async function openBrowserSocket({ browserWsBase, token, events }) {
  const ws = new WebSocket(`${browserWsBase}/ws?token=${encodeURIComponent(token)}`);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('browser ws open timed out')), WS_OPEN_TIMEOUT_MS);
    ws.once('open', () => {
      clearTimeout(timer);
      resolve();
    });
    ws.once('error', reject);
  });
  ws.on('message', (raw) => {
    try {
      events.push(JSON.parse(raw.toString()));
    } catch {
      // Ignore malformed frames; relay JSON events are asserted below.
    }
  });
  return ws;
}

async function runChatTest({ baseUrl, browserWsBase, project, token }) {
  const events = [];
  const ws = await openBrowserSocket({ browserWsBase, token, events });
  const chat = await requestJson(`${baseUrl}/api/chat/send`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify({
      projectId: project.id,
      message: CHAT_MESSAGE,
      model: process.env.CODEXMOBILE_REAL_CHAT_MODEL || 'gpt-5.5',
      reasoningEffort: process.env.CODEXMOBILE_REAL_CHAT_REASONING || 'minimal',
      permissionMode: 'default'
    })
  });
  if (chat.response.status !== 202) {
    throw new Error(`chat send failed status=${chat.response.status}`);
  }

  const assistant = await waitFor(async () => events.find(
    (event) => event.type === 'assistant-update' && String(event.content || '').includes(EXPECTED_REPLY)
  ), 'assistant text echo', TIMEOUT_MS);
  const terminal = await waitFor(async () => events.find(
    (event) => event.type === 'chat-complete' || event.type === 'chat-error'
  ), 'terminal chat websocket event', TERMINAL_EVENT_TIMEOUT_MS);
  ws.close();

  return { assistant, chat, events, terminal };
}

async function testReconnection({ baseUrl, connector, runtime, token }) {
  const authHeaders = { authorization: `Bearer ${token}` };
  const beforeDisconnect = await requestJson(`${baseUrl}/api/status`, { headers: authHeaders });
  connector.child.kill('SIGTERM');
  const disconnected = await waitFor(async () => {
    const { data } = await requestJson(`${baseUrl}/api/status`, { headers: authHeaders });
    return data.macConnected === false ? data : null;
  }, 'mac disconnected after connector stop');
  runtime.startConnector('connector-reconnect.log');
  const afterReconnect = await waitFor(async () => {
    const { data } = await requestJson(`${baseUrl}/api/status`, { headers: authHeaders });
    return data.macConnected ? data : null;
  }, 'mac reconnected after connector restart');
  const projectsAfterReconnect = await requestJson(`${baseUrl}/api/projects`, { headers: authHeaders });

  return { afterReconnect, beforeDisconnect, disconnected, projectsAfterReconnect };
}

function buildReport({ baseUrl, chatResult, connected, connectorId, pairing, reconnection, relayReset, runtime }) {
  return {
    ok: chatResult.terminal.type === 'chat-complete',
    relay: { baseUrl, connectorId, reset: relayReset },
    connected: {
      macConnected: connected.macConnected,
      macDeviceName: connected.macDeviceName,
      macConnectionEpoch: connected.macConnectionEpoch
    },
    project: { id: pairing.project.id, name: pairing.project.name, path: pairing.project.path },
    chatAccepted: chatResult.chat.data,
    assistantEcho: sanitizeEvent(chatResult.assistant),
    terminal: sanitizeEvent(chatResult.terminal),
    eventTypes: [...new Set(chatResult.events.map((event) => event.type))],
    beforeDisconnect: {
      macConnected: reconnection.beforeDisconnect.data.macConnected,
      macConnectionEpoch: reconnection.beforeDisconnect.data.macConnectionEpoch
    },
    disconnected: {
      macConnected: reconnection.disconnected.macConnected,
      macConnectionEpoch: reconnection.disconnected.macConnectionEpoch
    },
    afterReconnect: {
      macConnected: reconnection.afterReconnect.macConnected,
      macConnectionEpoch: reconnection.afterReconnect.macConnectionEpoch
    },
    projectsAfterReconnect: {
      status: reconnection.projectsAfterReconnect.response.status,
      count: reconnection.projectsAfterReconnect.data.projects?.length ?? null
    },
    logDir: runtime.mobileHome
  };
}

async function main() {
  const { baseUrl, macUrl, browserWsBase } = relayUrls();
  const relaySecret = resolveRelaySecret({ baseUrl });
  const relayReset = await resetDefaultDockerRelay(baseUrl);
  const localPort = Number(process.env.CODEXMOBILE_REAL_CHAT_LOCAL_PORT || await freePort());
  const connectorId = process.env.CODEXMOBILE_RELAY_CONNECTOR_ID || 'real-chat-smoke';
  const runtime = await createSmokeRuntime({ macUrl, relaySecret, localPort, connectorId });
  let keepLogs = false;

  try {
    const mac = await connectLocalMac({ baseUrl, runtime });
    const pairing = await performPairing({ baseUrl, pairCode: mac.pairCode });
    const chatResult = await runChatTest({
      baseUrl,
      browserWsBase,
      project: pairing.project,
      token: pairing.token
    });
    const reconnection = await testReconnection({
      baseUrl,
      connector: mac.connector,
      runtime,
      token: pairing.token
    });
    const report = buildReport({
      baseUrl,
      chatResult,
      connected: mac.connected,
      connectorId,
      pairing,
      reconnection,
      relayReset,
      runtime
    });
    console.log(JSON.stringify(report, null, 2));
    if (!report.ok) {
      process.exitCode = 1;
    }
  } catch (error) {
    keepLogs = true;
    const detail = String(error.message || error);
    console.error(JSON.stringify({
      ok: false,
      error: detail,
      hint: detail.includes('macConnected timed out')
        ? 'Restart the relay container or reuse the pinned connector id if relay logs show ambiguous_mac_route.'
        : '',
      codexHome: runtime.codexHome,
      logDir: runtime.mobileHome
    }, null, 2));
    process.exitCode = 1;
  } finally {
    await runtime.cleanup({ keepLogs });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  await main();
}
