import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  copyCodexRuntime,
  sleep,
  startProcess
} from './relay-real-chat-smoke-utils.mjs';

const CLEANUP_GRACE_MS = 800;

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

function startSmokeChild({ children, command, args, env, logPath, rootDir }) {
  const child = startProcess({ command, args, cwd: rootDir, logPath, env });
  children.push(child);
  return { child, logPath };
}

function createRuntimeStarters({ children, codexHome, connectorId, localPort, macUrl, mobileHome, relaySecret, rootDir }) {
  return {
    startLocalServer() {
      return startSmokeChild({
        children,
        command: 'npm',
        args: ['start'],
        rootDir,
        logPath: path.join(mobileHome, 'server.log'),
        env: {
          HOST: '127.0.0.1',
          PORT: String(localPort),
          CODEX_HOME: codexHome,
          CODEXMOBILE_HOME: mobileHome
        }
      });
    },
    startConnector(logName) {
      return startSmokeChild({
        children,
        command: 'npm',
        args: ['run', 'relay:mac'],
        rootDir,
        logPath: path.join(mobileHome, logName),
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
    }
  };
}

export async function createSmokeRuntime({ connectorId, localPort, macUrl, relaySecret, rootDir }) {
  const codexHome = await fs.mkdtemp(path.join(os.tmpdir(), 'codexmobile-real-chat-codehome.'));
  const mobileHome = await fs.mkdtemp(path.join(os.tmpdir(), 'codexmobile-real-chat-mobilehome.'));
  const children = [];

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
    ...createRuntimeStarters({ children, codexHome, connectorId, localPort, macUrl, mobileHome, relaySecret, rootDir }),
    async cleanup({ keepLogs = false } = {}) {
      await terminateSmokeChildren(children);
      await fs.rm(codexHome, { recursive: true, force: true });
      if (!keepLogs) {
        await fs.rm(mobileHome, { recursive: true, force: true });
      }
    }
  };
}
