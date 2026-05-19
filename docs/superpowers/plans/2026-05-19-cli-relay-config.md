# CodexMobile CLI Relay Config Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement `CM-CLI-004` so the CLI can save, read, redact, and apply Mac connector relay startup configuration without leaking the relay secret.

**Architecture:** Add a focused `cli/relay-config.mjs` module for validation, persistence, redaction, and runtime environment resolution. Keep `cli/commands.mjs` as the command router and `cli/status.mjs` as the status aggregator. Update `scripts/relay-mac-client-config.mjs` so existing `npm run relay:mac` still works with environment variables and can also fall back to the saved user-level relay config.

**Tech Stack:** Node.js ESM, `node:test`, JSON config under the existing user data directory, existing relay protocol secret strength validation.

---

## File Structure

- Create `cli/relay-config.mjs`: read/write relay config, validate URLs and secret strength, redact secret, and merge saved config with environment overrides.
- Modify `cli/commands.mjs`: add `relay-config --url --secret --local-url --json` and `relay-config --json`.
- Modify `cli/status.mjs`: include redacted relay config status.
- Modify `scripts/relay-mac-client-config.mjs`: load saved relay config when environment variables are absent, while preserving environment variable precedence.
- Create `tests/cli-relay-config.test.mjs`: cover read/write, weak secret failure, redaction, env precedence, and missing config.
- Modify `tests/cli-commands.test.mjs`: cover CLI relay config save/show routing and weak secret failure.
- Modify `README.md`: document the CLI relay config command and `npm run relay:mac` fallback behavior.
- Create `docs/reviews/CR-CM-CLI-004-2026-05-19.md`: record verification and skipped real Space connector boundary.
- Modify `tasks.md`: set `CM-CLI-004` to `进行中`, then `已完成`.

## Task 1: Lock Task And Write Failing Tests

**Files:**
- Modify: `tasks.md`
- Create: `tests/cli-relay-config.test.mjs`
- Modify: `tests/cli-commands.test.mjs`

- [x] **Step 1: Lock `CM-CLI-004`**

Set `CM-CLI-004` status to `进行中`.

- [x] **Step 2: Test relay config persistence and redaction**

Add tests asserting `saveRelayConfig()` writes `relay.json`, `readRelayConfig({ redact: false })` returns the real secret, and `readRelayConfig({ redact: true })` returns `[redacted]` without exposing the original secret.

- [x] **Step 3: Test weak secret failure**

Add tests asserting a relay secret shorter than 32 characters returns `ok=false`, contains an explicit error, and does not write a config file.

- [x] **Step 4: Test environment precedence**

Add tests asserting runtime resolution uses saved config by default but `CODEXMOBILE_RELAY_URL`, `CODEXMOBILE_RELAY_SECRET`, and `CODEXMOBILE_RELAY_LOCAL_URL` override saved values.

- [x] **Step 5: Test command routing**

Add tests asserting `relay-config --json` returns redacted config, `relay-config --url ... --secret ... --local-url ... --json` saves config, and weak secret returns non-zero.

- [x] **Step 6: Verify red phase**

Run:

```bash
npm run test:cli
```

Expected: FAIL because `cli/relay-config.mjs` and `relay-config` command do not exist.

## Task 2: Implement Relay Config Helpers

**Files:**
- Create: `cli/relay-config.mjs`
- Modify: `scripts/relay-mac-client-config.mjs`

- [x] **Step 1: Add validation and normalization**

Implement `normalizeRelayConfig()` so relay URL must be `ws:` or `wss:`, local URL must be `http:` or `https:`, and relay secret must pass `isStrongRelaySecret()`.

- [x] **Step 2: Add persistence**

Implement `saveRelayConfig()` to create `paths.dataDir`, write `paths.relayConfigPath` as JSON, and chmod the file to `0600`.

- [x] **Step 3: Add redacted read**

Implement `readRelayConfig()` to return `{ configured: false }` when missing and return `[redacted]` for secret when redaction is requested.

- [x] **Step 4: Add runtime merge**

Implement `resolveRelayRuntimeConfig()` so environment variables take precedence over saved config, with default local URL `http://127.0.0.1:3321`.

- [x] **Step 5: Update Mac connector config**

Use `resolveRelayRuntimeConfig()` in `scripts/relay-mac-client-config.mjs`, preserving the existing exported constants and failure messages.

## Task 3: Route CLI And Status

**Files:**
- Modify: `cli/commands.mjs`
- Modify: `cli/status.mjs`
- Modify: `tests/cli-commands.test.mjs`

- [x] **Step 1: Add CLI command**

Route `relay-config` so flags save config and no mutation flags show redacted config.

- [x] **Step 2: Add status redaction**

Include redacted relay config under `status.relayConfig` without exposing the real secret.

- [x] **Step 3: Verify green phase**

Run:

```bash
npm run test:cli
```

Expected: all CLI tests pass.

## Task 4: Document, Verify, Commit

**Files:**
- Modify: `README.md`
- Create: `docs/reviews/CR-CM-CLI-004-2026-05-19.md`
- Modify: `tasks.md`

- [x] **Step 1: Update README**

Document `relay-config` save/show commands, redaction behavior, and that `npm run relay:mac` still accepts environment variables with precedence over saved config.

- [x] **Step 2: Run verification commands**

Run:

```bash
npm run test:cli
npm run test:space-verify
npm run smoke:relay
node bin/codexmobile.mjs relay-config --json
git diff --check
```

- [x] **Step 3: Write review record**

Record exit codes, pass/fail summary, secret redaction checks, and skipped real Space connector validation.

- [x] **Step 4: Mark task complete**

Set `CM-CLI-004` to `已完成`.

- [ ] **Step 5: Commit and push**

Commit:

```bash
git commit -m "feat: configure codexmobile relay connector"
git push
```
