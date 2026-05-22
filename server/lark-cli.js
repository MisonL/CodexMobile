import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildFeishuSkillInstruction } from './feishu-skills.js';
import { AUTH_DOMAINS } from './lark-cli-definitions.js';
import { CODEXMOBILE_LARK_AGENT_DIR, CODEXMOBILE_LARK_GUARD_DIR, CODEXMOBILE_STATE_DIR, ROOT_DIR } from './runtime-paths.js';
import {
  LARK_CLI,
  larkCliEnvironment,
  larkCliSpawnOptions,
  larkError,
  prependPathEntry,
  redacted,
  resolveLarkCliCommand,
  runLarkCli
} from './lark-cli-runner.js';
import {
  envValue,
  getLarkDocsStatusState,
  larkCliVersion,
  larkConfigStatus,
  resetLarkDocsStatusCache
} from './lark-cli-status.js';

let authRun = null;
let agentConfigPreparedAt = 0;

export { larkCliEnvironment };

async function ensureAgentLarkConfigDir() {
  const sourceRoot = path.join(os.homedir(), '.lark-cli');
  const sourceProfile = path.join(sourceRoot, 'openclaw');
  const targetRoot = CODEXMOBILE_LARK_AGENT_DIR;
  const targetProfile = path.join(targetRoot, 'openclaw');
  const now = Date.now();

  if (now - agentConfigPreparedAt < 5000) {
    return targetRoot;
  }

  await fs.mkdir(targetProfile, { recursive: true });
  await fs.cp(sourceProfile, targetProfile, {
    recursive: true,
    force: true,
    filter: (source) => {
      const name = path.basename(source).toLowerCase();
      return !['locks', 'cache', 'logs'].includes(name);
    }
  });
  await Promise.all([
    fs.mkdir(path.join(targetProfile, 'locks'), { recursive: true }),
    fs.mkdir(path.join(targetProfile, 'cache'), { recursive: true }),
    fs.mkdir(path.join(targetProfile, 'logs'), { recursive: true })
  ]);
  agentConfigPreparedAt = now;
  return targetRoot;
}

async function ensureLarkCliGuardDir() {
  const guardDir = CODEXMOBILE_LARK_GUARD_DIR;
  const guardScript = path.join(ROOT_DIR, 'scripts', 'lark-cli-guard.mjs');
  const cmdPath = path.join(guardDir, 'lark-cli.cmd');
  const nodePath = process.execPath;
  await fs.mkdir(guardDir, { recursive: true });
  await fs.writeFile(
    cmdPath,
    [
      '@echo off',
      `"${nodePath}" "${guardScript}" %*`
    ].join('\r\n'),
    'utf8'
  );
  return guardDir;
}

function publicPendingAuth() {
  if (!authRun) {
    return null;
  }
  return {
    verificationUrl: authRun.verificationUrl,
    userCode: authRun.userCode,
    expiresAt: authRun.expiresAt,
    status: authRun.status,
    error: authRun.error || ''
  };
}

export async function getLarkDocsStatus(options = {}) {
  return getLarkDocsStatusState(options, publicPendingAuth);
}

async function ensureLarkConfigured() {
  const config = await larkConfigStatus();
  if (config.configReady) {
    return;
  }
  const appId = envValue('LARK_APP_ID', 'CODEXMOBILE_FEISHU_APP_ID');
  const appSecret = envValue('LARK_APP_SECRET', 'CODEXMOBILE_FEISHU_APP_SECRET');
  if (!appId || !appSecret) {
    throw larkError('缺少飞书 App ID 或 App Secret，请先配置 CODEXMOBILE_FEISHU_APP_ID / CODEXMOBILE_FEISHU_APP_SECRET。', {
      statusCode: 400
    });
  }

  const init = await runLarkCli(
    ['config', 'init', '--app-id', appId, '--app-secret-stdin', '--brand', 'feishu'],
    { input: `${appSecret}\n`, timeoutMs: 30000 }
  );
  if (!init.ok) {
    throw larkError(init.error || 'lark-cli 配置失败', { statusCode: 502 });
  }
}

async function setDefaultAsUser() {
  const result = await runLarkCli(['config', 'default-as', 'user'], { timeoutMs: 10000 });
  if (!result.ok) {
    console.warn('[lark-cli] failed to set default identity:', result.error || result.stderr || result.stdout);
  }
}

function extractUserCode(verificationUrl) {
  try {
    return new URL(verificationUrl).searchParams.get('user_code') || '';
  } catch {
    return '';
  }
}

async function startDevicePoll(deviceCode) {
  let child = null;
  try {
    const command = await resolveLarkCliCommand();
    const spawnOptions = larkCliSpawnOptions(command, ['auth', 'login', '--device-code', deviceCode]);
    child = spawn(spawnOptions.command, spawnOptions.args, {
      env: larkCliEnvironment(),
      windowsHide: true,
      windowsVerbatimArguments: spawnOptions.windowsVerbatimArguments
    });
  } catch (error) {
    authRun.status = 'failed';
    authRun.error = redacted(error.message);
    return;
  }
  authRun.process = child;
  authRun.status = 'polling';

  let stdout = '';
  let stderr = '';
  const finish = async (status, error = '') => {
    if (!authRun) {
      return;
    }
    authRun.status = status;
    authRun.error = error;
    authRun.process = null;
    resetLarkDocsStatusCache();
    if (status === 'connected') {
      await setDefaultAsUser();
    }
  };

  child.stdout?.on('data', (chunk) => {
    stdout += chunk.toString('utf8');
  });
  child.stderr?.on('data', (chunk) => {
    stderr += chunk.toString('utf8');
  });
  child.on('error', (error) => {
    finish('failed', redacted(error.message));
  });
  child.on('close', (code) => {
    if (code === 0) {
      finish('connected');
      return;
    }
    finish('failed', redacted(stderr || stdout || `lark-cli auth login exited with code ${code}`));
  });
}

export async function startLarkCliAuth() {
  const cli = await larkCliVersion();
  if (!cli.installed) {
    throw larkError('未安装 lark-cli，请先安装 @larksuite/cli。', { statusCode: 400 });
  }

  await ensureLarkConfigured();
  await setDefaultAsUser();

  if (authRun?.status === 'polling' && Date.now() < authRun.expiresAt) {
    return {
      verificationUrl: authRun.verificationUrl,
      userCode: authRun.userCode,
      expiresAt: authRun.expiresAt,
      status: authRun.status
    };
  }

  const args = ['auth', 'login', '--recommend', '--no-wait', '--json'];
  for (const domain of AUTH_DOMAINS) {
    args.push('--domain', domain);
  }
  const result = await runLarkCli(args, { timeoutMs: 30000 });
  if (!result.ok || !result.json?.device_code || !result.json?.verification_url) {
    throw larkError(result.error || '获取飞书授权地址失败', { statusCode: 502 });
  }

  authRun = {
    deviceCode: result.json.device_code,
    verificationUrl: result.json.verification_url,
    userCode: extractUserCode(result.json.verification_url),
    expiresAt: Date.now() + Math.max(0, Number(result.json.expires_in || 600)) * 1000,
    status: 'pending',
    error: '',
    process: null
  };
  await startDevicePoll(authRun.deviceCode);
  resetLarkDocsStatusCache();

  return {
    verificationUrl: authRun.verificationUrl,
    userCode: authRun.userCode,
    expiresAt: authRun.expiresAt,
    status: authRun.status
  };
}

export async function logoutLarkCli() {
  if (authRun?.process) {
    authRun.process.kill();
  }
  authRun = null;
  const result = await runLarkCli(['auth', 'logout'], { timeoutMs: 15000 });
  resetLarkDocsStatusCache();
  if (!result.ok && !/no logged-in users/i.test(result.stdout || result.stderr || result.error || '')) {
    throw larkError(result.error || '断开飞书授权失败', { statusCode: 502 });
  }
  return true;
}

export async function buildCodexLarkCliContext(message = '') {
  const status = await getLarkDocsStatus({ authenticated: true, force: false }).catch(() => null);
  const enabled = Boolean(status?.codexEnabled);
  const requestedInstruction = await buildFeishuSkillInstruction(message);
  const instruction = enabled
    ? requestedInstruction
    : requestedInstruction
      ? [
          'CodexMobile Feishu/Lark was requested, but the integration is not currently authorized.',
          'Do not run lark-cli commands. Reply in concise Chinese that Feishu authorization has expired or is unavailable, and ask the user to open the top-right Docs panel and reconnect Feishu.'
        ].join('\n')
      : '';
  const env = larkCliEnvironment();
  if (enabled) {
    const configRoot = await ensureAgentLarkConfigDir();
    const realCli = await resolveLarkCliCommand();
    env.LARKSUITE_CLI_CONFIG_DIR = configRoot;
    env.LARKSUITE_CLI_LOG_DIR = path.join(configRoot, 'openclaw', 'logs');
    env.LARKSUITE_CLI_NO_UPDATE_NOTIFIER = '1';
    if (realCli && realCli !== LARK_CLI) {
      const guardDir = await ensureLarkCliGuardDir();
      env.CODEXMOBILE_REAL_LARK_CLI = realCli;
      env.CODEXMOBILE_LARK_GUARD_STATE_DIR = CODEXMOBILE_STATE_DIR;
      prependPathEntry(env, guardDir);
    }
  }
  return {
    enabled,
    env,
    instruction
  };
}
