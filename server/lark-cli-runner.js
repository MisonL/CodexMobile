import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

export const LARK_CLI = 'lark-cli';
const LARK_DOMAIN = 'https://open.feishu.cn';

let larkCliCommandPath = '';

async function pathExists(candidate) {
  try {
    await fs.access(candidate);
    return true;
  } catch {
    return false;
  }
}

export async function resolveLarkCliCommand() {
  if (larkCliCommandPath) {
    return larkCliCommandPath;
  }
  const candidates = [];
  if (process.env.LARK_CLI_PATH) {
    candidates.push(process.env.LARK_CLI_PATH);
  }
  if (process.platform === 'win32') {
    if (process.env.APPDATA) {
      candidates.push(path.join(process.env.APPDATA, 'npm', 'node_modules', '@larksuite', 'cli', 'bin', 'lark-cli.exe'));
      candidates.push(path.join(process.env.APPDATA, 'npm', 'lark-cli.cmd'));
    }
    const pathValue = process.env.Path || process.env.PATH || '';
    for (const dir of pathValue.split(path.delimiter).filter(Boolean)) {
      candidates.push(path.join(dir, 'lark-cli.exe'));
      candidates.push(path.join(dir, 'lark-cli.cmd'));
    }
  }
  for (const candidate of candidates) {
    if (await pathExists(candidate)) {
      larkCliCommandPath = candidate;
      return candidate;
    }
  }
  larkCliCommandPath = LARK_CLI;
  return LARK_CLI;
}

export function larkCliEnvironment(baseEnv = process.env) {
  const env = { ...baseEnv };
  const appId = String(env.LARK_APP_ID || env.CODEXMOBILE_FEISHU_APP_ID || '').trim();
  const appSecret = String(env.LARK_APP_SECRET || env.CODEXMOBILE_FEISHU_APP_SECRET || '').trim();
  if (appId) {
    env.LARK_APP_ID = appId;
  }
  if (appSecret) {
    env.LARK_APP_SECRET = appSecret;
  }
  env.LARK_DOMAIN = String(env.LARK_DOMAIN || LARK_DOMAIN).trim() || LARK_DOMAIN;
  env.LARK_CLI_NO_PROXY = '1';
  env.NO_PROXY = '*';
  env.no_proxy = '*';
  for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) {
    delete env[key];
  }
  return env;
}

export function prependPathEntry(env, dir) {
  const current = env.Path || env.PATH || '';
  const next = [dir, current].filter(Boolean).join(path.delimiter);
  env.Path = next;
  env.PATH = next;
}

function windowsCmdQuote(value) {
  return `"${String(value || '').replace(/"/g, '""').replace(/\r?\n/g, ' ')}"`;
}

export function larkCliSpawnOptions(command, args) {
  if (process.platform === 'win32' && /\.cmd$|\.bat$/i.test(command)) {
    return {
      command: process.env.ComSpec || 'cmd.exe',
      args: ['/d', '/c', ['call', windowsCmdQuote(command), ...args.map(windowsCmdQuote)].join(' ')],
      windowsVerbatimArguments: true
    };
  }
  return {
    command,
    args,
    windowsVerbatimArguments: false
  };
}

export function redacted(value) {
  return String(value || '')
    .replace(/"appSecret"\s*:\s*"[^"]+"/gi, '"appSecret":"****"')
    .replace(/"access[_-]?token"\s*:\s*"[^"]+"/gi, '"accessToken":"****"')
    .replace(/"refresh[_-]?token"\s*:\s*"[^"]+"/gi, '"refreshToken":"****"')
    .replace(/\b(u|ur|t)-[A-Za-z0-9._-]{20,}\b/g, '$1-[hidden]')
    .replace(/sk-[A-Za-z0-9._-]+/g, 'sk-[hidden]');
}

function parseJsonObject(text) {
  const value = String(text || '').trim();
  if (!value) {
    return null;
  }
  try {
    return JSON.parse(value);
  } catch {
    const start = value.indexOf('{');
    const end = value.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(value.slice(start, end + 1));
      } catch {
        return null;
      }
    }
  }
  return null;
}

export function larkError(message, details = {}) {
  const error = new Error(message);
  Object.assign(error, details);
  return error;
}

export async function runLarkCli(args, options = {}) {
  const { input = '', timeoutMs = 15000, cwd = process.cwd() } = options;
  const command = await resolveLarkCliCommand();
  const spawnOptions = larkCliSpawnOptions(command, args);
  return await new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let child = null;
    try {
      child = spawn(spawnOptions.command, spawnOptions.args, {
        cwd,
        env: larkCliEnvironment(),
        windowsHide: true,
        windowsVerbatimArguments: spawnOptions.windowsVerbatimArguments
      });
    } catch (error) {
      resolve({ ok: false, code: null, signal: '', stdout: '', stderr: '', json: null, error: error.message });
      return;
    }
    const timeout = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      child.kill();
      resolve({
        ok: false,
        code: null,
        signal: 'timeout',
        stdout: redacted(stdout),
        stderr: redacted(stderr),
        json: parseJsonObject(stdout),
        error: `lark-cli timed out after ${timeoutMs}ms`
      });
    }, timeoutMs);
    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      resolve({
        ok: false,
        code: null,
        signal: '',
        stdout: redacted(stdout),
        stderr: redacted(stderr),
        json: null,
        error: error.message
      });
    });
    child.on('close', (code, signal) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      resolve({
        ok: code === 0,
        code,
        signal,
        stdout: redacted(stdout),
        stderr: redacted(stderr),
        json: parseJsonObject(stdout),
        error: code === 0 ? '' : redacted(stderr || stdout || `lark-cli exited with code ${code}`)
      });
    });
    if (input && child.stdin) {
      child.stdin.write(input);
    }
    child.stdin?.end();
  });
}
