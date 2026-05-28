import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  normalizeConnectorInstanceId,
  readConnectorInstanceId,
  readRelayConfig,
  resolveRelayRuntimeConfig,
  saveRelayConfig
} from '../cli/relay-config.mjs';
import { resolveRuntimePaths } from '../cli/paths.mjs';

async function makePaths() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'codexmobile-relay-config-'));
  return resolveRuntimePaths({
    platform: 'darwin',
    env: {
      CODEXMOBILE_HOME: path.join(home, 'Library', 'Application Support', 'CodexMobile'),
      CODEX_HOME: path.join(home, '.codex')
    },
    homedir: home,
    cwd: '/repo/codexmobile'
  });
}

test('saveRelayConfig writes relay.json and readRelayConfig redacts secret on demand', async () => {
  const paths = await makePaths();
  const secret = '0123456789abcdef0123456789abcdef';
  const saved = await saveRelayConfig({
    paths,
    relayUrl: 'wss://space.example/relay/mac',
    relaySecret: secret,
    localUrl: 'http://127.0.0.1:3321'
  });
  const raw = JSON.parse(await fs.readFile(paths.relayConfigPath, 'utf8'));
  const plain = await readRelayConfig({ paths, redact: false });
  const redacted = await readRelayConfig({ paths, redact: true });

  assert.equal(saved.ok, true);
  assert.equal(raw.relayUrl, 'wss://space.example/relay/mac');
  assert.equal(raw.relaySecret, secret);
  assert.equal(raw.localUrl, 'http://127.0.0.1:3321');
  assert.equal(plain.config.relaySecret, secret);
  assert.equal(redacted.config.relaySecret, '[redacted]');
  assert.notDeepEqual(redacted, plain);
});

test('saveRelayConfig rejects weak relay secret without writing config', async () => {
  const paths = await makePaths();
  const result = await saveRelayConfig({
    paths,
    relayUrl: 'wss://space.example/relay/mac',
    relaySecret: 'short-secret',
    localUrl: 'http://127.0.0.1:3321'
  });

  assert.equal(result.ok, false);
  assert.match(result.error, /at least 32 characters/);
  await assert.rejects(
    fs.stat(paths.relayConfigPath),
    (error) => error.code === 'ENOENT'
  );
});

test('resolveRelayRuntimeConfig uses saved config with environment override precedence', async () => {
  const paths = await makePaths();
  await saveRelayConfig({
    paths,
    relayUrl: 'wss://saved.example/relay/mac',
    relaySecret: 'saved-secret-0123456789abcdef012345',
    localUrl: 'http://127.0.0.1:3321'
  });

  const saved = await resolveRelayRuntimeConfig({ paths, env: {} });
  const overridden = await resolveRelayRuntimeConfig({
    paths,
    env: {
      CODEXMOBILE_RELAY_URL: 'wss://env.example/relay/mac',
      CODEXMOBILE_RELAY_SECRET: 'env-secret-0123456789abcdef01234567',
      CODEXMOBILE_RELAY_LOCAL_URL: 'https://127.0.0.1:3443'
    }
  });

  assert.equal(saved.relayUrl, 'wss://saved.example/relay/mac');
  assert.equal(saved.relaySecret, 'saved-secret-0123456789abcdef012345');
  assert.equal(saved.localUrl, 'http://127.0.0.1:3321');
  assert.equal(overridden.relayUrl, 'wss://env.example/relay/mac');
  assert.equal(overridden.relaySecret, 'env-secret-0123456789abcdef01234567');
  assert.equal(overridden.localUrl, 'https://127.0.0.1:3443');
});

test('resolveRelayRuntimeConfig reads without creating a connector instance id by default', async () => {
  const paths = await makePaths();
  const config = await resolveRelayRuntimeConfig({ paths, env: {} });

  assert.equal(config.connectorInstanceId, '');
  await assert.rejects(
    fs.stat(paths.connectorInstanceIdPath),
    (error) => error.code === 'ENOENT'
  );
});

test('resolveRelayRuntimeConfig persists a stable connector instance id when requested', async () => {
  const paths = await makePaths();
  const first = await resolveRelayRuntimeConfig({ paths, env: {}, ensureConnectorInstanceId: true });
  const second = await resolveRelayRuntimeConfig({ paths, env: {}, ensureConnectorInstanceId: true });
  const stored = await readConnectorInstanceId({ paths });

  assert.match(first.connectorInstanceId, /^[0-9a-f-]{36}$/);
  assert.equal(second.connectorInstanceId, first.connectorInstanceId);
  assert.equal(stored, first.connectorInstanceId);
});

test('normalizeConnectorInstanceId rejects control characters', () => {
  assert.equal(normalizeConnectorInstanceId('cmac-env-connector'), 'cmac-env-connector');
  assert.throws(
    () => normalizeConnectorInstanceId('cmac-env\nconnector', 'CODEXMOBILE_RELAY_CONNECTOR_ID'),
    /CODEXMOBILE_RELAY_CONNECTOR_ID/
  );
});

test('resolveRelayRuntimeConfig rejects invalid environment connector id', async () => {
  const paths = await makePaths();
  await assert.rejects(
    resolveRelayRuntimeConfig({
      paths,
      env: { CODEXMOBILE_RELAY_CONNECTOR_ID: 'cmac-env\nconnector' }
    }),
    /CODEXMOBILE_RELAY_CONNECTOR_ID/
  );
});

test('readConnectorInstanceId rejects invalid stored connector id', async () => {
  const paths = await makePaths();
  await fs.mkdir(paths.dataDir, { recursive: true });
  await fs.writeFile(paths.connectorInstanceIdPath, 'cmac-stored\nbad\n', 'utf8');

  await assert.rejects(
    readConnectorInstanceId({ paths }),
    /connectorInstanceId/
  );
});

test('readRelayConfig reports unconfigured when relay.json is missing', async () => {
  const paths = await makePaths();
  const result = await readRelayConfig({ paths, redact: true });

  assert.equal(result.configured, false);
  assert.equal(result.config, null);
});

test('relay-mac-client-config reads saved config and keeps environment precedence', async () => {
  const paths = await makePaths();
  await saveRelayConfig({
    paths,
    relayUrl: 'wss://saved.example/relay/mac',
    relaySecret: 'saved-secret-0123456789abcdef012345',
    localUrl: 'http://127.0.0.1:3321'
  });
  const previous = { ...process.env };
  try {
    process.env = {
      ...previous,
      CODEXMOBILE_HOME: paths.dataDir,
      CODEXMOBILE_RELAY_URL: '',
      CODEXMOBILE_RELAY_SECRET: '',
      CODEXMOBILE_RELAY_LOCAL_URL: ''
    };
    const savedModule = await import(`../scripts/relay-mac-client-config.mjs?saved=${Date.now()}`);
    assert.equal(savedModule.RELAY_URL, 'wss://saved.example/relay/mac');
    assert.equal(savedModule.RELAY_SECRET, 'saved-secret-0123456789abcdef012345');
    assert.equal(savedModule.LOCAL_URL, 'http://127.0.0.1:3321');
    assert.match(savedModule.connectorInstanceId, /^[0-9a-f-]{36}$/);

    process.env.CODEXMOBILE_RELAY_URL = 'wss://env.example/relay/mac';
    process.env.CODEXMOBILE_RELAY_SECRET = 'env-secret-0123456789abcdef01234567';
    process.env.CODEXMOBILE_RELAY_LOCAL_URL = 'https://127.0.0.1:3443';
    process.env.CODEXMOBILE_RELAY_CONNECTOR_ID = 'cmac-env-connector';
    const envModule = await import(`../scripts/relay-mac-client-config.mjs?env=${Date.now()}`);
    assert.equal(envModule.RELAY_URL, 'wss://env.example/relay/mac');
    assert.equal(envModule.RELAY_SECRET, 'env-secret-0123456789abcdef01234567');
    assert.equal(envModule.LOCAL_URL, 'https://127.0.0.1:3443');
    assert.equal(envModule.connectorInstanceId, 'cmac-env-connector');
  } finally {
    process.env = previous;
  }
});
