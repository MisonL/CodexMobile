import * as defaultLaunchAgent from './launch-agent.mjs';
import { DEFAULT_CLI_PATH, DEFAULT_RELAY_CLIENT_PATH } from './command-paths.mjs';
import {
  runDisable,
  runEnable,
  runInstall,
  runLogs,
  runRelayConfig,
  runRestart,
  runStart,
  runStop,
  runUninstall
} from './lifecycle-commands.mjs';
import { resolveRuntimePaths } from './paths.mjs';
import { runSetup, setupValueFlags } from './setup.mjs';
import { collectDoctorReport, collectStatusReport } from './status.mjs';

function hasFlag(args, flag) {
  return args.includes(flag);
}

function stripFlags(args) {
  const commands = [];
  const valueFlags = new Set(['--url', '--secret', '--local-url', ...setupValueFlags()]);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith('--')) {
      commands.push(arg);
      continue;
    }
    if (valueFlags.has(arg)) {
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
  if (result.code === 0 && result.output?.message) {
    writeOutput(options, result.output.message);
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

function launchAgent(options) {
  return options.launchAgent || defaultLaunchAgent;
}

function runHelp() {
  return {
    code: 0,
    output: {
      command: 'help',
      ok: true,
      commands: ['setup', 'doctor', 'status', 'install', 'install --dry-run', 'uninstall', 'enable', 'disable', 'relay-config', 'start', 'stop', 'restart', 'logs', 'serve']
    }
  };
}

async function routeCommand(command, args, options) {
  if (command === 'help' || hasFlag(args, '--help')) {
    return runHelp();
  }
  if (command === 'doctor') {
    return runDoctor(options);
  }
  if (command === 'status') {
    return runStatus(options);
  }
  if (command === 'setup') {
    const paths = resolveRuntimePaths(options);
    return runSetup(args, {
      ...options,
      paths,
      launchAgent: launchAgent(options),
      cliPath: options.cliPath || DEFAULT_CLI_PATH,
      relayClientPath: options.relayClientPath || DEFAULT_RELAY_CLIENT_PATH
    });
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
  return errorResult(`Unsupported command: ${command}`);
}

export async function runCli(args = [], options = {}) {
  const json = hasFlag(args, '--json');
  const command = stripFlags(args)[0] || 'help';
  const result = await routeCommand(command, args, options).catch((error) => {
    const details = {};
    if (Array.isArray(error.cleanup)) {
      details.cleanup = error.cleanup;
    }
    if (String(error.stderr || '').trim()) {
      details.stderr = String(error.stderr).trim();
    }
    if (String(error.stdout || '').trim()) {
      details.stdout = String(error.stdout).trim();
    }
    return errorResult(error.message, 1, details);
  });
  return emit(result, options, json);
}
