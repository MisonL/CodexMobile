# CodexMobile CLI LaunchAgent Install Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement `CM-CLI-003` so `codexmobile install` and `uninstall` can explicitly manage a macOS user LaunchAgent while preserving user data by default.

**Architecture:** Extend `cli/launch-agent.mjs` from dry-run plan generation into a small LaunchAgent manager with injectable filesystem and command runner dependencies. Keep `cli/commands.mjs` responsible only for routing flags to LaunchAgent helpers. Tests use temporary LaunchAgent paths and fake `plutil`/`launchctl`, so no real startup configuration is written during automation.

**Tech Stack:** Node.js ESM, `node:test`, macOS LaunchAgent plist XML, injectable `plutil` and `launchctl` command execution.

---

## File Structure

- Modify `cli/launch-agent.mjs`: add install, uninstall, status, enable, disable helpers and data deletion confirmation guard.
- Modify `cli/commands.mjs`: route `install`, `uninstall`, `enable`, `disable`, and LaunchAgent status options.
- Modify `cli/status.mjs`: include LaunchAgent status details from helper.
- Modify `tests/cli-launch-agent.test.mjs`: cover real write to temp path, plutil lint invocation, launchctl invocation, uninstall data guard, label/path stability.
- Modify `tests/cli-commands.test.mjs`: cover command routing and non-dry-run install.
- Modify `README.md`: document explicit LaunchAgent install/uninstall behavior and data preservation.
- Create `docs/reviews/CR-CM-CLI-003-2026-05-19.md`: record verification and skipped real login-start boundary.
- Modify `tasks.md`: set `CM-CLI-003` to `进行中`, then `已完成`.

## Task 1: Lock Task And Write Failing Tests

**Files:**
- Modify: `tasks.md`
- Create/Modify: `tests/cli-launch-agent.test.mjs`
- Modify: `tests/cli-commands.test.mjs`

- [x] **Step 1: Lock `CM-CLI-003`**

Set `CM-CLI-003` status to `进行中`.

- [x] **Step 2: Test real temp install**

Assert `installMacLaunchAgent()` writes a plist to a temporary `launchAgentPath`, calls `plutil -lint`, calls `launchctl bootstrap`, and preserves `com.codexmobile.agent`.

- [x] **Step 3: Test uninstall preserves data**

Assert `uninstallMacLaunchAgent()` removes only the plist and does not remove `paths.dataDir` by default.

- [x] **Step 4: Test data deletion requires confirmation**

Assert uninstall with `removeData: true` but without `confirmRemoveData: true` fails and leaves data in place.

- [x] **Step 5: Test command routing**

Assert `install --json`, `uninstall --json`, `enable --json`, and `disable --json` route to injected launch agent helpers.

- [x] **Step 6: Verify red phase**

Run:

```bash
npm run test:cli
```

Expected: FAIL because install still requires `--dry-run` and LaunchAgent helper exports do not exist.

## Task 2: Implement LaunchAgent Helpers

**Files:**
- Modify: `cli/launch-agent.mjs`
- Modify: `cli/commands.mjs`
- Modify: `cli/status.mjs`

- [x] **Step 1: Split plan and write helpers**

Allow `buildMacInstallPlan()` to build both dry-run and real install content. Add `installMacLaunchAgent()` to create directories, write plist, lint with plutil, and optionally bootstrap/kickstart.

- [x] **Step 2: Add status and launchctl helpers**

Add `getMacLaunchAgentStatus()`, `enableMacLaunchAgent()`, and `disableMacLaunchAgent()` using injectable `execFile`.

- [x] **Step 3: Add uninstall helper**

Add `uninstallMacLaunchAgent()` that unloads where possible, removes plist, preserves data by default, and requires explicit confirmation before deleting data.

- [x] **Step 4: Route commands**

Support:

```bash
node bin/codexmobile.mjs install --json
node bin/codexmobile.mjs uninstall --json
node bin/codexmobile.mjs uninstall --remove-data --confirm-remove-data --json
node bin/codexmobile.mjs enable --json
node bin/codexmobile.mjs disable --json
```

- [x] **Step 5: Verify green phase**

Run:

```bash
npm run test:cli
```

Expected: all CLI tests pass.

## Task 3: Document, Verify, Commit

**Files:**
- Modify: `README.md`
- Create: `docs/reviews/CR-CM-CLI-003-2026-05-19.md`
- Modify: `tasks.md`

- [x] **Step 1: Update README**

Document explicit install/uninstall commands and state that uninstall preserves user data unless both data removal flags are provided.

- [x] **Step 2: Run verification commands**

Run:

```bash
npm run test:cli
npm run test:space-verify
npm run build
npm run smoke
npm run smoke:relay
plutil -lint <temp generated plist>
node bin/codexmobile.mjs install --dry-run --json
git diff --check
```

- [x] **Step 3: Write review record**

Record exit codes, pass/fail summary, and skipped real login-start validation.

- [x] **Step 4: Mark task complete**

Set `CM-CLI-003` to `已完成`.

- [ ] **Step 5: Commit and push**

Commit:

```bash
git commit -m "feat: install codexmobile mac launch agent"
git push
```
