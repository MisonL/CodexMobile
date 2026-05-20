import fs from 'node:fs/promises';
import path from 'node:path';
import { CODEX_USAGE_URL, MANAGEMENT_TIMEOUT_MS, REQUEST_TIMEOUT_MS, resolveAuthDir, resolveManagementBaseUrl, resolveManagementKey } from './codex-quota-config.js';
import {
  authEntryAccountId,
  authEntryName,
  authEntryPlan,
  extractQuotaWindows,
  maskAccount,
  normalizePlan,
  planFromFileName,
  safeId
} from './codex-quota-normalize.js';

export async function readJsonFile(filePath) {
  const raw = await fs.readFile(filePath, 'utf8');
  return JSON.parse(raw);
}

export function safeErrorMessage(error) {
  const status = error?.statusCode || error?.status;
  if (status) {
    return `HTTP ${status}`;
  }
  if (error?.name === 'AbortError') {
    return '请求超时';
  }
  return '查询失败';
}

export async function requestCodexUsage(credential) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(CODEX_USAGE_URL, {
      method: 'GET',
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${credential.access_token}`,
        'Chatgpt-Account-Id': credential.account_id,
        'Content-Type': 'application/json',
        'User-Agent': 'codex_cli_rs/0.76.0 (Debian 13.0.0; x86_64) WindowsTerminal'
      }
    });
    const text = await response.text();
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    if (!response.ok) {
      const error = new Error('Codex quota request failed');
      error.statusCode = response.status;
      throw error;
    }
    return body;
  } finally {
    clearTimeout(timeout);
  }
}

export async function managementJson(baseUrl, managementKey, route, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), MANAGEMENT_TIMEOUT_MS);
  try {
    const headers = {
      'X-Management-Key': managementKey,
      ...(options.headers || {})
    };
    const response = await fetch(`${baseUrl}${route}`, {
      ...options,
      signal: controller.signal,
      headers
    });
    const text = await response.text();
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    if (!response.ok) {
      const error = new Error(body?.error || `CLIProxyAPI management HTTP ${response.status}`);
      error.statusCode = response.status;
      throw error;
    }
    return body;
  } finally {
    clearTimeout(timeout);
  }
}

export async function managementApiCall(baseUrl, managementKey, authIndex, accountId) {
  const response = await managementJson(baseUrl, managementKey, '/v0/management/api-call', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      authIndex,
      method: 'GET',
      url: CODEX_USAGE_URL,
      header: {
        Authorization: 'Bearer $TOKEN$',
        'Chatgpt-Account-Id': accountId,
        'Content-Type': 'application/json',
        'User-Agent': 'codex_cli_rs/0.76.0 (Debian 13.0.0; x86_64) WindowsTerminal'
      }
    })
  });
  const statusCode = Number(response?.status_code ?? response?.statusCode ?? 0);
  const rawBody = response?.body ?? response?.bodyText ?? '';
  let body = null;
  try {
    body = rawBody ? JSON.parse(rawBody) : null;
  } catch {
    body = null;
  }
  if (statusCode < 200 || statusCode >= 300) {
    const error = new Error(body?.error?.message || body?.error || `Codex quota HTTP ${statusCode || 'unknown'}`);
    error.statusCode = statusCode || 502;
    throw error;
  }
  return body;
}

export function baseAccount(fileName, credential) {
  const email = credential.email || fileName.replace(/^codex-/, '').replace(/-[^-]+\.json$/, '');
  return {
    id: safeId(credential.account_id, credential.email, fileName),
    label: maskAccount(email),
    plan: normalizePlan(credential.plan_type || credential.planType, planFromFileName(fileName)),
    disabled: Boolean(credential.disabled),
    status: 'ok',
    windows: []
  };
}

export function baseAccountFromAuthEntry(entry) {
  const name = authEntryName(entry);
  const email = entry?.email || entry?.account || entry?.label || name.replace(/^codex-/, '').replace(/-[^-]+\.json$/i, '');
  return {
    id: safeId(entry?.auth_index || entry?.authIndex, entry?.id, email, name),
    label: maskAccount(email),
    plan: normalizePlan(authEntryPlan(entry), planFromFileName(name)),
    disabled: Boolean(entry?.disabled),
    status: 'ok',
    windows: []
  };
}

export async function quotaForFile(authDir, fileName) {
  const filePath = path.join(authDir, fileName);
  const credential = await readJsonFile(filePath);
  const account = baseAccount(fileName, credential);

  if (account.disabled) {
    return { ...account, status: 'disabled', error: '已停用' };
  }
  if (!credential.access_token || !credential.account_id) {
    return { ...account, status: 'failed', error: '凭证缺少额度查询信息' };
  }

  try {
    const usage = await requestCodexUsage(credential);
    return {
      ...account,
      plan: normalizePlan(usage?.plan_type ?? usage?.planType, account.plan),
      status: 'ok',
      windows: extractQuotaWindows(usage)
    };
  } catch (error) {
    return {
      ...account,
      status: 'failed',
      error: safeErrorMessage(error)
    };
  }
}

export async function quotaForManagementEntry(baseUrl, managementKey, entry) {
  const account = baseAccountFromAuthEntry(entry);
  if (account.disabled) {
    return { ...account, status: 'disabled', error: '宸插仠鐢?' };
  }
  const authIndex = String(entry?.auth_index || entry?.authIndex || '').trim();
  if (!authIndex) {
    return { ...account, status: 'failed', error: 'missing auth_index' };
  }
  const accountId = authEntryAccountId(entry);
  if (!accountId) {
    return { ...account, status: 'failed', error: 'missing account_id' };
  }
  try {
    const usage = await managementApiCall(baseUrl, managementKey, authIndex, accountId);
    return {
      ...account,
      plan: normalizePlan(usage?.plan_type ?? usage?.planType, account.plan),
      status: 'ok',
      windows: extractQuotaWindows(usage)
    };
  } catch (error) {
    return {
      ...account,
      status: 'failed',
      error: safeErrorMessage(error)
    };
  }
}

export async function getCodexQuotaFromManagement() {
  const managementKey = await resolveManagementKey();
  if (!managementKey) {
    return null;
  }
  const baseUrl = await resolveManagementBaseUrl();
  const payload = await managementJson(baseUrl, managementKey, '/v0/management/auth-files');
  const entries = (Array.isArray(payload?.files) ? payload.files : [])
    .filter((entry) => {
      const provider = String(entry?.provider || entry?.type || '').trim().toLowerCase();
      const name = authEntryName(entry).toLowerCase();
      return provider === 'codex' || name.startsWith('codex-');
    });
  const accounts = await Promise.all(
    entries.map((entry) => quotaForManagementEntry(baseUrl, managementKey, entry))
  );
  return {
    provider: 'cliproxyapi',
    source: 'cliproxyapi-management',
    accounts
  };
}

export async function getCodexQuota() {
  try {
    const managed = await getCodexQuotaFromManagement();
    if (managed) {
      return managed;
    }
  } catch (error) {
    console.warn(`[quota] CLIProxyAPI management quota fallback: ${safeErrorMessage(error)}`);
  }

  const authDir = await resolveAuthDir();
  let files = [];
  try {
    files = (await fs.readdir(authDir))
      .filter((fileName) => /^codex-.+\.json$/i.test(fileName))
      .sort((a, b) => a.localeCompare(b));
  } catch (error) {
    error.statusCode = 500;
    throw error;
  }

  const accounts = await Promise.all(
    files.map(async (fileName) => {
      try {
        return await quotaForFile(authDir, fileName);
      } catch {
        return {
          id: safeId(fileName),
          label: maskAccount(fileName.replace(/^codex-/, '').replace(/\.json$/, '')),
          plan: normalizePlan(planFromFileName(fileName)),
          disabled: false,
          status: 'failed',
          error: '凭证读取失败',
          windows: []
        };
      }
    })
  );

  return {
    provider: 'cliproxyapi',
    accounts
  };
}
