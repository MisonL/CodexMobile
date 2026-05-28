import fs from 'node:fs/promises';

import { createConnectorInstanceId, isStrongRelaySecret } from '../server/relay-protocol.js';

const DEFAULT_LOCAL_URL = 'http://127.0.0.1:3321';
const REDACTED = '[redacted]';

function clean(value) {
  return String(value || '').trim();
}

function normalizeUrl(value, allowedProtocols, fieldName) {
  const raw = clean(value);
  if (!raw) {
    throw new Error(`${fieldName} is required.`);
  }
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${fieldName} must be a valid URL.`);
  }
  if (!allowedProtocols.includes(url.protocol)) {
    throw new Error(`${fieldName} must use ${allowedProtocols.join(' or ')}.`);
  }
  url.hash = '';
  return url.toString().replace(/\/+$/, '');
}

export function normalizeConnectorInstanceId(value, fieldName = 'connectorInstanceId') {
  const text = clean(value);
  if (!text) {
    return '';
  }
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(text)) {
    throw new Error(`${fieldName} may only contain letters, numbers, dots, underscores, colons, or hyphens.`);
  }
  return text;
}

function redactedConfig(config) {
  if (!config) {
    return null;
  }
  return {
    ...config,
    relaySecret: config.relaySecret ? REDACTED : ''
  };
}

async function readJson(fileSystem, filePath) {
  try {
    return JSON.parse(await fileSystem.readFile(filePath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

export async function readConnectorInstanceId(options = {}) {
  const { paths, fs: fileSystem = fs } = options;
  if (!paths) {
    throw new Error('paths are required.');
  }
  try {
    return normalizeConnectorInstanceId(
      await fileSystem.readFile(paths.connectorInstanceIdPath, 'utf8'),
      'connectorInstanceId'
    );
  } catch (error) {
    if (error.code === 'ENOENT') {
      return '';
    }
    throw error;
  }
}

async function ensureConnectorInstanceId(options = {}) {
  const { paths, fs: fileSystem = fs } = options;
  if (!paths) {
    throw new Error('paths are required.');
  }
  const existing = await readConnectorInstanceId(options);
  if (existing) {
    return existing;
  }
  const connectorInstanceId = createConnectorInstanceId();
  await fileSystem.mkdir(paths.dataDir, { recursive: true });
  await fileSystem.writeFile(paths.connectorInstanceIdPath, `${connectorInstanceId}\n`, {
    encoding: 'utf8',
    mode: 0o600
  });
  await fileSystem.chmod(paths.connectorInstanceIdPath, 0o600);
  return connectorInstanceId;
}

export function normalizeRelayConfig(options = {}) {
  const relayUrl = normalizeUrl(options.relayUrl, ['ws:', 'wss:'], 'relayUrl');
  const relaySecret = clean(options.relaySecret);
  const localUrl = normalizeUrl(options.localUrl || DEFAULT_LOCAL_URL, ['http:', 'https:'], 'localUrl');

  if (!isStrongRelaySecret(relaySecret)) {
    throw new Error('relaySecret must be at least 32 characters.');
  }
  return {
    relayUrl,
    relaySecret,
    localUrl
  };
}

export async function saveRelayConfig(options = {}) {
  try {
    const paths = options.paths;
    if (!paths) {
      throw new Error('paths are required.');
    }
    const fileSystem = options.fs || fs;
    const config = normalizeRelayConfig(options);

    await fileSystem.mkdir(paths.dataDir, { recursive: true });
    await fileSystem.writeFile(paths.relayConfigPath, `${JSON.stringify(config, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600
    });
    await fileSystem.chmod(paths.relayConfigPath, 0o600);
    return {
      command: 'relay-config',
      ok: true,
      configured: true,
      path: paths.relayConfigPath,
      config: redactedConfig(config)
    };
  } catch (error) {
    return {
      command: 'relay-config',
      ok: false,
      error: error.message
    };
  }
}

export async function readRelayConfig(options = {}) {
  const paths = options.paths;
  if (!paths) {
    throw new Error('paths are required.');
  }
  const fileSystem = options.fs || fs;
  const config = await readJson(fileSystem, paths.relayConfigPath);

  if (!config) {
    return {
      command: 'relay-config',
      ok: true,
      configured: false,
      path: paths.relayConfigPath,
      config: null
    };
  }
  return {
    command: 'relay-config',
    ok: true,
    configured: true,
    path: paths.relayConfigPath,
    config: options.redact === false ? config : redactedConfig(config)
  };
}

export async function readRelayLaunchAgentState(options = {}) {
  const { paths } = options;
  if (!paths) {
    throw new Error('paths are required.');
  }
  const relayConfig = await readRelayConfig({ ...options, paths, redact: false });
  if (!relayConfig.configured) {
    return { configured: false };
  }
  try {
    normalizeRelayConfig(relayConfig.config);
  } catch (error) {
    throw new Error(`Invalid saved relay config: ${error.message}`);
  }
  return { configured: true };
}

export async function resolveRelayRuntimeConfig(options = {}) {
  const paths = options.paths;
  if (!paths) {
    throw new Error('paths are required.');
  }
  const env = options.env || process.env;
  const shouldEnsureConnectorInstanceId = Boolean(options.ensureConnectorInstanceId);
  const stored = await readRelayConfig({ ...options, redact: false });
  const config = stored.config || {};
  const envConnectorInstanceId = normalizeConnectorInstanceId(
    env.CODEXMOBILE_RELAY_CONNECTOR_ID,
    'CODEXMOBILE_RELAY_CONNECTOR_ID'
  );
  const storedConnectorInstanceId = shouldEnsureConnectorInstanceId
    ? await ensureConnectorInstanceId(options)
    : await readConnectorInstanceId(options);

  return {
    relayUrl: clean(env.CODEXMOBILE_RELAY_URL) || config.relayUrl || '',
    relaySecret: clean(env.CODEXMOBILE_RELAY_SECRET) || config.relaySecret || '',
    localUrl: clean(env.CODEXMOBILE_RELAY_LOCAL_URL) || config.localUrl || DEFAULT_LOCAL_URL,
    connectorInstanceId: envConnectorInstanceId || storedConnectorInstanceId
  };
}

export async function readRedactedRelayConfig(options = {}) {
  const result = await readRelayConfig({ ...options, redact: true });
  return {
    configured: result.configured,
    path: result.path,
    config: result.config
  };
}
