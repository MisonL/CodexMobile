import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const TEST_DIR = path.resolve(import.meta.dirname, '..', 'tests');

const GROUPS = {
  all: [/\.test\.mjs$/],
  cli: [/^cli-.*\.test\.mjs$/],
  client: [/^(app-message-state|app-websocket-events|relay-status-client)\.test\.mjs$/],
  deploy: [/^deploy-hf-space.*\.test\.mjs$/],
  'relay-mac': [/^relay-mac-client-.*\.test\.mjs$/],
  'relay-runtime': [/^relay-runtime-.*\.test\.mjs$/],
  server: [/^(app-(attachments|static|upload)|codex-|realtime-|relay-auth-|routes-|server-|voice-).*\.test\.mjs$/],
  'space-verify': [/^space-verify\.test\.mjs$/]
};

function patternsFor(groupName) {
  const patterns = GROUPS[groupName];
  if (!patterns) {
    throw new Error(`Unknown test group: ${groupName}`);
  }
  return patterns;
}

const groupName = process.argv[2] || 'all';
const patterns = patternsFor(groupName);
const files = readdirSync(TEST_DIR)
  .filter((name) => patterns.some((pattern) => pattern.test(name)))
  .sort()
  .map((name) => path.join(TEST_DIR, name));

if (!files.length) {
  throw new Error(`No test files matched group: ${groupName}`);
}

const result = spawnSync(process.execPath, ['--test', ...files], {
  cwd: path.resolve(import.meta.dirname, '..'),
  stdio: 'inherit'
});

process.exit(result.status ?? 1);
