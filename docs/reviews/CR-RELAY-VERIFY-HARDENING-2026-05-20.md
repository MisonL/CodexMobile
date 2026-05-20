# CR-RELAY-VERIFY-HARDENING-2026-05-20

## 范围

本记录覆盖对 `space:verify` 的二次收口：

- 修复 chat verifier 只等到非终态 `status-update` 就通过的问题。
- 拆分 `scripts/verify-hf-space-core.mjs`，消除本分支新增文件超过 300 行的问题。
- 复验当前 Docker relay 与 HuggingFace Space 的真实运行态。

## 修复

- `scripts/verify-hf-space-core.mjs`：`chatSend` 现在只在 WebSocket 收到 `chat-complete` 后通过，收到 `chat-error` 会失败。
- `scripts/verify-hf-space-network.mjs`：拆出 HTTP JSON/text 请求、WebSocket 等待、auth header 和 ws origin helper。
- `tests/space-verify-fixture.mjs`：fixture 支持自定义 chat event 序列。
- `tests/space-verify.test.mjs`：新增回归测试，覆盖 HTTP `202` 后 WebSocket 继续发 `chat-error` 的失败路径。
- `.github/workflows/relay-ci.yml`：加入新 network helper 的 syntax check。

## 验证

| 命令 | 退出码 | 结果 |
| --- | ---: | --- |
| `npm run test:server` | 0 | 3 tests passed. |
| `npm run test:space-verify` | 0 | 12 tests passed. |
| `npm run test:cli` | 0 | 47 tests passed. |
| `node --check scripts/verify-hf-space-core.mjs && node --check scripts/verify-hf-space-network.mjs && node --check tests/space-verify.test.mjs && node --check tests/space-verify-fixture.mjs && git diff --check` | 0 | Passed. |
| `npm run build` | 0 | Vite production build passed. |
| `npm run smoke` | 0 | Local service smoke passed. |
| `npm run smoke:relay` | 0 | Relay smoke passed. |
| `npm run space:verify -- --url http://127.0.0.1:9790 --pair-code <redacted> --device-name docker-terminal-verifier-rerun --require-mac --check-realtime --chat-message "请只回复 ok" --timeout-ms 300000 --json` | 0 | Docker authenticated verifier passed 9/9; `chatSend` detail included `terminal=chat-complete`. |
| `npm run space:verify -- --url https://misonl-codexmobile-relay.hf.space --pair-code <redacted> --device-name space-terminal-verifier-rerun --require-mac --check-realtime --chat-message "请只回复 ok" --timeout-ms 300000 --json` | 0 | Space authenticated verifier passed 9/9; `chatSend` detail included `terminal=chat-complete`. |
| `npm run space:verify -- --url http://127.0.0.1:9790 --json` | 0 | Docker public verifier passed 4/4 after cleanup. |
| `npm run space:verify -- --url https://misonl-codexmobile-relay.hf.space --json` | 0 | Space public verifier passed 4/4 after cleanup. |

## 复杂度

| File | Lines | Result |
| --- | ---: | --- |
| `scripts/verify-hf-space-core.mjs` | 293 | Within 300-line limit. |
| `scripts/verify-hf-space-network.mjs` | 84 | Within 300-line limit. |
| `server/codex-runner.js` | 257 | Within 300-line limit. |
| `server/codex-runner-events.js` | 202 | Within 300-line limit. |
| `server/codex-runner-event-format.js` | 135 | Within 300-line limit. |
| `cli/launch-agent.mjs` | 300 | At the configured limit. |

## Cleanup State

- Temporary Mac connector processes were stopped after authenticated verification.
- Managed local CodexMobile service was restarted without the temporary fixed pairing code environment.
- Docker relay container was rebuilt and restarted with image `codexmobile-relay:20260520-verify`; post-cleanup `/api/status` reported `relayStartedAt=2026-05-20T01:16:59.395Z`, `pairing_required`, `macConnected=false`.
- HuggingFace Space `main` was redeployed to `9a41bb0`; post-cleanup `/api/status` reported `relayStartedAt=2026-05-20T01:18:07.812Z`, `pairing_required`, `macConnected=false`.

## 仍未改变的历史债

- `client/src/App.jsx`、`client/src/styles.css`、`server/index.js` 在 `origin/main` 基线中已经超过 300 行；本次只修复本分支新增或本轮审查明确指出的 verifier 超限与验证语义问题。
- Realtime provider-ready 仍依赖真实 realtime API key；本轮继续只证明 relay tunnel 到 Mac，并保留显式 provider 配置错误。
