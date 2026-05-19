import {
  execFile as defaultExecFile,
  spawn as defaultSpawn
} from 'node:child_process';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MANAGED_KIND = 'codexmobile-server';
const STATE_VERSION = 1;
const DEFAULT_LOG_LINES = 80;
const DEFAULT_CLI_PATH = fileURLToPath(new URL('../bin/codexmobile.mjs', import.meta.url));

export function dedupePath(value, options = {}) {
  const delimiter = options.platform === 'win32' ? ';' : ':';
  const seen = new Set();
  return String(value || '')
    .split(delimiter)
    .map((item) => item.trim())
    .filter(Boolean)
    .filter((item) => {
      const key = options.platform === 'win32' ? item.toLowerCase() : item;
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    })
    .join(delimiter);
}

export function redactLogText(text) {
  return String(text || '')
    .replace(/(CODEXMOBILE_RELAY_SECRET=)[^\s]+/g, '$1[redacted]')
    .replace(/(CODEXMOBILE_PAIRING_CODE=)[^\s]+/g, '$1[redacted]')
    .replace(/(Pairing code:\s*)\d{6}/g, '$1[redacted]')
    .replace(/(Authorization:\s*Bearer\s+)[^\s]+/gi, '$1[redacted]')
    .replace(/([?&]token=)[^&\s]+/g, '$1[redacted]');
}

async function readJson(fileSystem, filePath) {
  try {
    return JSON.parse(await fileSystem.readFile(filePath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

export async function readManagedState(options = {}) {
  const fileSystem = options.fs || fs;
  return readJson(fileSystem, options.paths.processStatePath);
}

export async function writeManagedState(options = {}) {
  const fileSystem = options.fs || fs;
  await fileSystem.mkdir(options.paths.runDir, { recursive: true });
  await fileSystem.writeFile(
    options.paths.processStatePath,
    JSON.stringify(options.state, null, 2),
    'utf8'
  );
  await fileSystem.writeFile(options.paths.pidPath, `${options.state.pid}\n`, 'utf8');
}

export async function removeManagedState(options = {}) {
  const fileSystem = options.fs || fs;
  await Promise.allSettled([
    fileSystem.rm(options.paths.processStatePath, { force: true }),
    fileSystem.rm(options.paths.pidPath, { force: true })
  ]);
}

function isManagedState(state) {
  return state?.version === STATE_VERSION &&
    state?.kind === MANAGED_KIND &&
    Number.isInteger(state.pid);
}

function isStoppableState(state) {
  return isManagedState(state) &&
    Array.isArray(state.command) &&
    state.command.includes('serve');
}

function execFilePromise(execFile, command, args) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: 1000 }, (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(String(stdout || ''));
    });
  });
}

function commandMatchesState(commandLine, state) {
  const text = String(commandLine || '');
  const [, cliPath, command] = state.command || [];
  return Boolean(cliPath && command && text.includes(cliPath) && text.includes(command));
}

async function isManagedProcessAlive(state, options = {}) {
  if (typeof options.isManagedProcessAlive === 'function') {
    return options.isManagedProcessAlive(state);
  }
  if (options.platform === 'win32' || process.platform === 'win32') {
    return true;
  }
  const execFile = options.execFile || defaultExecFile;
  try {
    const commandLine = await execFilePromise(execFile, 'ps', ['-p', String(state.pid), '-o', 'command=']);
    return commandMatchesState(commandLine, state);
  } catch {
    return false;
  }
}

function childEnv(options) {
  const platform = options.platform || process.platform;
  const env = { ...(options.env || process.env) };
  env.CODEXMOBILE_HOME = options.paths.dataDir;
  env.CODEX_HOME = env.CODEX_HOME || options.paths.codexHome;

  if (platform === 'win32') {
    env.Path = dedupePath([env.Path, env.PATH].filter(Boolean).join(';'), { platform });
    delete env.PATH;
  }
  return env;
}

function createState({ pid, paths, nodePath, cliPath }) {
  return {
    version: STATE_VERSION,
    kind: MANAGED_KIND,
    pid,
    command: [nodePath, cliPath, 'serve'],
    cwd: paths.repoRoot,
    startedAt: new Date().toISOString(),
    logFiles: {
      out: paths.serverOutLogPath,
      err: paths.serverErrLogPath
    }
  };
}

export async function startManagedServer(options = {}) {
  const paths = options.paths;
  const fileSystem = options.fs || fs;
  const spawn = options.spawn || defaultSpawn;
  const nodePath = options.nodePath || process.execPath;
  const cliPath = options.cliPath || DEFAULT_CLI_PATH;
  const existing = await collectManagedProcessStatus(options);

  if (existing.managed && existing.running) {
    return {
      command: 'start',
      ok: true,
      started: false,
      pid: existing.pid,
      detail: 'Managed CodexMobile server is already running.'
    };
  }

  await fileSystem.mkdir(paths.logDir, { recursive: true });
  await fileSystem.mkdir(paths.runDir, { recursive: true });

  const out = fsSync.openSync(paths.serverOutLogPath, 'a');
  const err = fsSync.openSync(paths.serverErrLogPath, 'a');
  try {
    const child = spawn(nodePath, [cliPath, 'serve'], {
      cwd: paths.repoRoot,
      detached: true,
      stdio: ['ignore', out, err],
      windowsHide: true,
      env: childEnv({ ...options, paths })
    });
    child.unref();
    const state = createState({ pid: child.pid, paths, nodePath, cliPath });
    await writeManagedState({ paths, state, fs: fileSystem });
    return {
      command: 'start',
      ok: true,
      started: true,
      pid: child.pid,
      logFiles: state.logFiles
    };
  } finally {
    fsSync.closeSync(out);
    fsSync.closeSync(err);
  }
}

export async function stopManagedServer(options = {}) {
  const paths = options.paths;
  const state = await readManagedState(options);
  if (!state) {
    return { command: 'stop', ok: true, stopped: false, detail: 'No managed process state found.' };
  }
  if (!isStoppableState(state)) {
    return { command: 'stop', ok: false, stopped: false, error: 'Process state is not managed by CodexMobile.' };
  }

  const status = await collectManagedProcessStatus(options);
  if (!status.running || !(await isManagedProcessAlive(state, options))) {
    await removeManagedState(options);
    return { command: 'stop', ok: true, stopped: false, stale: true, pid: state.pid };
  }

  const kill = options.kill || process.kill;
  kill(state.pid, options.signal || 'SIGTERM');
  await removeManagedState(options);
  return { command: 'stop', ok: true, stopped: true, pid: state.pid };
}

export async function restartManagedServer(options = {}) {
  const stopped = await stopManagedServer(options);
  if (stopped.ok === false) {
    return { command: 'restart', ok: false, stopped: false, error: stopped.error };
  }
  const started = await startManagedServer(options);
  return {
    command: 'restart',
    ok: started.ok,
    stopped: stopped.stopped,
    started: started.started,
    pid: started.pid,
    logFiles: started.logFiles
  };
}

export async function collectManagedProcessStatus(options = {}) {
  const state = await readManagedState(options);
  if (!isManagedState(state)) {
    return { managed: false, running: false, pid: null };
  }
  const isProcessRunning = options.isProcessRunning || ((pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  });
  return {
    managed: true,
    running: isProcessRunning(state.pid),
    pid: state.pid,
    startedAt: state.startedAt,
    logFiles: state.logFiles
  };
}

async function readTail(fileSystem, filePath, lines) {
  try {
    const raw = await fileSystem.readFile(filePath, 'utf8');
    return raw.split(/\r?\n/).slice(-lines).join('\n');
  } catch (error) {
    if (error.code === 'ENOENT') {
      return '';
    }
    throw error;
  }
}

export async function readManagedLogs(options = {}) {
  const paths = options.paths;
  const fileSystem = options.fs || fs;
  const lines = Number(options.lines || DEFAULT_LOG_LINES);
  const [out, err] = await Promise.all([
    readTail(fileSystem, paths.serverOutLogPath, lines),
    readTail(fileSystem, paths.serverErrLogPath, lines)
  ]);
  const text = redactLogText([out, err].filter(Boolean).join('\n'));

  return {
    command: 'logs',
    ok: true,
    files: {
      out: paths.serverOutLogPath,
      err: paths.serverErrLogPath
    },
    text
  };
}
