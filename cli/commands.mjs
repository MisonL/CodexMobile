import { fileURLToPath } from 'node:url';

import { buildMacInstallPlan } from './launch-agent.mjs';
import { resolveRuntimePaths } from './paths.mjs';
import * as defaultProcessManager from './process-manager.mjs';
import {
  collectDoctorReport,
  collectStatusReport
} from './status.mjs';

const DEFAULT_CLI_PATH = fileURLToPath(new URL('../bin/codexmobile.mjs', import.meta.url));

function hasFlag(args, flag) {
  return args.includes(flag);
}

function stripFlags(args) {
  return args.filter((arg) => !arg.startsWith('--'));
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
  writeError(options, `${result.error}\n`);
  return result;
}

function errorResult(message, code = 2) {
  return {
    code,
    error: message,
    output: {
      ok: false,
      error: message
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

function runInstall(args, options) {
  if (!hasFlag(args, '--dry-run')) {
    return errorResult('install currently requires --dry-run.');
  }
  return {
    code: 0,
    output: buildMacInstallPlan({
      paths: resolveRuntimePaths(options),
      nodePath: options.nodePath || process.execPath,
      cliPath: options.cliPath || DEFAULT_CLI_PATH,
      dryRun: true
    })
  };
}

function runHelp() {
  return {
    code: 0,
    output: {
      command: 'help',
      ok: true,
      commands: ['doctor', 'status', 'install --dry-run', 'start', 'stop', 'restart', 'logs', 'serve']
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
    return errorResult(error.message, 1);
  });
  return emit(result, options, json);
}
