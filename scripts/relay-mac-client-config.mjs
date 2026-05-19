import {
  DEFAULT_RELAY_HEARTBEAT_MS,
  DEFAULT_RELAY_IDLE_HEARTBEAT_MS,
  DEFAULT_RELAY_REQUEST_TIMEOUT_MS,
  buildLocalTargetUrl,
  createConnectorInstanceId,
  isStrongRelaySecret,
  parsePositiveInt
} from '../server/relay-protocol.js';
import { resolveRuntimePaths } from '../cli/paths.mjs';
import { resolveRelayRuntimeConfig } from '../cli/relay-config.mjs';

const runtimeConfig = await resolveRelayRuntimeConfig({
  paths: resolveRuntimePaths({
    platform: process.platform,
    env: process.env,
    cwd: process.cwd()
  }),
  env: process.env
});

export const RELAY_URL = runtimeConfig.relayUrl;
export const RELAY_SECRET = runtimeConfig.relaySecret;
export const DEVICE_NAME = String(process.env.CODEXMOBILE_RELAY_DEVICE_NAME || '').trim() || `${process.env.USER || 'mac'}-mac`;
export const LOCAL_URL = runtimeConfig.localUrl.replace(/\/+$/, '');
export const HEARTBEAT_MS = parsePositiveInt(process.env.CODEXMOBILE_RELAY_HEARTBEAT_MS, DEFAULT_RELAY_HEARTBEAT_MS);
export const IDLE_HEARTBEAT_MS = parsePositiveInt(process.env.CODEXMOBILE_RELAY_IDLE_HEARTBEAT_MS, DEFAULT_RELAY_IDLE_HEARTBEAT_MS);
export const REQUEST_TIMEOUT_MS = parsePositiveInt(process.env.CODEXMOBILE_RELAY_REQUEST_TIMEOUT_MS, DEFAULT_RELAY_REQUEST_TIMEOUT_MS);
export const MAX_BODY_BYTES = parsePositiveInt(process.env.CODEXMOBILE_RELAY_SMALL_BODY_BYTES, 2 * 1024 * 1024);
export const connectorInstanceId = process.env.CODEXMOBILE_RELAY_CONNECTOR_ID || createConnectorInstanceId();

export function requireConfig() {
  if (!RELAY_URL) {
    throw new Error('CODEXMOBILE_RELAY_URL is required.');
  }
  if (!isStrongRelaySecret(RELAY_SECRET)) {
    throw new Error('CODEXMOBILE_RELAY_SECRET must be at least 32 characters.');
  }
}

export function logState(state, reason = '') {
  const suffix = reason ? ` reason=${reason}` : '';
  console.log(`[relay:mac] state=${state} relay=${RELAY_URL}${suffix}`);
}

export function buildLocalUrl(path) {
  return buildLocalTargetUrl(path, LOCAL_URL);
}

export function buildLocalWsUrl(token) {
  const url = new URL(buildLocalUrl(`/ws?token=${encodeURIComponent(token)}`));
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
}

export function buildLocalRealtimeWsUrl(token) {
  const url = new URL(buildLocalUrl(`/ws/realtime?token=${encodeURIComponent(token)}`));
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
}
