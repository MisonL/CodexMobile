import { fileURLToPath } from 'node:url';

import * as defaultLaunchAgent from './launch-agent.mjs';
import { resolveRuntimePaths } from './paths.mjs';
import * as defaultProcessManager from './process-manager.mjs';
import { readRelayLaunchAgentState, readRelayConfig, saveRelayConfig } from './relay-config.mjs';
import { collectDoctorReport, collectStatusReport } from './status.mjs';

const DEFAULT_CLI_PATH = fileURLToPath(new URL('../bin/codexmobile.mjs', import.meta.url));
const DEFAULT_RELAY_CLIENT_PATH = fileURLToPath(new URL('../scripts/relay-mac-client.mjs', import.meta.url));

function hasFlag(args, flag) {
  return args.includes(flag);
}

function flagValue(args, flag) {
  const index = args.indexOf(flag);
  if (index < 0) {
    return '';
  }
  return args[index + 1] || '';
}

function stripFlags(args) {
  const commands = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith('--')) {
      commands.push(arg);
      continue;
    }
    if (['--url', '--secret', '--local-url'].includes(arg)) {
      index += 1;
    }
  }
  return commands;
}

function writeOutput(options, text) {
  const write = options.stdout || ((value) => process.stdout.write(value));
  write(text);
}

function writeError(options, text) {
  const write = options.stderr || ((value) => process.stderr.write(value));
  write(text);
}

function emit(result, options, json) {
  if (json) {
    writeOutput(options, `${JSON.stringify(result.output, null, 2)}\n`);
    return result;
  }
  if (result.code === 0) {
    writeOutput(options, `${result.output.command}: ok\n`);
    return result;
  }
  writeError(options, `${result.error || result.output?.error || 'Command failed.'}\n`);
  return result;
}

function errorResult(message, code = 2, details = {}) {
  return {
    code,
    error: message,
    output: {
      ok: false,
      error: message,
      ...details
    }
  };
}

async function runServe() {
  await import('../server/index.js');
  return {
    code: 0,
    output: {
      command: 'serve',
      ok: true
    }
  };
}

async function runDoctor(options) {
  const output = await collectDoctorReport(options);
  return {
    code: output.ok ? 0 : 1,
    output
  };
}

async function runStatus(options) {
  return {
    code: 0,
    output: await collectStatusReport(options)
  };
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

async function runStart(options) {
  return {
    code: 0,
    output: await processManager(options).startManagedServer(processOptions(options))
  };
}

async function runStop(options) {
  const output = await processManager(options).stopManagedServer(processOptions(options));
  return {
    code: output.ok === false ? 1 : 0,
    output
  };
}

async function runRestart(options) {
  const output = await processManager(options).restartManagedServer(processOptions(options));
  return {
    code: output.ok === false ? 1 : 0,
    output
  };
}

async function runLogs(options) {
  return {
    code: 0,
    output: await processManager(options).readManagedLogs(processOptions(options))
  };
}

async function runInstall(args, options) {
  const paths = resolveRuntimePaths(options);
  const relayState = await readRelayLaunchAgentState({ ...options, paths });
  const helperOptions = {
    ...options,
    paths,
    nodePath: options.nodePath || process.execPath,
    cliPath: options.cliPath || DEFAULT_CLI_PATH,
    relayClientPath: options.relayClientPath || DEFAULT_RELAY_CLIENT_PATH,
    relayConfigured: relayState.configured
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

async function runUninstall(args, options) {
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

async function runEnable(options) {
  const paths = resolveRuntimePaths(options);
  const relayState = await readRelayLaunchAgentState({ ...options, paths });
  const output = await launchAgent(options).enableMacLaunchAgent({
    ...options,
    paths,
    relayConfigured: relayState.configured
  });
  return {
    code: output.ok === false ? 1 : 0,
    output
  };
}

async function runDisable(options) {
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
  return hasFlag(args, '--url') || hasFlag(args, '--secret') || hasFlag(args, '--local-url');
}

async function runRelayConfig(args, options) {
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

function runHelp() {
  return {
    code: 0,
    output: {
      command: 'help',
      ok: true,
      commands: ['doctor', 'status', 'install', 'install --dry-run', 'uninstall', 'enable', 'disable', 'relay-config', 'start', 'stop', 'restart', 'logs', 'serve']
    }
  };
}

async function routeCommand(command, args, options) {
  if (command === 'doctor') {
    return runDoctor(options);
  }
  if (command === 'status') {
    return runStatus(options);
  }
  if (command === 'install') {
    return runInstall(args, options);
  }
  if (command === 'uninstall') {
    return runUninstall(args, options);
  }
  if (command === 'enable') {
    return runEnable(options);
  }
  if (command === 'disable') {
    return runDisable(options);
  }
  if (command === 'relay-config') {
    return runRelayConfig(args, options);
  }
  if (command === 'start') {
    return runStart(options);
  }
  if (command === 'stop') {
    return runStop(options);
  }
  if (command === 'restart') {
    return runRestart(options);
  }
  if (command === 'logs') {
    return runLogs(options);
  }
  if (command === 'serve') {
    return runServe();
  }
  if (command === 'help' || hasFlag(args, '--help')) {
    return runHelp();
  }
  return errorResult(`Unsupported command: ${command}`);
}

export async function runCli(args = [], options = {}) {
  const json = hasFlag(args, '--json');
  const command = stripFlags(args)[0] || 'help';
  const result = await routeCommand(command, args, options).catch((error) => {
    const details = Array.isArray(error.cleanup) ? { cleanup: error.cleanup } : {};
    return errorResult(error.message, 1, details);
  });
  return emit(result, options, json);
}
