import fs from 'node:fs/promises';

import * as defaultLaunchAgent from './launch-agent.mjs';
import { DEFAULT_CLI_PATH, DEFAULT_RELAY_CLIENT_PATH } from './command-paths.mjs';
import * as defaultProcessManager from './process-manager.mjs';
import { readRelayLaunchAgentState, readRelayConfig, saveRelayConfig } from './relay-config.mjs';
import { resolveRuntimePaths } from './paths.mjs';

function hasFlag(args, flag) {
  return args.includes(flag);
}

function hasValueFlag(args, flag) {
  return args.includes(flag) || args.some((item) => item.startsWith(`${flag}=`));
}

function flagValue(args, flag) {
  const equal = args.find((item) => item.startsWith(`${flag}=`));
  if (equal) {
    return equal.slice(flag.length + 1);
  }
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] || '' : '';
}

function processManager(options) {
  return options.processManager || defaultProcessManager;
}

function processOptions(options) {
  return {
    ...options,
    paths: resolveRuntimePaths(options)
  };
}

function launchAgent(options) {
  return options.launchAgent || defaultLaunchAgent;
}

async function pathExists(fileSystem, filePath) {
  if (!filePath) {
    return false;
  }
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

async function hasInstalledLaunchAgent(options, paths) {
  if (paths.platform !== 'darwin') {
    return false;
  }
  const fileSystem = options.fs || fs;
  return (await pathExists(fileSystem, paths.launchAgentPath)) ||
    (await pathExists(fileSystem, paths.relayLaunchAgentPath));
}

async function relayEnabledOptions(options, paths) {
  const relayState = await readRelayLaunchAgentState({ ...options, paths });
  return {
    ...options,
    paths,
    relayConfigured: relayState.configured
  };
}

async function runLaunchAgentStart(options, command = 'start') {
  const paths = resolveRuntimePaths(options);
  const output = await launchAgent(options).enableMacLaunchAgent(
    await relayEnabledOptions(options, paths)
  );
  return {
    code: output.ok === false ? 1 : 0,
    output: { command, ok: output.ok !== false, service: 'launch-agent', enable: output }
  };
}

export async function runStart(options) {
  const paths = resolveRuntimePaths(options);
  if (await hasInstalledLaunchAgent(options, paths)) {
    return runLaunchAgentStart(options, 'start');
  }
  return {
    code: 0,
    output: await processManager(options).startManagedServer({ ...options, paths })
  };
}

export async function runStop(options) {
  const paths = resolveRuntimePaths(options);
  if (await hasInstalledLaunchAgent(options, paths)) {
    const output = await launchAgent(options).disableMacLaunchAgent({ ...options, paths });
    return {
      code: output.ok === false ? 1 : 0,
      output: { command: 'stop', ok: output.ok !== false, service: 'launch-agent', disable: output }
    };
  }
  const output = await processManager(options).stopManagedServer({ ...options, paths });
  return {
    code: output.ok === false ? 1 : 0,
    output
  };
}

export async function runRestart(options) {
  const paths = resolveRuntimePaths(options);
  if (await hasInstalledLaunchAgent(options, paths)) {
    return runLaunchAgentStart(options, 'restart');
  }
  const output = await processManager(options).restartManagedServer({ ...options, paths });
  return {
    code: output.ok === false ? 1 : 0,
    output
  };
}

export async function runLogs(options) {
  return {
    code: 0,
    output: await processManager(options).readManagedLogs(processOptions(options))
  };
}

export async function runInstall(args, options) {
  const paths = resolveRuntimePaths(options);
  const helperOptions = {
    ...(await relayEnabledOptions(options, paths)),
    nodePath: options.nodePath || process.execPath,
    cliPath: options.cliPath || DEFAULT_CLI_PATH,
    relayClientPath: options.relayClientPath || DEFAULT_RELAY_CLIENT_PATH
  };
  if (!hasFlag(args, '--dry-run')) {
    const output = await launchAgent(options).installMacLaunchAgent(helperOptions);
    return {
      code: output.ok === false ? 1 : 0,
      output
    };
  }
  return {
    code: 0,
    output: launchAgent(options).buildMacInstallPlan({
      ...helperOptions,
      dryRun: true
    })
  };
}

export async function runUninstall(args, options) {
  const output = await launchAgent(options).uninstallMacLaunchAgent({
    ...options,
    paths: resolveRuntimePaths(options),
    removeData: hasFlag(args, '--remove-data'),
    confirmRemoveData: hasFlag(args, '--confirm-remove-data')
  });
  return {
    code: output.ok === false ? 1 : 0,
    output
  };
}

export async function runEnable(options) {
  const paths = resolveRuntimePaths(options);
  const output = await launchAgent(options).enableMacLaunchAgent(
    await relayEnabledOptions(options, paths)
  );
  return {
    code: output.ok === false ? 1 : 0,
    output
  };
}

export async function runDisable(options) {
  const output = await launchAgent(options).disableMacLaunchAgent({
    ...options,
    paths: resolveRuntimePaths(options)
  });
  return {
    code: output.ok === false ? 1 : 0,
    output
  };
}

function hasRelayConfigMutation(args) {
  return hasValueFlag(args, '--url') ||
    hasValueFlag(args, '--secret') ||
    hasValueFlag(args, '--local-url');
}

export async function runRelayConfig(args, options) {
  const paths = resolveRuntimePaths(options);
  if (!hasRelayConfigMutation(args)) {
    const output = await readRelayConfig({ ...options, paths, redact: true });
    return {
      code: 0,
      output
    };
  }
  const output = await saveRelayConfig({
    ...options,
    paths,
    relayUrl: flagValue(args, '--url'),
    relaySecret: flagValue(args, '--secret'),
    localUrl: flagValue(args, '--local-url')
  });
  return {
    code: output.ok === false ? 1 : 0,
    output
  };
}
