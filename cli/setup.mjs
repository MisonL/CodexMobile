import { createInterface } from 'node:readline/promises';

import { collectDoctorReport, collectStatusReport } from './status.mjs';
import { clearRelayConfig, readRelayConfig, saveRelayConfig } from './relay-config.mjs';
import { takeOverPort } from './service-takeover.mjs';
import * as defaultProcessManager from './process-manager.mjs';

const DEFAULT_LOCAL_URL = 'http://127.0.0.1:3321';
const DEFAULT_SPACE_URL = 'https://misonl-codexmobile-relay.hf.space';
const SETUP_VALUE_FLAGS = new Set([
  '--space-url',
  '--relay-url',
  '--url',
  '--secret',
  '--local-url'
]);

export function setupValueFlags() {
  return [...SETUP_VALUE_FLAGS];
}

function hasFlag(args, flag) {
  return args.includes(flag);
}

function flagValue(args, flag) {
  const equal = args.find((item) => item.startsWith(`${flag}=`));
  if (equal) {
    return equal.slice(flag.length + 1);
  }
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] || '' : '';
}

export function relayUrlFromSpaceUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) {
    return '';
  }
  const url = new URL(raw);
  if (url.protocol === 'https:') {
    url.protocol = 'wss:';
  } else if (url.protocol === 'http:') {
    url.protocol = 'ws:';
  }
  if (!['ws:', 'wss:'].includes(url.protocol)) {
    throw new Error('spaceUrl must use http, https, ws, or wss.');
  }
  url.pathname = '/relay/mac';
  url.search = '';
  url.hash = '';
  return url.toString();
}

function parseSetupArgs(args) {
  const spaceUrl = flagValue(args, '--space-url');
  return {
    dryRun: hasFlag(args, '--dry-run'),
    yes: hasFlag(args, '--yes'),
    noInstall: hasFlag(args, '--no-install'),
    noRelay: hasFlag(args, '--no-relay'),
    relayUrl: flagValue(args, '--relay-url') || flagValue(args, '--url') ||
      (spaceUrl ? relayUrlFromSpaceUrl(spaceUrl) : ''),
    spaceUrl,
    relaySecret: flagValue(args, '--secret'),
    localUrl: flagValue(args, '--local-url') || DEFAULT_LOCAL_URL
  };
}

async function ask(options, question, defaultValue = '') {
  if (typeof options.prompt === 'function') {
    return options.prompt({ question, defaultValue });
  }
  const input = options.stdin || process.stdin;
  const output = options.stdoutStream || process.stdout;
  if (!input.isTTY || !output.isTTY) {
    throw new Error(`${question} is required. Pass a flag or run interactively.`);
  }
  const suffix = defaultValue ? ` [${defaultValue}]` : '';
  const rl = createInterface({ input, output });
  try {
    const answer = await rl.question(`${question}${suffix}: `);
    return String(answer || defaultValue).trim();
  } finally {
    rl.close();
  }
}

async function askYesNo(options, question, defaultYes = true) {
  if (typeof options.confirm === 'function') {
    return options.confirm({ question, defaultYes });
  }
  const answer = await ask(options, `${question} ${defaultYes ? '[Y/n]' : '[y/N]'}`, '');
  if (!answer) {
    return defaultYes;
  }
  return /^y(es)?$/i.test(answer.trim());
}

async function resolveRelayValues(args, existing, options) {
  if (args.noRelay) {
    return { configured: false, skipped: true };
  }
  const current = existing.config || {};
  let relayUrl = args.relayUrl || current.relayUrl || '';
  let relaySecret = args.relaySecret || current.relaySecret || '';
  const localUrl = args.localUrl || current.localUrl || DEFAULT_LOCAL_URL;
  if (!relayUrl && !args.yes && !args.dryRun) {
    const spaceUrl = await ask(options, 'Space URL', args.spaceUrl || DEFAULT_SPACE_URL);
    relayUrl = relayUrlFromSpaceUrl(spaceUrl);
  }
  if (!relayUrl) {
    relayUrl = relayUrlFromSpaceUrl(args.spaceUrl || DEFAULT_SPACE_URL);
  }
  if (!relaySecret && !args.yes && !args.dryRun) {
    relaySecret = await ask(options, 'Relay secret', '');
  }
  if (!relaySecret && !args.dryRun) {
    throw new Error('Relay secret is required. Pass --secret or --no-relay.');
  }
  return { configured: Boolean(relayUrl && relaySecret), relayUrl, relaySecret, localUrl };
}

function setupMessage(output) {
  const lines = [
    'CodexMobile setup complete.',
    `Server service: ${output.install?.installed ? 'installed' : 'skipped'}`,
    `Relay connector: ${output.relayConfigured ? 'configured' : 'not configured'}`,
    `Port takeover: ${output.takeover?.action || 'none'}`,
    `Status: node=${output.doctor?.node?.status || 'unknown'} codex=${output.doctor?.checks?.codexConfig?.status || 'unknown'}`,
    `Logs: ${output.paths.logDir}`
  ];
  return `${lines.join('\n')}\n`;
}

function dryRunOutput({ paths, doctor, relayValues, takeover }) {
  return {
    command: 'setup',
    ok: true,
    dryRun: true,
    relayConfigured: relayValues.configured,
    takeover,
    doctor,
    paths,
    message: [
      'CodexMobile setup dry run complete.',
      `Relay connector: ${relayValues.configured ? 'would be configured' : 'not configured'}`,
      `Port takeover: ${takeover.action || 'none'}`,
      `Logs: ${paths.logDir}`
    ].join('\n') + '\n'
  };
}

function defaultTakeover(preStatus) {
  return {
    ok: true,
    action: preStatus.launchAgent?.loaded ? 'launch-agent-running' : 'none',
    port: 3321,
    owners: []
  };
}

async function resolveTakeover({ options, paths, parsed, preStatus, takeOver }) {
  if (preStatus.launchAgent?.loaded) {
    const takeover = await takeOver({
      ...options,
      paths,
      validateOnly: true,
      port: 3321
    });
    if (takeover.action === 'verified') {
      return { ...takeover, action: 'launch-agent-verified' };
    }
    return takeover;
  }

  const takeover = await takeOver({
    ...options,
    paths,
    yes: parsed.yes,
    confirm: parsed.dryRun,
    dryRun: parsed.dryRun,
    port: 3321
  });
  if (takeover.action === 'confirm-required' && !parsed.dryRun) {
    const confirm = await askYesNo(options, 'Stop unmanaged CodexMobile server on port 3321?', true);
    return takeOver({ ...options, paths, confirm, port: 3321 });
  }
  return takeover;
}

async function saveRelayValues({ options, paths, existing, relayValues }) {
  if (relayValues.skipped) {
    return clearRelayConfig({ ...options, paths });
  }
  if (!relayValues.configured) {
    return existing;
  }
  return saveRelayConfig({ ...options, paths, ...relayValues });
}

async function installSetupServices({ options, paths, parsed, relayConfig }) {
  if (parsed.noInstall) {
    return { command: 'install', ok: true, installed: false, skipped: true };
  }
  return options.launchAgent.installMacLaunchAgent({
    ...options,
    paths,
    nodePath: options.nodePath || process.execPath,
    cliPath: options.cliPath,
    relayClientPath: options.relayClientPath,
    relayConfigured: relayConfig.configured
  });
}

function setupOutput({ paths, doctor, takeover, relayConfig, install, status }) {
  const output = {
    command: 'setup',
    ok: install.ok !== false,
    relayConfigured: relayConfig.configured,
    relayConfigPath: paths.relayConfigPath,
    takeover,
    install,
    status,
    doctor,
    paths
  };
  output.message = setupMessage(output);
  return output;
}

export async function runSetup(args = [], options = {}) {
  const parsed = parseSetupArgs(args);
  const paths = options.paths;
  const doctor = await collectDoctorReport({ ...options, paths });
  if (!doctor.ok && !parsed.dryRun) {
    return {
      code: 1,
      output: { command: 'setup', ok: false, error: 'Doctor checks failed.', doctor, paths }
    };
  }
  const existing = await readRelayConfig({ ...options, paths, redact: false });
  const relayValues = await resolveRelayValues(parsed, existing, options);
  const takeover = await resolveTakeover({
    options,
    paths,
    parsed,
    preStatus: await collectStatusReport({ ...options, paths }),
    takeOver: options.takeOverPort || takeOverPort
  });
  if (!takeover.ok && !parsed.dryRun) {
    return { code: 1, output: { command: 'setup', ok: false, error: takeover.error, takeover, paths } };
  }
  if (parsed.dryRun) {
    return { code: 0, output: dryRunOutput({ paths, doctor, relayValues, takeover }) };
  }
  const processManager = options.processManager || defaultProcessManager;
  await processManager.removeManagedState?.({ ...options, paths });
  const relayConfig = await saveRelayValues({ options, paths, existing, relayValues });
  if (relayConfig.ok === false) {
    return { code: 1, output: { command: 'setup', ok: false, error: relayConfig.error, relayConfig, paths } };
  }
  const install = await installSetupServices({ options, paths, parsed, relayConfig });
  const output = setupOutput({
    paths,
    doctor,
    takeover,
    relayConfig,
    install,
    status: await collectStatusReport({ ...options, paths })
  });
  return { code: output.ok ? 0 : 1, output };
}
