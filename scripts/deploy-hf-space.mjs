import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const ROOT_DIR = path.resolve(import.meta.dirname, '..');
const DEFAULT_SOURCE_DIR = path.join(ROOT_DIR, 'dist', 'hf-space');
const DEFAULT_BRANCH = 'main';

export function parseArgs(argv) {
  const options = {
    sourceDir: DEFAULT_SOURCE_DIR,
    branch: DEFAULT_BRANCH,
    remote: '',
    skipPrepare: false,
    force: false,
    unsafeSource: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === '--remote') {
      const value = argv[index + 1];
      if (!value) {
        throw new Error('--remote requires a git remote URL.');
      }
      options.remote = value;
      index += 1;
      continue;
    }
    if (item.startsWith('--remote=')) {
      options.remote = item.slice('--remote='.length);
      continue;
    }
    if (item === '--branch') {
      const value = argv[index + 1];
      if (!value) {
        throw new Error('--branch requires a branch name.');
      }
      options.branch = value;
      index += 1;
      continue;
    }
    if (item.startsWith('--branch=')) {
      options.branch = item.slice('--branch='.length);
      continue;
    }
    if (item === '--source') {
      const value = argv[index + 1];
      if (!value) {
        throw new Error('--source requires a directory path.');
      }
      options.sourceDir = path.resolve(ROOT_DIR, value);
      index += 1;
      continue;
    }
    if (item.startsWith('--source=')) {
      options.sourceDir = path.resolve(ROOT_DIR, item.slice('--source='.length));
      continue;
    }
    if (item === '--skip-prepare') {
      options.skipPrepare = true;
      continue;
    }
    if (item === '--force') {
      options.force = true;
      continue;
    }
    if (item === '--unsafe-source') {
      options.unsafeSource = true;
      continue;
    }
    throw new Error(`Unknown argument: ${item}`);
  }
  if (!options.force) {
    throw new Error('--force is required because deployment rewrites the target branch.');
  }
  assertSourceInsideRepo(options.sourceDir, options.unsafeSource);
  return options;
}

export function assertSourceInsideRepo(sourceDir, unsafeSource = false) {
  const resolvedLexical = path.resolve(sourceDir);
  const lexicalRelative = path.relative(ROOT_DIR, resolvedLexical);
  if (lexicalRelative === '') {
    throw new Error('source must not be the repository root.');
  }
  const existingPath = nearestExistingPath(resolvedLexical);
  assertSourceNotRepositoryRoot(existingPath, existingPath === resolvedLexical);
  if (unsafeSource) {
    return;
  }
  if (isOutsideRelativePath(lexicalRelative)) {
    throw new Error('source must stay inside the repository unless --unsafe-source is set.');
  }
  assertSourceRealpathInsideRepo(existingPath, existingPath === resolvedLexical);
}

export function assertDeploySourceReady(sourceDir, unsafeSource = false) {
  assertSourceInsideRepo(sourceDir, unsafeSource);
  assertSourceDir(sourceDir);
}

function isOutsideRelativePath(relativePath) {
  return relativePath === '..' || relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath);
}

function nearestExistingPath(targetPath) {
  let current = targetPath;
  while (true) {
    try {
      fs.lstatSync(current);
      return current;
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw error;
      }
      const parent = path.dirname(current);
      if (parent === current) {
        throw error;
      }
      current = parent;
    }
  }
}

function assertSourceRealpathInsideRepo(sourceDir, rejectRepositoryRoot = false) {
  const { resolvedRoot, resolvedSource } = resolveRootAndSource(sourceDir);
  const relative = path.relative(resolvedRoot, resolvedSource);
  if (relative === '' && rejectRepositoryRoot) {
    throw new Error('source must not be the repository root.');
  }
  if (relative === '' && path.resolve(sourceDir) !== ROOT_DIR) {
    throw new Error('source must not be the repository root.');
  }
  if (isOutsideRelativePath(relative)) {
    throw new Error('source must stay inside the repository unless --unsafe-source is set.');
  }
}

function assertSourceNotRepositoryRoot(sourceDir, rejectRepositoryRoot = false) {
  const { resolvedRoot, resolvedSource } = resolveRootAndSource(sourceDir);
  const relative = path.relative(resolvedRoot, resolvedSource);
  if (relative === '' && (rejectRepositoryRoot || path.resolve(sourceDir) !== ROOT_DIR)) {
    throw new Error('source must not be the repository root.');
  }
}

function resolveRootAndSource(sourceDir) {
  let resolvedRoot = '';
  let resolvedSource = '';
  try {
    resolvedRoot = fs.realpathSync(ROOT_DIR);
    resolvedSource = fs.realpathSync(sourceDir);
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new Error(`Source path does not exist: ${sourceDir}`);
    }
    throw error;
  }
  return { resolvedRoot, resolvedSource };
}

function normalizeRemote(remote) {
  const value = String(remote || '').trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value) || /^[^/]+@[^:]+:.+/.test(value) || path.isAbsolute(value)) {
    return value;
  }
  return path.resolve(ROOT_DIR, value);
}

function assertHuggingFaceSpaceRemote(remote) {
  const value = String(remote || '').trim();
  if (/^https:\/\/huggingface\.co\/spaces\/[^/\s]+\/[^/\s]+(?:\.git)?$/i.test(value)) {
    return;
  }
  if (/^git@(hf\.co|huggingface\.co):spaces\/[^/\s]+\/[^/\s]+(?:\.git)?$/i.test(value)) {
    return;
  }
  throw new Error('remote must be a HuggingFace Space git URL.');
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: ROOT_DIR,
    stdio: 'inherit',
    env: process.env,
    ...options
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed with exit code ${result.status}`);
  }
}

function hasCommand(command) {
  const result = spawnSync(process.platform === 'win32' ? 'where' : 'which', [command], { stdio: 'pipe' });
  return result.status === 0;
}

function assertSourceDir(sourceDir) {
  const resolved = path.resolve(sourceDir);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Source directory does not exist: ${resolved}`);
  }
  if (!fs.existsSync(path.join(resolved, 'README.md'))) {
    throw new Error(`Source directory is missing README.md: ${resolved}`);
  }
}

function configureBinaryStorage(sourceDir) {
  if (!hasCommand('git-lfs')) {
    return;
  }
  run('git', ['-C', sourceDir, 'lfs', 'install', '--local']);
  run('git', ['-C', sourceDir, 'lfs', 'track', '*.png', '*.jpg', '*.jpeg', '*.webp', '*.gif', '*.ico']);
}

function initDeployRepo(sourceDir, branch) {
  const gitDir = path.join(sourceDir, '.git');
  fs.rmSync(gitDir, { recursive: true, force: true });
  run('git', ['-C', sourceDir, 'init', '-b', branch]);
  run('git', ['-C', sourceDir, 'config', 'user.name', 'Codex']);
  run('git', ['-C', sourceDir, 'config', 'user.email', 'codex@openai.com']);
  configureBinaryStorage(sourceDir);
  run('git', ['-C', sourceDir, 'add', '-A']);
  run('git', ['-C', sourceDir, 'commit', '-m', 'deploy: CodexMobile Relay']);
}

function deployRemote(sourceDir, remote, branch) {
  const remoteName = 'huggingface';
  assertHuggingFaceSpaceRemote(remote);
  run('git', ['-C', sourceDir, 'remote', 'add', remoteName, remote]);
  run('git', ['-C', sourceDir, 'push', '--force', remoteName, `${branch}:${branch}`]);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options.remote) {
    throw new Error('Missing --remote. Provide the HuggingFace Space git remote URL.');
  }
  options.remote = normalizeRemote(options.remote);
  assertHuggingFaceSpaceRemote(options.remote);
  if (!options.skipPrepare) {
    run('npm', ['run', 'space:prepare']);
  }
  assertDeploySourceReady(options.sourceDir, options.unsafeSource);
  initDeployRepo(options.sourceDir, options.branch);
  deployRemote(options.sourceDir, options.remote, options.branch);
  fs.rmSync(path.join(options.sourceDir, '.git'), { recursive: true, force: true });
  console.log(`Deployed ${options.sourceDir} to ${options.remote} on branch ${options.branch}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((error) => {
    console.error(error.message || error);
    process.exit(1);
  });
}
