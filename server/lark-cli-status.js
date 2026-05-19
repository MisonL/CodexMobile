import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  CAPABILITIES,
  REQUIRED_SCOPE_GROUPS,
  REQUIRED_SKILLS,
  STATUS_CACHE_MS
} from './lark-cli-definitions.js';
import { runLarkCli } from './lark-cli-runner.js';

let statusCache = { at: 0, value: null };

export function resetLarkDocsStatusCache() {
  statusCache = { at: 0, value: null };
}

export function envValue(...keys) {
  for (const key of keys) {
    const value = String(process.env[key] || '').trim();
    if (value) {
      return value;
    }
  }
  return '';
}

function parseScopes(value) {
  if (Array.isArray(value)) {
    return value.map((scope) => String(scope || '').trim()).filter(Boolean);
  }
  return String(value || '')
    .split(/\s+/)
    .map((scope) => scope.trim())
    .filter(Boolean);
}

function larkScopeStatus(grantedScopes = []) {
  const granted = new Set(grantedScopes);
  const groups = REQUIRED_SCOPE_GROUPS.map((group) => {
    const missing = group.scopes.filter((scope) => !granted.has(scope));
    return {
      id: group.id,
      label: group.label,
      ok: missing.length === 0,
      missing
    };
  });
  return {
    groups,
    missingScopes: groups.flatMap((group) => group.missing),
    slidesAuthorized: Boolean(groups.find((group) => group.id === 'slides')?.ok),
    sheetsAuthorized: Boolean(groups.find((group) => group.id === 'sheets')?.ok)
  };
}

export async function larkCliVersion() {
  const result = await runLarkCli(['--version'], { timeoutMs: 8000 });
  if (!result.ok) {
    return { installed: false, version: '', error: result.error || result.stderr };
  }
  const match = result.stdout.match(/(\d+\.\d+\.\d+)/);
  return { installed: true, version: match?.[1] || result.stdout.trim(), error: '' };
}

async function larkSkillsInstalled() {
  const root = path.join(os.homedir(), '.agents', 'skills');
  const missing = [];
  for (const skill of REQUIRED_SKILLS) {
    try {
      await fs.access(path.join(root, skill, 'SKILL.md'));
    } catch {
      missing.push(skill);
    }
  }
  return {
    installed: missing.length === 0,
    missing,
    root
  };
}

export async function larkConfigStatus() {
  const appId = envValue('LARK_APP_ID', 'CODEXMOBILE_FEISHU_APP_ID');
  const appSecret = envValue('LARK_APP_SECRET', 'CODEXMOBILE_FEISHU_APP_SECRET');
  const show = await runLarkCli(['config', 'show'], { timeoutMs: 10000 });
  const config = show.json || {};
  return {
    configured: show.ok || Boolean(appId && appSecret),
    configReady: show.ok,
    appId: config.appId || appId || '',
    brand: config.brand || 'feishu',
    defaultAs: config.defaultAs || '',
    workspace: config.workspace || '',
    hasEnvCredentials: Boolean(appId && appSecret),
    error: show.ok ? '' : show.error || show.stderr || show.stdout
  };
}

function authUserFromStatus(data) {
  const candidate = data?.user || data?.currentUser || data?.current_user || data || {};
  const name =
    candidate.name ||
    candidate.userName ||
    candidate.user_name ||
    candidate.enName ||
    candidate.en_name ||
    candidate.email ||
    candidate.openId ||
    candidate.open_id ||
    candidate.userOpenId ||
    '';
  return name
    ? {
        name,
        email: candidate.email || candidate.enterpriseEmail || candidate.enterprise_email || '',
        openId: candidate.openId || candidate.open_id || candidate.userOpenId || candidate.user_open_id || ''
      }
    : null;
}

async function larkAuthStatusRaw() {
  const result = await runLarkCli(['auth', 'status'], { timeoutMs: 10000 });
  const data = result.json || {};
  const text = `${result.stdout}\n${result.stderr}\n${result.error || ''}`;
  const noUser = /no user logged in|only bot/i.test(text);
  const connected = Boolean(result.ok && !noUser && (data.identity === 'user' || data.user || data.currentUser || data.openId || data.open_id));
  return {
    connected,
    identity: data.identity || '',
    defaultAs: data.defaultAs || '',
    user: connected ? authUserFromStatus(data) || { name: '已授权用户', email: '', openId: '' } : null,
    scopes: parseScopes(data.scope || data.scopes),
    tokenStatus: data.tokenStatus || data.token_status || '',
    expiresAt: data.expiresAt || data.expires_at || '',
    refreshExpiresAt: data.refreshExpiresAt || data.refresh_expires_at || '',
    error: result.ok ? '' : result.error || result.stderr || result.stdout,
    note: data.note || ''
  };
}

async function larkAuthStatus() {
  const auth = await larkAuthStatusRaw();
  const tokenStatus = String(auth.tokenStatus || '');
  if (!auth.connected || !/needs_refresh|expired/i.test(tokenStatus)) {
    return auth;
  }
  const verifiedResult = await runLarkCli(['auth', 'status', '--verify'], { timeoutMs: 15000 });
  const verifiedData = verifiedResult.json || {};
  const verified = verifiedData.verified;
  const verifyError = verifiedData.verifyError || verifiedData.verify_error || verifiedResult.error || verifiedResult.stderr || '';
  const requiresReauth =
    verified === false &&
    /need_user_authorization|invalid_grant|token unusable|20064/i.test(String(verifyError || ''));
  return {
    ...auth,
    connected: requiresReauth ? false : auth.connected,
    user: requiresReauth ? null : auth.user,
    verified,
    verifyError,
    error: requiresReauth ? verifyError || 'Feishu authorization expired' : auth.error
  };
}

export async function getLarkDocsStatusState(options = {}, pendingAuth = () => null) {
  const { authenticated = true, force = false } = options;
  const now = Date.now();
  if (!force && statusCache.value && now - statusCache.at <= STATUS_CACHE_MS) {
    return authenticated ? statusCache.value : { ...statusCache.value, connected: false, user: null, authPending: null };
  }
  const cli = await larkCliVersion();
  const skills = await larkSkillsInstalled();
  const config = cli.installed
    ? await larkConfigStatus()
    : {
        configured: Boolean(envValue('LARK_APP_ID', 'CODEXMOBILE_FEISHU_APP_ID') && envValue('LARK_APP_SECRET', 'CODEXMOBILE_FEISHU_APP_SECRET')),
        configReady: false,
        appId: envValue('LARK_APP_ID', 'CODEXMOBILE_FEISHU_APP_ID'),
        brand: 'feishu',
        defaultAs: '',
        workspace: '',
        hasEnvCredentials: Boolean(envValue('LARK_APP_ID', 'CODEXMOBILE_FEISHU_APP_ID') && envValue('LARK_APP_SECRET', 'CODEXMOBILE_FEISHU_APP_SECRET')),
        error: cli.error
      };
  const auth = authenticated && cli.installed && config.configured
    ? await larkAuthStatus()
    : { connected: false, user: null, identity: '', defaultAs: '', note: '', error: '', scopes: [] };
  const enabled = Boolean(cli.installed && skills.installed && config.configured && auth.connected);
  const scopeStatus = enabled
    ? larkScopeStatus(auth.scopes)
    : { groups: [], missingScopes: [], slidesAuthorized: false, sheetsAuthorized: false };
  const authorizationReady = enabled && scopeStatus.missingScopes.length === 0;
  const capabilities = enabled
    ? CAPABILITIES.filter((capability) => {
        if (capability.id.startsWith('slides.')) {
          return scopeStatus.slidesAuthorized;
        }
        if (capability.id.startsWith('sheets.')) {
          return scopeStatus.sheetsAuthorized;
        }
        return true;
      })
    : [];
  const status = {
    provider: 'feishu',
    integration: 'lark-cli',
    label: '飞书文档',
    configured: config.configured,
    configReady: config.configReady,
    connected: authenticated ? auth.connected : false,
    user: authenticated ? auth.user : null,
    cliInstalled: cli.installed,
    cliVersion: cli.version,
    skillsInstalled: skills.installed,
    missingSkills: skills.missing,
    identity: auth.identity || config.defaultAs || '',
    defaultAs: auth.defaultAs || config.defaultAs || '',
    workspace: config.workspace,
    homeUrl: process.env.CODEXMOBILE_FEISHU_DOCS_URL || 'https://docs.feishu.cn/',
    capabilities,
    codexEnabled: enabled,
    authorizationReady,
    scopeGroups: authenticated ? scopeStatus.groups : [],
    missingScopes: authenticated ? scopeStatus.missingScopes : [],
    slidesAuthorized: authenticated ? scopeStatus.slidesAuthorized : false,
    sheetsAuthorized: authenticated ? scopeStatus.sheetsAuthorized : false,
    tokenStatus: authenticated ? auth.tokenStatus : '',
    expiresAt: authenticated ? auth.expiresAt : '',
    authPending: authenticated ? pendingAuth() : null,
    error: cli.error || config.error || auth.error || ''
  };
  if (authenticated) {
    statusCache = { at: now, value: status };
  }
  return authenticated ? status : { ...status, connected: false, user: null, authPending: null };
}
