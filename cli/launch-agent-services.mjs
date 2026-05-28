import {
  currentUserDomain,
  isAlreadyBootstrapped,
  isNotBootstrapped,
  serviceTarget
} from './launchctl-policy.mjs';

const COMMAND_TIMEOUT_MS = 5000;

export function execFilePromise(execFile, command, args) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: COMMAND_TIMEOUT_MS }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

export async function bootoutLaunchAgentLabel(execFile, label) {
  try {
    await execFilePromise(execFile, 'launchctl', ['bootout', serviceTarget(label)]);
    return true;
  } catch (error) {
    if (isNotBootstrapped(error)) {
      return false;
    }
    throw error;
  }
}

async function bootstrapLaunchAgent(execFile, launchAgentPath) {
  try {
    await execFilePromise(execFile, 'launchctl', ['bootstrap', currentUserDomain(), launchAgentPath]);
  } catch (error) {
    if (!isAlreadyBootstrapped(error)) {
      throw error;
    }
  }
}

async function cleanupLaunchAgentServices(execFile, labels) {
  const cleanup = [];
  for (const label of labels.slice().reverse()) {
    try {
      await bootoutLaunchAgentLabel(execFile, label);
      cleanup.push({ label, ok: true });
    } catch (error) {
      cleanup.push({
        label,
        ok: false,
        error: String(error.stderr || error.message || error)
      });
    }
  }
  return cleanup;
}

export async function startLaunchAgentServices(execFile, services) {
  const started = [];
  try {
    for (const item of services) {
      await bootoutLaunchAgentLabel(execFile, item.label);
      await bootstrapLaunchAgent(execFile, item.path);
      started.push(item.label);
      await execFilePromise(execFile, 'launchctl', ['kickstart', '-k', serviceTarget(item.label)]);
    }
  } catch (error) {
    error.cleanup = await cleanupLaunchAgentServices(execFile, started);
    throw error;
  }
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

export async function getLaunchAgentServiceStatus({ fileSystem, execFile, label, launchAgentPath }) {
  const installed = await pathExists(fileSystem, launchAgentPath);
  try {
    const result = await execFilePromise(execFile, 'launchctl', ['print', serviceTarget(label)]);
    return {
      installed,
      loaded: true,
      label,
      path: launchAgentPath,
      detail: result.stdout.trim()
    };
  } catch (error) {
    return {
      installed,
      loaded: false,
      label,
      path: launchAgentPath,
      detail: String(error.stderr || error.code || error.message || '').trim()
    };
  }
}
