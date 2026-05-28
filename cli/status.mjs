import { execFile as defaultExecFile } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';

import { resolveRuntimePaths } from './paths.mjs';
import { collectManagedProcessStatus } from './process-manager.mjs';
import { getMacLaunchAgentStatus } from './launch-agent.mjs';
import { readRedactedRelayConfig } from './relay-config.mjs';

const MIN_NODE_VERSION = '20.19.0';
const DEFAULT_HTTP_PORT = 3321;
const DEFAULT_HTTPS_PORT = 3443;
const PORT_TIMEOUT_MS = 250;

function parseNodeVersion(version) {
  const [major, minor, patch] = String(version || '')
    .split(/[.-]/)
    .slice(0, 3)
    .map((part) => Number(part));
  return [major, minor, patch].map((part) => (Number.isFinite(part) ? part : 0));
}

function nodeMeetsMinimum(version, minimum = MIN_NODE_VERSION) {
  const current = parseNodeVersion(version);
  const required = parseNodeVersion(minimum);
  for (let index = 0; index < required.length; index += 1) {
    if (current[index] > required[index]) {
      return true;
    }
    if (current[index] < required[index]) {
      return false;
    }
  }
  return true;
}

async function pathExists(fileSystem, filePath) {
  try {
    await fileSystem.stat(filePath);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

function checkPort(port, socketFactory = net.createConnection) {
  return new Promise((resolve) => {
    const socket = socketFactory({ host: '127.0.0.1', port });
    let settled = false;
    const finish = (status, detail) => {
      if (settled) {
        return;
      }
      settled = true;
      socket.destroy();
      resolve({ port, status, detail });
    };
    socket.setTimeout(PORT_TIMEOUT_MS);
    socket.once('connect', () => finish('listening', '127.0.0.1 accepted a connection.'));
    socket.once('timeout', () => finish('unknown', 'port probe timed out.'));
    socket.once('error', (error) => {
      if (error.code === 'ECONNREFUSED') {
        finish('available', '127.0.0.1 refused a connection.');
        return;
      }
      finish('unknown', error.message);
    });
  });
}

function collectPrivateIps(networkInterfaces = os.networkInterfaces()) {
  const addresses = [];
  for (const entries of Object.values(networkInterfaces)) {
    for (const entry of entries || []) {
      if (entry.family === 'IPv4' && !entry.internal) {
        addresses.push(entry.address);
      }
    }
  }
  return addresses.sort();
}

function execFilePromise(execFile, command, args) {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: 500 }, (error, stdout) => {
      if (error) {
        resolve({ ok: false, detail: error.code || error.message });
        return;
      }
      resolve({ ok: true, detail: String(stdout || '').trim() });
    });
  });
}

async function checkTailscale(execFile) {
  const result = await execFilePromise(execFile, 'tailscale', ['ip', '-4']);
  if (!result.ok) {
    return { status: 'skipped', detail: result.detail };
  }
  return {
    status: result.detail ? 'passed' : 'warning',
    detail: result.detail || 'tailscale returned no IPv4 address.'
  };
}

export async function collectDoctorReport(options = {}) {
  const env = options.env || process.env;
  const paths = resolveRuntimePaths(options);
  const fileSystem = options.fs || fs;
  const execFile = options.execFile || defaultExecFile;
  const nodeVersion = options.nodeVersion || process.versions.node;
  const nodeOk = nodeMeetsMinimum(nodeVersion);
  const codexConfigExists = await pathExists(fileSystem, paths.codexConfigPath);
  const httpPort = Number(env.PORT || DEFAULT_HTTP_PORT);
  const httpsPort = Number(env.HTTPS_PORT || DEFAULT_HTTPS_PORT);
  const portProbe = options.portProbe || checkPort;

  return {
    command: 'doctor',
    ok: nodeOk && codexConfigExists,
    node: {
      version: nodeVersion,
      minimumVersion: MIN_NODE_VERSION,
      status: nodeOk ? 'passed' : 'failed'
    },
    checks: {
      codexConfig: {
        status: codexConfigExists ? 'passed' : 'failed',
        path: paths.codexConfigPath
      },
      httpPort: await portProbe(httpPort),
      httpsPort: await portProbe(httpsPort),
      tailscale: await checkTailscale(execFile)
    },
    network: {
      privateIps: collectPrivateIps(options.networkInterfaces)
    },
    paths
  };
}

export async function collectStatusReport(options = {}) {
  const paths = resolveRuntimePaths(options);
  const fileSystem = options.fs || fs;
  const processStatus = await collectManagedProcessStatus({ ...options, paths });
  let launchAgent = {
    supported: paths.platform === 'darwin',
    installed: paths.launchAgentPath
      ? await pathExists(fileSystem, paths.launchAgentPath)
      : false,
    loaded: false,
    path: paths.launchAgentPath || null
  };
  if (paths.platform === 'darwin') {
    launchAgent = await getMacLaunchAgentStatus({ ...options, paths });
  }
  const relayConfig = await readRedactedRelayConfig({ ...options, paths });

  return {
    command: 'status',
    ok: true,
    process: processStatus,
    launchAgent,
    relayConfig,
    urls: {
      localHttp: 'http://127.0.0.1:3321',
      localHttps: 'https://127.0.0.1:3443'
    },
    paths
  };
}
