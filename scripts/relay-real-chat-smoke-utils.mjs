import fs from 'node:fs/promises';
import fssync from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const DEFAULT_RELAY_BASE_URL = 'http://127.0.0.1:9791';
const DEFAULT_DOCKER_CONTAINER = 'codexmobile-relay-local-test-run';
const DEFAULT_WAIT_TIMEOUT_MS = 30000;
const EVENT_CONTENT_MAX_LENGTH = 200;
const POLL_INTERVAL_MS = 250;
const execFileAsync = promisify(execFile);

export function relayUrls() {
  const baseUrl = process.env.CODEXMOBILE_RELAY_BASE_URL || DEFAULT_RELAY_BASE_URL;
  const parsed = new URL(baseUrl);
  parsed.pathname = '';
  parsed.search = '';
  parsed.hash = '';
  const wsProtocol = parsed.protocol === 'https:' ? 'wss:' : 'ws:';
  return {
    baseUrl: parsed.toString().replace(/\/$/, ''),
    macUrl: `${wsProtocol}//${parsed.host}/relay/mac`,
    browserWsBase: `${wsProtocol}//${parsed.host}`
  };
}

export function defaultRelayBaseUrl() {
  return DEFAULT_RELAY_BASE_URL;
}

export async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
  });
}

export async function copyCodexRuntime(codexHome) {
  const realCodexHome = process.env.CODEXMOBILE_REAL_CHAT_SOURCE_CODEX_HOME || path.join(os.homedir(), '.codex');
  await fs.mkdir(codexHome, { recursive: true });
  for (const name of ['auth.json', 'config.toml', 'models_cache.json']) {
    const source = path.join(realCodexHome, name);
    if (fssync.existsSync(source)) {
      const destination = path.join(codexHome, name);
      await fs.copyFile(source, destination);
      await fs.chmod(destination, 0o600);
    }
  }
}

export async function resetDefaultDockerRelay(baseUrl) {
  if (process.env.CODEXMOBILE_REAL_CHAT_RESET_RELAY === '0' || baseUrl !== DEFAULT_RELAY_BASE_URL) {
    return false;
  }
  const container = process.env.CODEXMOBILE_REAL_CHAT_DOCKER_CONTAINER || DEFAULT_DOCKER_CONTAINER;
  try {
    await execFileAsync('docker', ['restart', container], { timeout: 30000 });
    return true;
  } catch {
    return false;
  }
}

export function startProcess({ command, args, env, cwd, logPath }) {
  const output = fssync.createWriteStream(logPath, { flags: 'a' });
  const child = spawn(command, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.pipe(output);
  child.stderr.pipe(output);
  return child;
}

export async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitFor(action, label, timeoutMs = DEFAULT_WAIT_TIMEOUT_MS) {
  const startedAt = Date.now();
  let lastError = null;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const value = await action();
      if (value) {
        return value;
      }
    } catch (error) {
      lastError = error;
    }
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(`${label} timed out${lastError ? `: ${lastError.message}` : ''}`);
}

export async function requestJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...(options.headers || {})
    }
  });
  const text = await response.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { text };
  }
  return { response, data };
}

export function sanitizeEvent(event) {
  return {
    type: event.type,
    status: event.status,
    label: event.label,
    kind: event.kind,
    done: event.done,
    hadAssistantText: event.hadAssistantText,
    content: event.content ? String(event.content).slice(0, EVENT_CONTENT_MAX_LENGTH) : undefined,
    error: event.error ? String(event.error).slice(0, EVENT_CONTENT_MAX_LENGTH) : undefined
  };
}
