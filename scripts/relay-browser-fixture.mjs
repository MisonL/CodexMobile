import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { connectMac } from './relay-smoke-support.mjs';

const ROOT_DIR = path.resolve(import.meta.dirname, '..');
const CLIENT_INDEX = path.join(ROOT_DIR, 'client', 'dist', 'index.html');
const PORT = Number(process.env.PORT || 9792);
const HOST = process.env.HOST || '127.0.0.1';
const RELAY_SECRET = process.env.CODEXMOBILE_RELAY_SECRET || 'browser-fixture-relay-secret-0123456789abcdef';
const RATE_LIMIT_CHAT = process.env.CODEXMOBILE_RELAY_FIXTURE_RATE_LIMIT_CHAT === '1';

if (!fs.existsSync(CLIENT_INDEX)) {
  throw new Error('client/dist/index.html is missing. Run npm run build before starting the browser fixture.');
}

function spawnRelay() {
  return spawn(process.execPath, ['server/relay-server.js'], {
    cwd: ROOT_DIR,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      HOST,
      PORT: String(PORT),
      CODEXMOBILE_MODE: 'relay',
      CODEXMOBILE_RELAY_SECRET: RELAY_SECRET,
      CODEXMOBILE_RELAY_PENDING_REQUESTS_MAX: '64',
      CODEXMOBILE_RELAY_BROWSER_PENDING_REQUESTS_MAX: '6'
    }
  });
}

function waitForRelay(child) {
  return new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error(`relay did not start in time\n${output}`)), 5000);
    const onData = (chunk) => {
      output += chunk.toString();
      if (output.includes('CodexMobile relay listening')) {
        clearTimeout(timer);
        resolve();
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`relay exited before listening, code=${code}\n${output}`));
    });
  });
}

function closeMac(mac) {
  try {
    mac?.ws?.close();
  } catch {
    mac?.ws?.terminate?.();
  }
}

const relay = spawnRelay();
let mac = null;

function cleanup() {
  closeMac(mac);
  relay.kill('SIGTERM');
}

process.on('SIGINT', () => {
  cleanup();
  process.exit(0);
});
process.on('SIGTERM', () => {
  cleanup();
  process.exit(0);
});
process.on('SIGUSR2', () => {
  closeMac(mac);
  mac = null;
  console.log('Relay browser fixture mac disconnected');
});

await waitForRelay(relay);
mac = await connectMac({
  relayUrl: `ws://${HOST}:${PORT}/relay/mac`,
  secret: RELAY_SECRET,
  reachable: true,
  rateLimitChat: RATE_LIMIT_CHAT
});

console.log(`Relay browser fixture ready: http://${HOST}:${PORT}`);
console.log('Browser token: valid-token');
console.log(`Chat rate limit fixture: ${RATE_LIMIT_CHAT ? 'enabled' : 'disabled'}`);

await new Promise((resolve) => relay.on('exit', resolve));
