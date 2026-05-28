import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { assertDeploySourceReady, assertSourceInsideRepo, parseArgs } from '../scripts/deploy-hf-space.mjs';

const ROOT_DIR = path.join(import.meta.dirname, '..');

test('deploy parser rejects source paths outside repository by default', () => {
  assert.throws(
    () => parseArgs(['--remote', 'git@example.com:space.git', '--source', '../outside', '--force']),
    /source must stay inside the repository/
  );
});

test('deploy parser allows missing in-repo source without realpath crash', () => {
  const missing = path.join('dist', 'missing-hf-space');
  const parsed = parseArgs(['--remote', 'git@example.com:space.git', '--source', missing, '--force']);
  assert.equal(parsed.sourceDir, path.join(import.meta.dirname, '..', missing));
});

test('deploy parser allows default source when repository root is loaded through a symlink', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codexmobile-deploy-symlink-root-'));
  const repoDir = path.join(tempDir, 'repo');
  const linkDir = path.join(tempDir, 'repo-link');
  try {
    fs.mkdirSync(path.join(repoDir, 'scripts'), { recursive: true });
    fs.copyFileSync(
      path.join(ROOT_DIR, 'scripts', 'deploy-hf-space.mjs'),
      path.join(repoDir, 'scripts', 'deploy-hf-space.mjs')
    );
    fs.symlinkSync(repoDir, linkDir, 'dir');

    const result = spawnSync(process.execPath, [
      '--preserve-symlinks',
      '--input-type=module',
      '-e',
      [
        "import { pathToFileURL } from 'node:url';",
        "import path from 'node:path';",
        "const repo = process.argv[1];",
        "const script = pathToFileURL(path.join(repo, 'scripts', 'deploy-hf-space.mjs')).href;",
        "const { parseArgs } = await import(script);",
        "parseArgs(['--remote', 'git@example.com:space.git', '--force']);",
        "console.log('allowed');"
      ].join('\n'),
      linkDir
    ], {
      encoding: 'utf8'
    });

    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    assert.match(result.stdout, /allowed/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('deploy parser requires explicit force for destructive push', () => {
  assert.throws(
    () => parseArgs(['--remote', 'git@example.com:space.git']),
    /--force is required/
  );
  const parsed = parseArgs(['--remote', 'git@example.com:space.git', '--force']);
  assert.equal(parsed.force, true);
});

test('deploy rejects non HuggingFace Space remotes before force push', () => {
  const result = spawnSync(process.execPath, [
    path.join(ROOT_DIR, 'scripts', 'deploy-hf-space.mjs'),
    '--remote',
    'git@example.com:space.git',
    '--skip-prepare',
    '--force'
  ], {
    cwd: ROOT_DIR,
    encoding: 'utf8'
  });

  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}${result.stderr}`, /remote must be a HuggingFace Space git URL/);
});

test('deploy parser accepts HuggingFace Space remotes', () => {
  const parsed = parseArgs([
    '--remote',
    'https://huggingface.co/spaces/example/codexmobile-relay',
    '--force'
  ]);

  assert.equal(parsed.remote, 'https://huggingface.co/spaces/example/codexmobile-relay');
});

test('deploy source containment rejects repository root', () => {
  assert.throws(
    () => parseArgs(['--remote', 'git@example.com:space.git', '--source', '.', '--force']),
    /source must not be the repository root/
  );
});

test('deploy source containment rejects repository root even when unsafe source is enabled', () => {
  assert.throws(
    () => parseArgs(['--remote', 'git@example.com:space.git', '--source', '.', '--force', '--unsafe-source']),
    /source must not be the repository root/
  );
});

test('deploy parser allows external source only when unsafe source is enabled', () => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'codexmobile-deploy-unsafe-outside-'));
  try {
    const parsed = parseArgs([
      '--remote',
      'git@example.com:space.git',
      '--source',
      outside,
      '--force',
      '--unsafe-source'
    ]);
    assert.equal(parsed.sourceDir, outside);
  } finally {
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('deploy source containment rejects symlinks to repository root', () => {
  const link = path.join(ROOT_DIR, '.codexmobile-deploy-root-link');
  try {
    fs.symlinkSync(ROOT_DIR, link, 'dir');
    assert.throws(
      () => assertSourceInsideRepo(link),
      /source must not be the repository root/
    );
  } finally {
    fs.rmSync(link, { force: true });
  }
});

test('deploy source containment rejects unsafe symlinks to repository root', () => {
  const link = path.join(ROOT_DIR, '.codexmobile-deploy-unsafe-root-link');
  try {
    fs.symlinkSync(ROOT_DIR, link, 'dir');
    assert.throws(
      () => assertSourceInsideRepo(link, true),
      /source must not be the repository root/
    );
  } finally {
    fs.rmSync(link, { force: true });
  }
});

test('deploy source containment rejects missing paths under repository root symlink parents', () => {
  const link = path.join(ROOT_DIR, '.codexmobile-deploy-root-parent-link');
  try {
    fs.symlinkSync(ROOT_DIR, link, 'dir');
    assert.throws(
      () => assertSourceInsideRepo(path.join(link, 'missing-child')),
      /source must not be the repository root/
    );
  } finally {
    fs.rmSync(link, { force: true });
  }
});

test('deploy source containment rejects symlinks that escape the repository', () => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'codexmobile-deploy-outside-'));
  const link = path.join(import.meta.dirname, '..', '.codexmobile-deploy-outside-link');
  try {
    fs.symlinkSync(outside, link, 'dir');
    assert.throws(
      () => assertSourceInsideRepo(link),
      /source must stay inside the repository/
    );
  } finally {
    fs.rmSync(link, { force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('deploy source containment rejects dangling symlink sources', () => {
  const outside = path.join(os.tmpdir(), `codexmobile-missing-${Date.now()}`);
  const link = path.join(import.meta.dirname, '..', '.codexmobile-deploy-dangling-link');
  try {
    fs.symlinkSync(outside, link, 'dir');
    assert.throws(
      () => assertSourceInsideRepo(link),
      /Source path does not exist/
    );
  } finally {
    fs.rmSync(link, { force: true });
  }
});

test('deploy source containment rejects missing paths under escaping symlink parents', () => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'codexmobile-deploy-parent-outside-'));
  const link = path.join(import.meta.dirname, '..', '.codexmobile-deploy-parent-link');
  try {
    fs.symlinkSync(outside, link, 'dir');
    assert.throws(
      () => assertSourceInsideRepo(path.join(link, 'missing-child')),
      /source must stay inside the repository/
    );
  } finally {
    fs.rmSync(link, { force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('deploy final source validation rejects symlink created after initial missing path check', () => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'codexmobile-deploy-final-outside-'));
  const link = path.join(import.meta.dirname, '..', '.codexmobile-deploy-final-link');
  try {
    fs.writeFileSync(path.join(outside, 'README.md'), 'outside\n');
    assert.doesNotThrow(() => assertSourceInsideRepo(link));
    fs.symlinkSync(outside, link, 'dir');
    assert.throws(
      () => assertDeploySourceReady(link),
      /source must stay inside the repository/
    );
  } finally {
    fs.rmSync(link, { force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('space prepare rejects output paths under escaping dist symlink parents', () => {
  const distDir = path.join(ROOT_DIR, 'dist');
  const hadDist = fs.existsSync(distDir);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'codexmobile-prepare-outside-'));
  const link = path.join(distDir, '.codexmobile-prepare-link');
  try {
    fs.mkdirSync(distDir, { recursive: true });
    fs.symlinkSync(outside, link, 'dir');
    const result = spawnSync(process.execPath, [
      path.join(ROOT_DIR, 'scripts', 'prepare-hf-space.mjs'),
      '--out',
      path.join('dist', '.codexmobile-prepare-link', 'hf-space')
    ], {
      cwd: ROOT_DIR,
      encoding: 'utf8'
    });
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}${result.stderr}`, /Output directory must be inside dist/);
  } finally {
    fs.rmSync(link, { force: true });
    fs.rmSync(outside, { recursive: true, force: true });
    if (!hadDist) {
      fs.rmSync(distDir, { recursive: true, force: true });
    }
  }
});

test('space prepare rejects output paths that realpath outside dist', () => {
  const distDir = path.join(ROOT_DIR, 'dist');
  const hadDist = fs.existsSync(distDir);
  const target = path.join(ROOT_DIR, '.codexmobile-prepare-root-target');
  const link = path.join(distDir, '.codexmobile-prepare-root-link');
  try {
    fs.mkdirSync(distDir, { recursive: true });
    fs.mkdirSync(target, { recursive: true });
    fs.symlinkSync(target, link, 'dir');
    const result = spawnSync(process.execPath, [
      path.join(ROOT_DIR, 'scripts', 'prepare-hf-space.mjs'),
      '--out',
      path.join('dist', '.codexmobile-prepare-root-link', 'hf-space')
    ], {
      cwd: ROOT_DIR,
      encoding: 'utf8'
    });
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}${result.stderr}`, /Output directory must be inside dist/);
  } finally {
    fs.rmSync(link, { force: true });
    fs.rmSync(target, { recursive: true, force: true });
    if (!hadDist) {
      fs.rmSync(distDir, { recursive: true, force: true });
    }
  }
});
