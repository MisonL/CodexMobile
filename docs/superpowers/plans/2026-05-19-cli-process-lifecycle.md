# CodexMobile CLI Process Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement `CM-CLI-002` so the `codexmobile` CLI can manage the local Node service lifecycle, status, and logs from user-level runtime directories.

**Architecture:** Keep `npm start` unchanged and keep `serve` as the foreground service entry. Add a focused `cli/process-manager.mjs` module that owns PID state, managed process guards, detached spawn setup, Windows PATH normalization, log tailing, and log redaction. `cli/commands.mjs` only routes commands, while `cli/status.mjs` reads process-manager status.

**Tech Stack:** Node.js ESM, `node:test`, detached child processes, JSON runtime state, user-level log files.

---

## File Structure

- Create `cli/process-manager.mjs`: process state read/write, start/stop/restart helpers, log tailing, log redaction, Windows PATH de-duplication.
- Modify `cli/paths.mjs`: add `pidPath` and `processStatePath` under `runDir`.
- Modify `cli/status.mjs`: include managed process status from `process-manager`.
- Modify `cli/commands.mjs`: route `start`, `stop`, `restart`, `logs`, keep `serve`.
- Create `tests/cli-process-manager.test.mjs`: direct unit coverage for state guards, PATH de-duplication, log redaction, start plan behavior.
- Modify `tests/cli-commands.test.mjs`: command-level JSON coverage for lifecycle commands.
- Modify `README.md`: document lifecycle commands and user-level log paths.
- Create `docs/reviews/CR-CM-CLI-002-2026-05-19.md`: record verification commands and skipped real boot/autostart boundaries.
- Modify `tasks.md`: set `CM-CLI-002` to `进行中`, then `已完成` after verification.

## Task 1: Lock Task And Write Failing Tests

**Files:**
- Modify: `tasks.md`
- Create: `tests/cli-process-manager.test.mjs`
- Modify: `tests/cli-commands.test.mjs`

- [x] **Step 1: Lock `CM-CLI-002`**

Set `CM-CLI-002` status to `进行中`.

- [x] **Step 2: Test Windows PATH de-duplication**

Assert `dedupePath('C:\\A;C:\\a;C:\\B', 'win32')` returns `C:\A;C:\B`.

- [x] **Step 3: Test start writes managed state**

Use a fake `spawn` returning `{ pid: 12345, unref() {} }`. Assert `startManagedServer()` writes `process-state.json`, uses `codexmobile.mjs serve`, writes logs under `paths.logDir`, and passes `CODEXMOBILE_HOME`.

- [x] **Step 4: Test stop guard prevents killing invalid state**

Write a process state with the wrong `kind`. Assert `stopManagedServer()` returns an error and the fake `kill` function is not called.

- [x] **Step 5: Test logs are redacted**

Assert log output replaces relay secrets, bearer tokens, and query `token=` values with `[redacted]`.

- [x] **Step 6: Test command JSON behavior**

Assert `runCli(['start', '--json'])`, `runCli(['stop', '--json'])`, `runCli(['restart', '--json'])`, and `runCli(['logs', '--json'])` call injected helpers and return structured command names.

- [x] **Step 7: Verify red phase**

Run:

```bash
npm run test:cli
```

Expected: FAIL with missing `cli/process-manager.mjs` exports or unsupported lifecycle commands.

## Task 2: Implement Process Manager

**Files:**
- Create: `cli/process-manager.mjs`
- Modify: `cli/paths.mjs`
- Modify: `cli/status.mjs`
- Modify: `cli/commands.mjs`

- [x] **Step 1: Add runtime paths**

Add `pidPath` and `processStatePath` to `resolveRuntimePaths()`.

- [x] **Step 2: Add process state helpers**

Implement `readManagedState`, `writeManagedState`, `removeManagedState`, and `collectManagedProcessStatus`.

- [x] **Step 3: Add start helper**

Implement `startManagedServer()` with detached spawn, append logs, user-level env, and Windows PATH de-duplication.

- [x] **Step 4: Add stop and restart helpers**

Implement `stopManagedServer()` and `restartManagedServer()` with state guard checks before any process kill.

- [x] **Step 5: Add logs helper**

Implement `readManagedLogs()` and `redactLogText()`.

- [x] **Step 6: Route CLI commands**

Wire `start`, `stop`, `restart`, and `logs` in `cli/commands.mjs`.

- [x] **Step 7: Verify green phase**

Run:

```bash
npm run test:cli
```

Expected: all CLI tests pass.

## Task 3: Document, Verify, Commit

**Files:**
- Modify: `README.md`
- Create: `docs/reviews/CR-CM-CLI-002-2026-05-19.md`
- Modify: `tasks.md`

- [x] **Step 1: Update README**

Document:

```bash
node bin/codexmobile.mjs start --json
node bin/codexmobile.mjs status --json
node bin/codexmobile.mjs logs --json
node bin/codexmobile.mjs stop --json
```

- [x] **Step 2: Run verification commands**

Run:

```bash
npm run test:cli
npm run test:space-verify
npm run build
npm run smoke
npm run smoke:relay
node bin/codexmobile.mjs status --json
node bin/codexmobile.mjs logs --json
git diff --check
```

- [x] **Step 3: Write review record**

Record exit codes, pass/fail summary, and skipped real restart/autostart/iPhone boundaries.

- [x] **Step 4: Mark `CM-CLI-002` complete**

Set `CM-CLI-002` to `已完成` after verification.

- [ ] **Step 5: Commit and push**

Commit:

```bash
git commit -m "feat: manage codexmobile cli service lifecycle"
git push
```
