import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const secret = process.env.CODEXMOBILE_RELAY_SECRET || 'test-relay-secret-0123456789abcdef';
export const previousSecret = process.env.CODEXMOBILE_RELAY_PREVIOUS_SECRET || 'previous-relay-secret-0123456789abcdef';
export const port = Number(process.env.CODEXMOBILE_RELAY_TEST_PORT || 9786);
export const baseUrl = `http://127.0.0.1:${port}`;
export const relayUrl = `ws://127.0.0.1:${port}/relay/mac`;
export const localFixturePort = Number(process.env.CODEXMOBILE_RELAY_LOCAL_FIXTURE_PORT || 9788);
export const tokenRequestLimit = Number(process.env.CODEXMOBILE_RELAY_TOKEN_REQUESTS_PER_MINUTE || 120);
export const rootDir = fileURLToPath(new URL('..', import.meta.url));

export function fail(message, detail) {
  console.error(`Relay smoke failed: ${message}`);
  if (detail) {
    console.error(detail);
  }
  process.exit(1);
}

export function spawnRelay() {
  const child = spawn(process.execPath, ['server/relay-server.js'], {
    cwd: rootDir,
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: String(port),
      CODEXMOBILE_MODE: 'relay',
      CODEXMOBILE_RELAY_SECRET: secret,
      CODEXMOBILE_RELAY_PREVIOUS_SECRET: previousSecret,
      CODEXMOBILE_RELAY_HEARTBEAT_MS: '100',
      CODEXMOBILE_RELAY_IDLE_HEARTBEAT_MS: '500',
      CODEXMOBILE_RELAY_REQUEST_TIMEOUT_MS: '3000',
      CODEXMOBILE_RELAY_SMALL_BODY_BYTES: '1024',
      CODEXMOBILE_RELAY_PENDING_REQUESTS_MAX: '2',
      CODEXMOBILE_RELAY_BROWSER_PENDING_REQUESTS_MAX: '1',
      CODEXMOBILE_RELAY_TOKEN_REQUESTS_PER_MINUTE: String(tokenRequestLimit),
      CODEXMOBILE_RELAY_TOKEN_REQUEST_WINDOW_MS: '60000'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stderr.on('data', (chunk) => process.stderr.write(chunk));
  return child;
}

export function spawnConnector(localUrl) {
  const child = spawn(process.execPath, ['scripts/relay-mac-client.mjs'], {
    cwd: rootDir,
    env: {
      ...process.env,
      CODEXMOBILE_RELAY_URL: relayUrl,
      CODEXMOBILE_RELAY_SECRET: secret,
      CODEXMOBILE_RELAY_LOCAL_URL: localUrl,
      CODEXMOBILE_RELAY_DEVICE_NAME: 'fixture-mac',
      CODEXMOBILE_RELAY_HEARTBEAT_MS: '100',
      CODEXMOBILE_RELAY_IDLE_HEARTBEAT_MS: '500',
      CODEXMOBILE_RELAY_REQUEST_TIMEOUT_MS: '3000'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stderr.on('data', (chunk) => process.stderr.write(chunk));
  return child;
}

export async function waitForRelay(child) {
  let output = '';
  child.stdout.on('data', (chunk) => {
    output += chunk.toString();
  });
  const startedAt = Date.now();
  while (Date.now() - startedAt < 10000) {
    if (output.includes('CodexMobile relay listening')) {
      return;
    }
    if (child.exitCode !== null) {
      fail('relay exited before listening', output);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  fail('relay did not start in time', output);
}

export async function waitForMacConnected() {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 10000) {
    const result = await request('/api/status', { headers: { authorization: 'Bearer valid-token' } });
    if (result.data.macConnected && result.data.localStatus?.reachable) {
      return result.data;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  fail('relay did not observe connector in time', await request('/api/status'));
}

export async function request(path, options = {}) {
  let response;
  try {
    response = await fetch(`${baseUrl}${path}`, {
      ...options,
      signal: options.signal || AbortSignal.timeout(5000),
      headers: {
        ...(options.body && !(options.body instanceof Buffer) ? { 'content-type': 'application/json' } : {}),
        ...(options.headers || {})
      },
      body:
        options.body && !(options.body instanceof Buffer) && typeof options.body !== 'string'
          ? JSON.stringify(options.body)
          : options.body
    });
  } catch (error) {
    throw new Error(`request ${path} failed: ${error.message}`);
  }
  const text = await response.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { text };
  }
  return { response, data };
}

export async function requestBuffer(path, options = {}) {
  let response;
  try {
    response = await fetch(`${baseUrl}${path}`, {
      ...options,
      signal: options.signal || AbortSignal.timeout(5000),
      headers: options.headers || {}
    });
  } catch (error) {
    throw new Error(`request ${path} failed: ${error.message}`);
  }
  return {
    response,
    body: Buffer.from(await response.arrayBuffer())
  };
}

export function multipartBody(boundary, fieldName, filename, contentType, content) {
  return Buffer.from([
    `--${boundary}\r\n`,
    `content-disposition: form-data; name="${fieldName}"; filename="${filename}"\r\n`,
    `content-type: ${contentType}\r\n\r\n`,
    content,
    `\r\n--${boundary}--\r\n`
  ].join(''));
}
