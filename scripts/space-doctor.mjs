import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT_DIR = path.resolve(import.meta.dirname, '..');

function parseArgs(argv) {
  const options = {
    remote: readEnv('CODEXMOBILE_HF_SPACE_REMOTE')
  };
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === '--remote') {
      const value = argv[index + 1];
      if (!value) {
        throw new Error('--remote requires a git remote URL.');
      }
      options.remote = value;
      index += 1;
      continue;
    }
    if (item.startsWith('--remote=')) {
      options.remote = item.slice('--remote='.length);
      continue;
    }
    throw new Error(`Unknown argument: ${item}`);
  }
  return options;
}

function hasCommand(command) {
  const which = process.platform === 'win32' ? 'where' : 'which';
  const args = [command];
  try {
    const child = spawnSync(which, args, { stdio: 'pipe' });
    return child.status === 0;
  } catch {
    return false;
  }
}

function readEnv(name) {
  return String(process.env[name] || '').trim();
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const report = {
    root: ROOT_DIR,
    env: {
      CODEXMOBILE_RELAY_URL: readEnv('CODEXMOBILE_RELAY_URL'),
      CODEXMOBILE_RELAY_SECRET: Boolean(readEnv('CODEXMOBILE_RELAY_SECRET')),
      HF_TOKEN: Boolean(readEnv('HF_TOKEN')),
      HUGGINGFACE_HUB_TOKEN: Boolean(readEnv('HUGGINGFACE_HUB_TOKEN')),
      CODEXMOBILE_HF_SPACE_REMOTE: Boolean(readEnv('CODEXMOBILE_HF_SPACE_REMOTE'))
    },
    input: {
      remote: Boolean(options.remote)
    },
    commands: {
      hf: hasCommand('hf'),
      huggingfaceCli: hasCommand('huggingface-cli'),
      gh: hasCommand('gh')
    },
    files: {
      spacePrepare: fs.existsSync(path.join(ROOT_DIR, 'scripts', 'prepare-hf-space.mjs')),
      spaceDeploy: fs.existsSync(path.join(ROOT_DIR, 'scripts', 'deploy-hf-space.mjs')),
      runbook: fs.existsSync(path.join(ROOT_DIR, 'docs', 'relay-deployment-runbook.md'))
    }
  };

  console.log(JSON.stringify(report, null, 2));

  const missing = [];
  if (!report.env.CODEXMOBILE_RELAY_URL) missing.push('CODEXMOBILE_RELAY_URL');
  if (!report.env.CODEXMOBILE_RELAY_SECRET) missing.push('CODEXMOBILE_RELAY_SECRET');
  if (!report.input.remote) missing.push('HuggingFace Space git remote');
  if (!report.env.HF_TOKEN && !report.env.HUGGINGFACE_HUB_TOKEN) {
    missing.push('HF_TOKEN/HUGGINGFACE_HUB_TOKEN or an authenticated git credential helper');
  }
  if (missing.length) {
    process.exitCode = 1;
    console.error(`Missing: ${missing.join(', ')}`);
  }
}

main();
