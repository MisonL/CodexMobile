import { execFile as defaultExecFile } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';

import { resolveRuntimePaths } from './paths.mjs';

const MIN_NODE_MAJOR = 20;
const DEFAULT_HTTP_PORT = 3321;
const DEFAULT_HTTPS_PORT = 3443;
const PORT_TIMEOUT_MS = 250;

function nodeMajor(version) {
  const [major] = String(version || '').split('.');
  const parsed = Number(major);
  return Number.isFinite(parsed) ? parsed : 0;
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
  const nodeOk = nodeMajor(nodeVersion) >= MIN_NODE_MAJOR;
  const codexConfigExists = await pathExists(fileSystem, paths.codexConfigPath);
  const httpPort = Number(env.PORT || DEFAULT_HTTP_PORT);
  const httpsPort = Number(env.HTTPS_PORT || DEFAULT_HTTPS_PORT);
  const portProbe = options.portProbe || checkPort;

  return {
    command: 'doctor',
    ok: nodeOk && codexConfigExists,
    node: {
      version: nodeVersion,
      minimumMajor: MIN_NODE_MAJOR,
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
  const launchAgentInstalled = paths.launchAgentPath
    ? await pathExists(fileSystem, paths.launchAgentPath)
    : false;

  return {
    command: 'status',
    ok: true,
    process: {
      managed: false,
      pid: null,
      detail: 'No CLI-managed process state is recorded in this phase.'
    },
    launchAgent: {
      supported: paths.platform === 'darwin',
      installed: launchAgentInstalled,
      path: paths.launchAgentPath || null
    },
    urls: {
      localHttp: 'http://127.0.0.1:3321',
      localHttps: 'https://127.0.0.1:3443'
    },
    paths
  };
}
