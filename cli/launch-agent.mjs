import { execFile as defaultExecFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { LAUNCH_AGENT_LABEL, RELAY_LAUNCH_AGENT_LABEL } from './paths.mjs';
import {
  buildLaunchAgentEnv,
  buildLaunchAgentPlist
} from './launch-agent-plist.mjs';
import {
  bootoutLaunchAgentLabel,
  execFilePromise,
  getLaunchAgentServiceStatus,
  startLaunchAgentServices
} from './launch-agent-services.mjs';
import {
  buildLaunchctlCommands,
  buildLaunchctlNotes,
} from './launchctl-policy.mjs';

const DEFAULT_CLI_PATH = fileURLToPath(new URL('../bin/codexmobile.mjs', import.meta.url));
const DEFAULT_RELAY_CLIENT_PATH = fileURLToPath(new URL('../scripts/relay-mac-client.mjs', import.meta.url));
const RELAY_SKIPPED_REASON = 'relay-config-missing';

function requireMacPaths(paths) {
  if (!paths) {
    throw new Error('paths are required.');
  }
  if (paths.platform !== 'darwin') {
    throw new Error('macOS LaunchAgent commands are only available on darwin.');
  }
  return paths;
}

async function bootoutLaunchAgent(execFile) {
  return bootoutLaunchAgentLabel(execFile, LAUNCH_AGENT_LABEL);
}

function launchAgentOptions(options = {}) {
  return {
    fileSystem: options.fs || fs,
    execFile: options.execFile || defaultExecFile,
    nodePath: options.nodePath || process.execPath,
    cliPath: options.cliPath || DEFAULT_CLI_PATH,
    relayClientPath: options.relayClientPath || DEFAULT_RELAY_CLIENT_PATH
  };
}

function relayLaunchAgentPath(paths) {
  return paths.relayLaunchAgentPath ||
    path.posix.join(path.posix.dirname(paths.launchAgentPath), `${RELAY_LAUNCH_AGENT_LABEL}.plist`);
}

function launchAgentServices(paths, relayPath, relayConfigured) {
  const services = [
    { label: LAUNCH_AGENT_LABEL, path: paths.launchAgentPath }
  ];
  if (relayConfigured) {
    services.push({ label: RELAY_LAUNCH_AGENT_LABEL, path: relayPath });
  }
  return services;
}

async function startConfiguredLaunchAgentServices(execFile, paths, relayPath, relayConfigured) {
  if (!relayConfigured) {
    await bootoutLaunchAgentLabel(execFile, RELAY_LAUNCH_AGENT_LABEL);
  }
  await startLaunchAgentServices(
    execFile,
    launchAgentServices(paths, relayPath, relayConfigured)
  );
}

async function writeLaunchAgentItem(fileSystem, execFile, item) {
  await fileSystem.writeFile(item.path, item.content, { encoding: 'utf8', mode: 0o644 });
  await execFilePromise(execFile, 'plutil', ['-lint', item.path]);
}

async function writeLaunchAgentPlan({ fileSystem, execFile, plan }) {
  await Promise.all(plan.wouldCreateDirs.map((dir) => fileSystem.mkdir(dir, { recursive: true })));
  for (const item of plan.wouldWrite) {
    await writeLaunchAgentItem(fileSystem, execFile, item);
  }
  if (!plan.relayConfigured) {
    await fileSystem.rm(plan.relayLaunchAgentPath, { force: true });
  }
  return plan.wouldWrite.map((item) => item.path);
}

export { buildLaunchAgentPlist };

export function buildMacInstallPlan(options = {}) {
  const paths = requireMacPaths(options.paths);
  const includeRelayConnector = options.relayConfigured === true;
  const relayPath = relayLaunchAgentPath(paths);

  const content = buildLaunchAgentPlist({
    label: LAUNCH_AGENT_LABEL,
    nodePath: options.nodePath,
    cliPath: options.cliPath,
    workingDirectory: paths.repoRoot,
    logDir: paths.logDir,
    env: buildLaunchAgentEnv(paths)
  });
  const wouldWrite = [
    {
      path: paths.launchAgentPath,
      mode: '0644',
      content
    }
  ];
  if (includeRelayConnector) {
    wouldWrite.push({
      path: relayPath,
      mode: '0644',
      content: buildLaunchAgentPlist({
        label: RELAY_LAUNCH_AGENT_LABEL,
        nodePath: options.nodePath,
        cliPath: options.relayClientPath,
        workingDirectory: paths.repoRoot,
        logDir: paths.logDir,
        logName: 'relay',
        programArguments: [
          options.nodePath,
          options.relayClientPath || DEFAULT_RELAY_CLIENT_PATH
        ].filter(Boolean),
        env: buildLaunchAgentEnv(paths)
      })
    });
  }
  const wouldCreateDirs = [
    path.posix.dirname(paths.launchAgentPath),
    paths.dataDir,
    paths.logDir
  ];
  if (includeRelayConnector) {
    wouldCreateDirs.push(path.posix.dirname(relayPath));
  }

  return {
    command: 'install',
    platform: 'darwin',
    label: LAUNCH_AGENT_LABEL,
    dryRun: Boolean(options.dryRun),
    launchAgentPath: paths.launchAgentPath,
    relayLaunchAgentPath: relayPath,
    relayConfigured: includeRelayConnector,
    relaySkipped: includeRelayConnector ? '' : RELAY_SKIPPED_REASON,
    dataDir: paths.dataDir,
    logDir: paths.logDir,
    wouldCreateDirs: [...new Set(wouldCreateDirs)],
    wouldWrite,
    wouldRun: [
      ...buildLaunchctlCommands(paths, LAUNCH_AGENT_LABEL, paths.launchAgentPath),
      ...(includeRelayConnector ? buildLaunchctlCommands(paths, RELAY_LAUNCH_AGENT_LABEL, relayPath) : [])
    ],
    notes: [
      ...buildLaunchctlNotes(),
      ...(includeRelayConnector ? [] : ['Relay connector LaunchAgent is skipped until relay-config is saved.'])
    ]
  };
}

export async function installMacLaunchAgent(options = {}) {
  const paths = requireMacPaths(options.paths);
  const { fileSystem, execFile, nodePath, cliPath, relayClientPath } = launchAgentOptions(options);
  const plan = buildMacInstallPlan({
    paths,
    nodePath,
    cliPath,
    relayClientPath,
    dryRun: false,
    relayConfigured: options.relayConfigured === true
  });

  await writeLaunchAgentPlan({ fileSystem, execFile, plan });
  await startConfiguredLaunchAgentServices(execFile, paths, plan.relayLaunchAgentPath, plan.relayConfigured);

  return {
    command: 'install',
    ok: true,
    installed: true,
    label: LAUNCH_AGENT_LABEL,
    relayLabel: RELAY_LAUNCH_AGENT_LABEL,
    path: paths.launchAgentPath,
    relayPath: plan.relayLaunchAgentPath,
    relayInstalled: plan.relayConfigured,
    relaySkipped: plan.relaySkipped,
    dataDir: paths.dataDir,
    logDir: paths.logDir
  };
}

export async function enableMacLaunchAgent(options = {}) {
  const paths = requireMacPaths(options.paths);
  const { fileSystem, execFile, nodePath, cliPath, relayClientPath } = launchAgentOptions(options);
  const relayConfigured = options.relayConfigured === true;
  const plan = buildMacInstallPlan({
    paths,
    nodePath,
    cliPath,
    relayClientPath,
    dryRun: false,
    relayConfigured
  });
  const writtenPlists = await writeLaunchAgentPlan({
    fileSystem,
    execFile,
    plan
  });

  await startConfiguredLaunchAgentServices(execFile, paths, plan.relayLaunchAgentPath, relayConfigured);
  return {
    command: 'enable',
    ok: true,
    enabled: true,
    label: LAUNCH_AGENT_LABEL,
    path: paths.launchAgentPath,
    plistWritten: writtenPlists.includes(paths.launchAgentPath),
    relayEnabled: relayConfigured,
    relayPlistWritten: writtenPlists.includes(plan.relayLaunchAgentPath),
    relaySkipped: relayConfigured ? '' : RELAY_SKIPPED_REASON
  };
}

export async function disableMacLaunchAgent(options = {}) {
  requireMacPaths(options.paths);
  const { execFile } = launchAgentOptions(options);

  await bootoutLaunchAgentLabel(execFile, LAUNCH_AGENT_LABEL);
  await bootoutLaunchAgentLabel(execFile, RELAY_LAUNCH_AGENT_LABEL);
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
  const relayPath = relayLaunchAgentPath(paths);
  const server = await getLaunchAgentServiceStatus({
    fileSystem,
    execFile,
    label: LAUNCH_AGENT_LABEL,
    launchAgentPath: paths.launchAgentPath
  });
  const relayConnector = await getLaunchAgentServiceStatus({
    fileSystem,
    execFile,
    label: RELAY_LAUNCH_AGENT_LABEL,
    launchAgentPath: relayPath
  });
  return { supported: true, ...server, relayConnector };
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
  await bootoutLaunchAgentLabel(execFile, RELAY_LAUNCH_AGENT_LABEL);
  const relayPath = relayLaunchAgentPath(paths);
  await fileSystem.rm(paths.launchAgentPath, { force: true });
  await fileSystem.rm(relayPath, { force: true });
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
