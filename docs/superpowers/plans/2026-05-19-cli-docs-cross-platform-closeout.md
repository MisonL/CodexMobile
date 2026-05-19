# CodexMobile CLI Docs Cross Platform Closeout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete `CM-CLI-005` by closing the CLI documentation, verification record, and cross-platform boundary notes without claiming unverified mobile, Tailscale, Space, or Codex subprocess coverage.

**Architecture:** Keep this task documentation-first. Update README for exact CLI entrypoints, platform-specific support boundaries, and known manual validation gates. Add a final review record in `docs/reviews/` with fresh command evidence and skipped boundaries, then mark the task complete.

**Tech Stack:** Markdown docs, existing npm scripts, existing CLI and relay smoke tests.

---

## File Structure

- Modify `README.md`: fix the relay connector code fence, document npm CLI entrypoints, automated validation scope, and Windows/Linux autostart boundary.
- Create `docs/reviews/CR-CM-CLI-005-2026-05-19.md`: record verification commands, exit codes, pass/fail summary, and skipped manual gates.
- Modify `tasks.md`: set `CM-CLI-005` to `进行中`, then `已完成`.

## Task 1: Lock And Document Boundaries

**Files:**
- Modify: `tasks.md`
- Modify: `README.md`

- [x] **Step 1: Lock `CM-CLI-005`**

Set `CM-CLI-005` status to `进行中`.

- [x] **Step 2: Fix README relay connector code fence**

Close the shell code block after the environment-variable `npm run relay:mac` example so later Markdown sections render normally.

- [x] **Step 3: Add CLI entrypoint and runtime boundary notes**

Document that source checkout uses `node bin/codexmobile.mjs`, npm package usage uses `npx codexmobile`, and user state is stored under user-level runtime paths.

- [x] **Step 4: Add cross-platform autostart boundary notes**

Document that macOS LaunchAgent is implemented, while Windows Task Scheduler and Linux user systemd are not implemented in this branch and remain future work.

## Task 2: Verify And Record

**Files:**
- Create: `docs/reviews/CR-CM-CLI-005-2026-05-19.md`
- Modify: `README.md`
- Modify: `tasks.md`

- [x] **Step 1: Run verification commands**

Run:

```bash
npm run test:cli
npm run test:space-verify
npm run build
npm run smoke
npm run smoke:relay
node bin/codexmobile.mjs doctor --json
node bin/codexmobile.mjs status --json
node bin/codexmobile.mjs install --dry-run --json
node bin/codexmobile.mjs relay-config --json
git diff --check
```

- [x] **Step 2: Write review record**

Record exit codes, pass/fail summary, and skipped boundaries: real phone PWA, Tailscale phone reachability, real Space authenticated connector, real Codex subprocess E2E, macOS login restart, Windows Task Scheduler, and Linux user systemd.

- [x] **Step 3: Mark task complete**

Set `CM-CLI-005` to `已完成`.

- [ ] **Step 4: Commit and push**

Commit:

```bash
git commit -m "docs: close codexmobile cli verification boundary"
git push
```
