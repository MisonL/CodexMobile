import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_CLIPROXY_CONFIG = process.platform === 'win32'
  ? 'D:\\CLIProxyAPI\\config.yaml'
  : path.join(os.homedir(), '.cli-proxy-api', 'config.yaml');
export const DEFAULT_AUTH_DIR = path.join(os.homedir(), '.cli-proxy-api');
export const CODEX_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';
export const REQUEST_TIMEOUT_MS = 18_000;
export const MANAGEMENT_TIMEOUT_MS = 30_000;
export const FIXED_PAIRING_CODE_FILE = path.join(process.cwd(), '.codexmobile', 'state', 'pairing-code.txt');

export function stripQuotes(value) {
  const trimmed = String(value || '').trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

export function expandHome(value) {
  const raw = String(value || '').trim();
  if (!raw) {
    return raw;
  }
  if (raw === '~') {
    return os.homedir();
  }
  if (raw.startsWith('~/') || raw.startsWith('~\\')) {
    return path.join(os.homedir(), raw.slice(2));
  }
  return raw;
}

export async function readCliproxyConfig() {
  const configPath = process.env.CLIPROXYAPI_CONFIG || DEFAULT_CLIPROXY_CONFIG;
  const config = {
    host: '127.0.0.1',
    port: 8317,
    tls: false,
    authDir: ''
  };
  try {
    const raw = await fs.readFile(configPath, 'utf8');
    let section = '';
    for (const rawLine of raw.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) {
        continue;
      }
      const sectionMatch = line.match(/^([A-Za-z0-9_-]+)\s*:\s*$/);
      if (sectionMatch) {
        section = sectionMatch[1];
        continue;
      }
      const valueMatch = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.+?)\s*(?:#.*)?$/);
      if (!valueMatch) {
        continue;
      }
      const key = valueMatch[1];
      const value = stripQuotes(valueMatch[2]);
      if (section === 'tls' && key === 'enable') {
        config.tls = /^true$/i.test(value);
      } else if (key === 'host') {
        config.host = value || config.host;
      } else if (key === 'port') {
        const port = Number(value);
        if (Number.isFinite(port) && port > 0) {
          config.port = port;
        }
      } else if (key === 'auth-dir') {
        config.authDir = path.resolve(expandHome(value));
      }
    }
  } catch {
    // Defaults are enough for the normal local CLIProxyAPI install.
  }
  return config;
}

export async function resolveAuthDir() {
  const explicit = process.env.CODEXMOBILE_CLIPROXY_AUTH_DIR || process.env.CLIPROXYAPI_AUTH_DIR;
  if (explicit) {
    return path.resolve(expandHome(explicit));
  }

  const config = await readCliproxyConfig();
  if (config.authDir) {
    return config.authDir;
  }

  return DEFAULT_AUTH_DIR;
}

export async function resolveManagementBaseUrl() {
  const explicit = String(process.env.CODEXMOBILE_CLIPROXY_MANAGEMENT_URL || process.env.CLIPROXYAPI_MANAGEMENT_URL || '').trim();
  if (explicit) {
    return explicit.replace(/\/+$/, '');
  }
  const config = await readCliproxyConfig();
  const host = !config.host || config.host === '0.0.0.0' ? '127.0.0.1' : config.host;
  return `${config.tls ? 'https' : 'http'}://${host}:${config.port}`;
}

export async function resolveManagementKey() {
  for (const value of [
    process.env.CODEXMOBILE_CLIPROXY_MANAGEMENT_KEY,
    process.env.CLIPROXYAPI_MANAGEMENT_KEY,
    process.env.MANAGEMENT_PASSWORD,
    process.env.CODEXMOBILE_PAIRING_CODE
  ]) {
    const trimmed = String(value || '').trim();
    if (trimmed) {
      return trimmed;
    }
  }
  try {
    return (await fs.readFile(FIXED_PAIRING_CODE_FILE, 'utf8')).trim();
  } catch {
    return '';
  }
}
