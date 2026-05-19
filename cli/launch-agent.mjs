import { execFile as defaultExecFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { LAUNCH_AGENT_LABEL } from './paths.mjs';
import {
  buildLaunchctlCommands,
  buildLaunchctlNotes,
  currentUserDomain,
  isAlreadyBootstrapped,
  isNotBootstrapped,
  serviceTarget
} from './launchctl-policy.mjs';

const COMMAND_TIMEOUT_MS = 5000;
const DEFAULT_CLI_PATH = fileURLToPath(new URL('../bin/codexmobile.mjs', import.meta.url));

function xmlEscape(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function stringEntry(value) {
  return `    <string>${xmlEscape(value)}</string>`;
}

function envEntries(env) {
  const entries = Object.entries(env || {})
    .filter(([, value]) => String(value || '').trim())
    .sort(([left], [right]) => left.localeCompare(right));
  if (!entries.length) {
    return '';
  }
  const lines = ['  <key>EnvironmentVariables</key>', '  <dict>'];
  for (const [key, value] of entries) {
    lines.push(`    <key>${xmlEscape(key)}</key>`);
    lines.push(stringEntry(value));
  }
  lines.push('  </dict>');
  return `${lines.join('\n')}\n`;
}

function buildLaunchAgentEnv(paths) {
  return {
    CODEXMOBILE_HOME: paths.dataDir,
    CODEX_HOME: paths.codexHome
  };
}

function requireMacPaths(paths) {
  if (!paths) {
    throw new Error('paths are required.');
  }
  if (paths.platform !== 'darwin') {
    throw new Error('macOS LaunchAgent commands are only available on darwin.');
  }
  return paths;
}

function execFilePromise(execFile, command, args) {
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

async function bootoutLaunchAgent(execFile) {
  try {
    await execFilePromise(execFile, 'launchctl', ['bootout', serviceTarget()]);
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

function launchAgentOptions(options = {}) {
  return {
    fileSystem: options.fs || fs,
    execFile: options.execFile || defaultExecFile,
    nodePath: options.nodePath || process.execPath,
    cliPath: options.cliPath || DEFAULT_CLI_PATH
  };
}

export function buildLaunchAgentPlist(options = {}) {
  const label = options.label || LAUNCH_AGENT_LABEL;
  const args = [
    options.nodePath,
    options.cliPath,
    'serve'
  ].filter(Boolean);
  const outPath = path.posix.join(options.logDir, 'server.out.log');
  const errPath = path.posix.join(options.logDir, 'server.err.log');

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
${stringEntry(label)}
  <key>ProgramArguments</key>
  <array>
${args.map(stringEntry).join('\n')}
  </array>
  <key>WorkingDirectory</key>
${stringEntry(options.workingDirectory)}
${envEntries(options.env)}  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <false/>
  <key>StandardOutPath</key>
${stringEntry(outPath)}
  <key>StandardErrorPath</key>
${stringEntry(errPath)}
</dict>
</plist>
`;
}

export function buildMacInstallPlan(options = {}) {
  const paths = requireMacPaths(options.paths);

  const content = buildLaunchAgentPlist({
    label: LAUNCH_AGENT_LABEL,
    nodePath: options.nodePath,
    cliPath: options.cliPath,
    workingDirectory: paths.repoRoot,
    logDir: paths.logDir,
    env: buildLaunchAgentEnv(paths)
  });

  return {
    command: 'install',
    platform: 'darwin',
    label: LAUNCH_AGENT_LABEL,
    dryRun: Boolean(options.dryRun),
    launchAgentPath: paths.launchAgentPath,
    dataDir: paths.dataDir,
    logDir: paths.logDir,
    wouldCreateDirs: [
      path.posix.dirname(paths.launchAgentPath),
      paths.dataDir,
      paths.logDir
    ],
    wouldWrite: [
      {
        path: paths.launchAgentPath,
        mode: '0644',
        content
      }
    ],
    wouldRun: buildLaunchctlCommands(paths),
    notes: buildLaunchctlNotes()
  };
}

export async function installMacLaunchAgent(options = {}) {
  const paths = requireMacPaths(options.paths);
  const { fileSystem, execFile, nodePath, cliPath } = launchAgentOptions(options);
  const plan = buildMacInstallPlan({ paths, nodePath, cliPath, dryRun: false });
  const plist = plan.wouldWrite[0].content;

  await Promise.all(plan.wouldCreateDirs.map((dir) => fileSystem.mkdir(dir, { recursive: true })));
  await fileSystem.writeFile(paths.launchAgentPath, plist, { encoding: 'utf8', mode: 0o644 });
  await execFilePromise(execFile, 'plutil', ['-lint', paths.launchAgentPath]);
  await bootoutLaunchAgent(execFile);
  await bootstrapLaunchAgent(execFile, paths.launchAgentPath);
  await execFilePromise(execFile, 'launchctl', ['kickstart', '-k', serviceTarget()]);

  return {
    command: 'install',
    ok: true,
    installed: true,
    label: LAUNCH_AGENT_LABEL,
    path: paths.launchAgentPath,
    dataDir: paths.dataDir,
    logDir: paths.logDir
  };
}

export async function enableMacLaunchAgent(options = {}) {
  const paths = requireMacPaths(options.paths);
  const { execFile } = launchAgentOptions(options);

  await bootoutLaunchAgent(execFile);
  await bootstrapLaunchAgent(execFile, paths.launchAgentPath);
  await execFilePromise(execFile, 'launchctl', ['kickstart', '-k', serviceTarget()]);
  return {
    command: 'enable',
    ok: true,
    enabled: true,
    label: LAUNCH_AGENT_LABEL,
    path: paths.launchAgentPath
  };
}

export async function disableMacLaunchAgent(options = {}) {
  requireMacPaths(options.paths);
  const { execFile } = launchAgentOptions(options);

  await execFilePromise(execFile, 'launchctl', ['bootout', serviceTarget()]);
  return {
    command: 'disable',
    ok: true,
    disabled: true,
    label: LAUNCH_AGENT_LABEL
  };
}

export async function getMacLaunchAgentStatus(options = {}) {
  const paths = requireMacPaths(options.paths);
  const { fileSystem, execFile } = launchAgentOptions(options);
  const installed = await pathExists(fileSystem, paths.launchAgentPath);

  try {
    const result = await execFilePromise(execFile, 'launchctl', ['print', serviceTarget()]);
    return {
      supported: true,
      installed,
      loaded: true,
      label: LAUNCH_AGENT_LABEL,
      path: paths.launchAgentPath,
      detail: result.stdout.trim()
    };
  } catch (error) {
    return {
      supported: true,
      installed,
      loaded: false,
      label: LAUNCH_AGENT_LABEL,
      path: paths.launchAgentPath,
      detail: String(error.stderr || error.code || error.message || '').trim()
    };
  }
}

export async function uninstallMacLaunchAgent(options = {}) {
  const paths = requireMacPaths(options.paths);
  const { fileSystem, execFile } = launchAgentOptions(options);
  if (options.removeData && !options.confirmRemoveData) {
    return {
      command: 'uninstall',
      ok: false,
      error: 'Refusing to remove user data without --confirm-remove-data.'
    };
  }

  const unloaded = await bootoutLaunchAgent(execFile);
  await fileSystem.rm(paths.launchAgentPath, { force: true });
  if (options.removeData) {
    await fileSystem.rm(paths.dataDir, { recursive: true, force: true });
  }

  return {
    command: 'uninstall',
    ok: true,
    uninstalled: true,
    unloaded,
    label: LAUNCH_AGENT_LABEL,
    path: paths.launchAgentPath,
    dataRemoved: Boolean(options.removeData)
  };
}
