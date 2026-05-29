import { execFile as defaultExecFile } from 'node:child_process';
import path from 'node:path';

const DEFAULT_PORT = 3321;
const DEFAULT_WAIT_TIMEOUT_MS = 5000;
const DEFAULT_WAIT_INTERVAL_MS = 100;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function execFileText(execFile, command, args) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: 2000 }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve(String(stdout || '').trim());
    });
  });
}

function uniquePids(text) {
  return [...new Set(
    String(text || '')
      .split(/\s+/)
      .map((item) => Number.parseInt(item, 10))
      .filter((pid) => Number.isInteger(pid) && pid > 0)
  )];
}

function samePath(left, right) {
  if (!left || !right) {
    return false;
  }
  return path.resolve(left) === path.resolve(right);
}

function commandHasRepoEntrypoint(text, repoRoot, entrypoint) {
  return repoRoot && text.includes(path.join(repoRoot, entrypoint));
}

function lsofField(text, prefix) {
  return String(text || '')
    .split(/\r?\n/)
    .find((line) => line.startsWith(prefix))
    ?.slice(prefix.length)
    .trim() || '';
}

export function isCodexMobileServerCommand(command, options = {}) {
  const text = String(command || '');
  const repoRoot = options.repoRoot || '';
  const cwd = options.cwd || '';
  if (text.includes('codexmobile.mjs serve')) {
    return !repoRoot || text.includes(repoRoot) || samePath(cwd, repoRoot);
  }
  if (!text.includes('server/index.js')) {
    return false;
  }
  return !repoRoot ||
    commandHasRepoEntrypoint(text, repoRoot, 'server/index.js') ||
    samePath(cwd, repoRoot);
}

async function detectProcessCwd(execFile, pid) {
  const output = await execFileText(execFile, 'lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn']);
  return lsofField(output, 'n');
}

export async function detectPortOwners(options = {}) {
  const execFile = options.execFile || defaultExecFile;
  const port = Number(options.port || DEFAULT_PORT);
  const repoRoot = options.paths?.repoRoot || options.repoRoot || '';
  let pids;
  try {
    pids = uniquePids(await execFileText(execFile, 'lsof', [
      '-nP',
      `-tiTCP:${port}`,
      '-sTCP:LISTEN'
    ]));
  } catch (error) {
    if (error.code === 'ENOENT') {
      return { port, supported: false, owners: [], error: 'lsof unavailable' };
    }
    return { port, supported: true, owners: [], error: String(error.stderr || error.message || error) };
  }
  const owners = [];
  for (const pid of pids) {
    let command = '';
    let cwd = '';
    try {
      command = await execFileText(execFile, 'ps', ['-p', String(pid), '-o', 'command=']);
    } catch {
      command = '';
    }
    try {
      cwd = await detectProcessCwd(execFile, pid);
    } catch {
      cwd = '';
    }
    owners.push({
      pid,
      command,
      cwd,
      codexMobile: isCodexMobileServerCommand(command, { cwd, repoRoot })
    });
  }
  return { port, supported: true, owners };
}

export async function takeOverPort(options = {}) {
  const detect = options.detectPortOwners || detectPortOwners;
  const kill = options.kill || process.kill;
  const ownerReport = await detect(options);
  if (ownerReport.supported === false) {
    return {
      ok: false,
      action: 'unsupported',
      port: ownerReport.port || DEFAULT_PORT,
      owners: [],
      error: ownerReport.error || 'Port owner detection is unavailable.'
    };
  }
  const owners = ownerReport.owners || [];
  if (owners.length === 0) {
    return { ok: true, action: 'none', port: ownerReport.port || DEFAULT_PORT, owners };
  }
  const unsafe = owners.filter((owner) => !owner.codexMobile);
  if (unsafe.length > 0) {
    return {
      ok: false,
      action: 'blocked',
      port: ownerReport.port || DEFAULT_PORT,
      owners,
      error: 'Port is occupied by a non-CodexMobile process.'
    };
  }
  if (options.validateOnly) {
    return {
      ok: true,
      action: 'verified',
      port: ownerReport.port || DEFAULT_PORT,
      owners
    };
  }
  if (!options.yes && options.confirm !== true) {
    return {
      ok: false,
      action: 'confirm-required',
      port: ownerReport.port || DEFAULT_PORT,
      owners,
      error: 'Unmanaged CodexMobile server is using the port.'
    };
  }
  if (options.dryRun) {
    return {
      ok: true,
      action: 'would-stop-unmanaged',
      port: ownerReport.port || DEFAULT_PORT,
      owners,
      stoppedPids: []
    };
  }
  for (const owner of owners) {
    try {
      kill(owner.pid, 'SIGTERM');
    } catch (error) {
      if (error.code !== 'ESRCH') {
        throw error;
      }
    }
  }
  const waitResult = await waitForPortClear({ ...options, detectPortOwners: detect });
  if (!waitResult.cleared) {
    return {
      ok: false,
      action: 'port-still-listening',
      port: ownerReport.port || DEFAULT_PORT,
      owners: waitResult.owners,
      stoppedPids: owners.map((owner) => owner.pid),
      error: waitResult.error || 'CodexMobile server did not release the port in time.'
    };
  }
  return {
    ok: true,
    action: 'stopped-unmanaged',
    port: ownerReport.port || DEFAULT_PORT,
    owners,
    stoppedPids: owners.map((owner) => owner.pid),
    waitMs: waitResult.waitMs
  };
}

export async function waitForPortClear(options = {}) {
  const detect = options.detectPortOwners || detectPortOwners;
  const timeoutMs = Number(options.waitTimeoutMs || DEFAULT_WAIT_TIMEOUT_MS);
  const intervalMs = Number(options.waitIntervalMs || DEFAULT_WAIT_INTERVAL_MS);
  const startedAt = Date.now();
  let report = { owners: [] };
  do {
    report = await detect(options);
    if (report.supported === false) {
      return {
        cleared: false,
        owners: report.owners || [],
        waitMs: Date.now() - startedAt,
        error: report.error || 'Port owner detection is unavailable.'
      };
    }
    if (!report.owners?.length) {
      return { cleared: true, owners: [], waitMs: Date.now() - startedAt };
    }
    await sleep(intervalMs);
  } while (Date.now() - startedAt < timeoutMs);
  return { cleared: false, owners: report.owners || [], waitMs: Date.now() - startedAt };
}
