import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { resolveCodexMobileRuntimePaths } from '../server/runtime-paths.js';

const root = path.resolve(import.meta.dirname, '..');
const runtimePaths = resolveCodexMobileRuntimePaths({
  cwd: root,
  env: process.env,
  rootDir: root
});
const logDir = runtimePaths.dataRoot;
if (!path.isAbsolute(logDir)) {
  throw new Error(`CODEXMOBILE_HOME must resolve to an absolute path: ${logDir}`);
}
fs.mkdirSync(logDir, { recursive: true });

const outPath = path.join(logDir, 'server.out.log');
const errPath = path.join(logDir, 'server.err.log');

function dedupePath(value) {
  const seen = new Set();
  return String(value || '')
    .split(path.delimiter)
    .map((item) => item.trim())
    .filter(Boolean)
    .filter((item) => {
      const key = process.platform === 'win32' ? item.toLowerCase() : item;
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    })
    .join(path.delimiter);
}

function childEnv() {
  if (process.platform !== 'win32') {
    return {
      ...process.env,
      CODEXMOBILE_HOME: logDir
    };
  }

  const env = {};
  const seen = new Set();
  for (const [key, value] of Object.entries(process.env)) {
    const normalized = key.toLowerCase();
    if (normalized === 'path' || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    env[key] = value;
  }

  env.Path = dedupePath([
    process.env.Path,
    process.env.PATH
  ].filter(Boolean).join(path.delimiter));
  env.CODEXMOBILE_HOME = logDir;
  return env;
}

const out = fs.openSync(outPath, 'a');
const err = fs.openSync(errPath, 'a');
try {
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: root,
    detached: true,
    stdio: ['ignore', out, err],
    windowsHide: true,
    env: childEnv()
  });

  child.unref();
  console.log(`CodexMobile server started in background, pid=${child.pid}`);
  console.log(`Logs: ${outPath}`);
} finally {
  fs.closeSync(out);
  fs.closeSync(err);
}
process.exit(0);
