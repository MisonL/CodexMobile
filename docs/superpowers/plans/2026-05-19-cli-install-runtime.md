# CodexMobile CLI Install Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the first productization slice for a `codexmobile` npm CLI that can inspect the local environment and generate a safe macOS install dry-run plan without changing system startup configuration.

**Architecture:** Keep the existing `npm start` and relay scripts intact. Add focused ESM modules under `cli/` for path resolution, status probes, LaunchAgent plist generation, and command routing, with a tiny `bin/codexmobile.mjs` executable entry. Tests exercise pure functions and CLI JSON output so they run without API keys, iPhone, HuggingFace Space, or privileged system writes.

**Tech Stack:** Node.js ESM, `node:test`, npm bin entry, macOS LaunchAgent plist text generation, existing CodexMobile server and relay scripts.

---

## File Structure

- Create `bin/codexmobile.mjs`: executable npm bin that calls the CLI router and exits with its status code.
- Create `cli/paths.mjs`: resolves repository root, user data directory, log directory, config file, LaunchAgent path, and Codex home from explicit env and platform inputs.
- Create `cli/launch-agent.mjs`: builds plist content and dry-run install plans for macOS without writing files.
- Create `cli/status.mjs`: checks Node version, Codex config presence, default ports, local network hints, Tailscale command availability, and runtime log paths.
- Create `cli/commands.mjs`: parses `doctor`, `status`, `install --dry-run`, and shared `--json` output.
- Create `tests/cli-paths.test.mjs`: path resolution tests for macOS, Windows, Linux, and explicit overrides.
- Create `tests/cli-launch-agent.test.mjs`: plist and dry-run plan tests.
- Create `tests/cli-commands.test.mjs`: command behavior tests through pure command invocation and spawned bin JSON output.
- Modify `package.json`: add `bin`, `files`, and `test:cli` script without changing `start`.
- Modify `package-lock.json`: keep npm package metadata aligned with `package.json`.
- Modify `README.md`: document the first CLI dry-run commands and the no-side-effect boundary.
- Create `docs/reviews/CR-CM-CLI-001-2026-05-19.md`: record commands, exit codes, pass/fail summary, and skipped real-environment boundaries.

## Task 1: Track And Plan The Atomic Task

**Files:**
- Create: `tasks.md`
- Create: `docs/superpowers/plans/2026-05-19-cli-install-runtime.md`

- [x] **Step 1: Create `tasks.md` with `CM-CLI-001` locked**

Use the repository task table with `CM-CLI-001` marked `进行中`, and future CLI work marked `未开始`.

- [x] **Step 2: Save this implementation plan**

Save this file under `docs/superpowers/plans/2026-05-19-cli-install-runtime.md`.

## Task 2: Write Failing CLI Tests

**Files:**
- Create: `tests/cli-paths.test.mjs`
- Create: `tests/cli-launch-agent.test.mjs`
- Create: `tests/cli-commands.test.mjs`

- [x] **Step 1: Test platform path resolution**

`tests/cli-paths.test.mjs` must assert:

```javascript
assert.equal(resolveUserDataDir({ platform: 'darwin', env: {}, homedir: '/Users/alice' }), '/Users/alice/Library/Application Support/CodexMobile');
assert.equal(resolveUserDataDir({ platform: 'win32', env: { APPDATA: 'C:\\Users\\alice\\AppData\\Roaming' }, homedir: 'C:\\Users\\alice' }), 'C:\\Users\\alice\\AppData\\Roaming\\CodexMobile');
assert.equal(resolveUserDataDir({ platform: 'linux', env: { XDG_DATA_HOME: '/home/alice/.local/share' }, homedir: '/home/alice' }), '/home/alice/.local/share/codexmobile');
assert.equal(resolveUserDataDir({ platform: 'darwin', env: { CODEXMOBILE_HOME: '/tmp/cm' }, homedir: '/Users/alice' }), '/tmp/cm');
```

- [x] **Step 2: Test LaunchAgent dry-run plan**

`tests/cli-launch-agent.test.mjs` must assert the generated plist includes:

```xml
<string>com.codexmobile.agent</string>
<string>/usr/local/bin/node</string>
<string>serve</string>
```

The dry-run install plan must set `dryRun: true`, contain `wouldWrite` entries, and avoid creating the target file.

- [x] **Step 3: Test CLI JSON command behavior**

`tests/cli-commands.test.mjs` must assert:

```javascript
const doctor = await runCodexMobileCli(['doctor', '--json'], fixtureOptions);
assert.equal(doctor.code, 0);
assert.equal(doctor.output.command, 'doctor');

const install = await runCodexMobileCli(['install', '--dry-run', '--json'], fixtureOptions);
assert.equal(install.code, 0);
assert.equal(install.output.dryRun, true);
```

- [x] **Step 4: Verify tests fail before implementation**

Run:

```bash
node --test tests/cli-paths.test.mjs tests/cli-launch-agent.test.mjs tests/cli-commands.test.mjs
```

Expected: FAIL with missing module or missing export errors for `cli/*.mjs`.

## Task 3: Implement Minimal CLI Modules

**Files:**
- Create: `cli/paths.mjs`
- Create: `cli/launch-agent.mjs`
- Create: `cli/status.mjs`
- Create: `cli/commands.mjs`
- Create: `bin/codexmobile.mjs`
- Modify: `package.json`
- Modify: `package-lock.json`

- [x] **Step 1: Implement `cli/paths.mjs`**

Provide pure functions:

```javascript
resolveUserDataDir({ platform, env, homedir })
resolveRuntimePaths({ platform, env, homedir, cwd })
```

`CODEXMOBILE_HOME` wins over platform defaults. `CODEX_HOME` wins for Codex config, otherwise use `<homedir>/.codex`.

- [x] **Step 2: Implement `cli/launch-agent.mjs`**

Provide:

```javascript
buildLaunchAgentPlist({ label, nodePath, cliPath, workingDirectory, logDir, env })
buildMacInstallPlan({ paths, nodePath, cliPath, dryRun })
```

The plan must not write files. Real writes are deferred to a later task.

- [x] **Step 3: Implement `cli/status.mjs`**

Provide:

```javascript
collectDoctorReport(options)
collectStatusReport(options)
```

Use dependency injection for `fs`, `net`, `execFile`, and env so tests do not mock false success paths.

- [x] **Step 4: Implement `cli/commands.mjs` and bin**

Support:

```bash
codexmobile doctor --json
codexmobile status --json
codexmobile install --dry-run --json
```

Unsupported commands must return exit code `2` and a clear error.

- [x] **Step 5: Update npm metadata**

Add:

```json
"bin": {
  "codexmobile": "./bin/codexmobile.mjs"
},
"files": [
  "bin/",
  "cli/",
  "client/dist/",
  "server/",
  "scripts/",
  "README.md",
  "package.json"
],
"scripts": {
  "test:cli": "node --test tests/cli-*.test.mjs"
}
```

Do not change `"start": "node server/index.js"`.

- [x] **Step 6: Verify CLI tests pass**

Run:

```bash
npm run test:cli
```

Expected: all CLI tests pass.

## Task 4: Document And Verify

**Files:**
- Modify: `README.md`
- Create: `docs/reviews/CR-CM-CLI-001-2026-05-19.md`
- Modify: `tasks.md`

- [x] **Step 1: Update README**

Add a section under quick start describing:

```bash
npx codexmobile doctor --json
npx codexmobile status --json
npx codexmobile install --dry-run --json
```

State that this first slice does not install LaunchAgent or alter startup configuration without a later explicit non-dry-run command.

- [x] **Step 2: Run verification commands**

Run:

```bash
npm run test:cli
npm run test:space-verify
npm run build
node bin/codexmobile.mjs install --dry-run --json
node bin/codexmobile.mjs doctor --json
node bin/codexmobile.mjs status --json
```

Expected: exit code `0` for all commands.

- [x] **Step 3: Write review record**

Create `docs/reviews/CR-CM-CLI-001-2026-05-19.md` with command, exit code, pass/fail summary, and skipped boundaries:

```text
Skipped real LaunchAgent write, real boot login, iPhone PWA install, Tailscale reachability, and authenticated relay connector.
```

- [x] **Step 4: Mark task complete**

Set `CM-CLI-001` status in `tasks.md` to `已完成` only after verification passes.

- [x] **Step 5: Self-review diff**

Run:

```bash
git diff --name-only
git diff --check
```

Expected: only task files are changed and `git diff --check` passes.

## Task 5: Commit And Push

**Files:**
- All files changed by `CM-CLI-001`

- [ ] **Step 1: Commit this atomic task**

Run:

```bash
git add tasks.md docs/superpowers/plans/2026-05-19-cli-install-runtime.md tests/cli-paths.test.mjs tests/cli-launch-agent.test.mjs tests/cli-commands.test.mjs cli/paths.mjs cli/launch-agent.mjs cli/status.mjs cli/commands.mjs bin/codexmobile.mjs package.json package-lock.json README.md docs/reviews/CR-CM-CLI-001-2026-05-19.md
git commit -m "feat: add codexmobile cli dry-run foundation"
```

- [ ] **Step 2: Push current branch**

Run:

```bash
git push
```

Expected: branch `codex/relay-phase1` pushed to its configured upstream.
