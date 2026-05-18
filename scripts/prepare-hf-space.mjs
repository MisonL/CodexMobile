import fs from 'node:fs';
import path from 'node:path';

const ROOT_DIR = path.resolve(import.meta.dirname, '..');
const DEFAULT_OUTPUT_DIR = path.join(ROOT_DIR, 'dist', 'hf-space');
const COPY_PATHS = [
  'Dockerfile',
  'package.json',
  'package-lock.json',
  'client',
  'server',
  'scripts'
];
const EXCLUDED_NAMES = new Set([
  '.DS_Store',
  '.env',
  '.codexmobile',
  '.git',
  'node_modules',
  'dist',
  'coverage',
  '.vite',
  '.cache'
]);
const EXCLUDED_SCRIPT_NAMES = new Set([
  'start-all.ps1',
  'start-server.mjs',
  'start-asr.mjs'
]);
const SPACE_README = `---
title: CodexMobile Relay
sdk: docker
app_port: 7860
---

# CodexMobile Relay

This HuggingFace Docker Space runs the CodexMobile relay entrypoint.

Configure Space variables:

\`\`\`text
CODEXMOBILE_MODE=relay
HOST=0.0.0.0
PORT=7860
CODEXMOBILE_RELAY_REQUEST_TIMEOUT_MS=120000
CODEXMOBILE_RELAY_HEARTBEAT_MS=15000
CODEXMOBILE_RELAY_IDLE_HEARTBEAT_MS=300000
CODEXMOBILE_RELAY_PENDING_REQUESTS_MAX=64
CODEXMOBILE_RELAY_BROWSER_PENDING_REQUESTS_MAX=6
\`\`\`

Configure Space secrets:

\`\`\`text
CODEXMOBILE_RELAY_SECRET=<at-least-32-character-random-secret>
\`\`\`

Do not commit relay secrets, browser tokens, pairing codes, logs, or local state.
`;

function parseArgs(argv) {
  const options = {
    outDir: DEFAULT_OUTPUT_DIR
  };
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === '--out') {
      const value = argv[index + 1];
      if (!value) {
        throw new Error('--out requires a directory.');
      }
      options.outDir = path.resolve(ROOT_DIR, value);
      index += 1;
      continue;
    }
    if (item.startsWith('--out=')) {
      options.outDir = path.resolve(ROOT_DIR, item.slice('--out='.length));
      continue;
    }
    throw new Error(`Unknown argument: ${item}`);
  }
  return options;
}

function assertSafeOutputDir(outDir) {
  const resolved = path.resolve(outDir);
  const distDir = path.join(ROOT_DIR, 'dist');
  if (resolved === ROOT_DIR || resolved === distDir) {
    throw new Error('Refusing to overwrite the repository root or dist root.');
  }
  if (!resolved.startsWith(`${distDir}${path.sep}`)) {
    throw new Error('Output directory must be inside dist/.');
  }
}

function shouldCopy(sourcePath) {
  const name = path.basename(sourcePath);
  if (EXCLUDED_NAMES.has(name)) {
    return false;
  }
  if (path.basename(path.dirname(sourcePath)) === 'scripts' && EXCLUDED_SCRIPT_NAMES.has(name)) {
    return false;
  }
  return true;
}

function copyPath(relativePath, outDir) {
  const source = path.join(ROOT_DIR, relativePath);
  const target = path.join(outDir, relativePath);
  if (!fs.existsSync(source)) {
    throw new Error(`Required path is missing: ${relativePath}`);
  }
  fs.cpSync(source, target, {
    recursive: true,
    filter: shouldCopy
  });
}

function writeSpaceFiles(outDir) {
  fs.writeFileSync(path.join(outDir, 'README.md'), SPACE_README);
  fs.writeFileSync(path.join(outDir, '.dockerignore'), [
    '.git',
    'node_modules',
    'client/dist',
    'dist',
    'coverage',
    '.vite',
    '.cache',
    '.codexmobile',
    '.env',
    '.env.*',
    '*.log',
    '.DS_Store',
    ''
  ].join('\n'));
}

function listOutput(outDir) {
  const stack = ['.'];
  const files = [];
  while (stack.length > 0) {
    const relative = stack.pop();
    const absolute = path.join(outDir, relative);
    for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
      const nextRelative = path.join(relative, entry.name);
      if (entry.isDirectory()) {
        stack.push(nextRelative);
      } else {
        files.push(nextRelative.replaceAll(path.sep, '/'));
      }
    }
  }
  return files.sort();
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  assertSafeOutputDir(options.outDir);
  fs.rmSync(options.outDir, { recursive: true, force: true });
  fs.mkdirSync(options.outDir, { recursive: true });
  for (const relativePath of COPY_PATHS) {
    copyPath(relativePath, options.outDir);
  }
  writeSpaceFiles(options.outDir);
  const files = listOutput(options.outDir);
  console.log(`Prepared HuggingFace Docker Space at ${options.outDir}`);
  console.log(`Files: ${files.length}`);
  console.log('Next: push this directory to the target HuggingFace Space repository, then configure secrets in Space Settings.');
}

main();
