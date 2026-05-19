# CR-RELAY-CLOSEOUT-2026-05-19

## 范围

本记录覆盖 `codex/relay-phase1` 的 2026-05-19 收口推进：文档口径、CI 门禁、复杂度治理、依赖安全、当前本地验证和线上只读 Space 验证。

## 变更摘要

- 新增 `relay-branch-closeout.md`，把本分支剩余收口项整理为可验证清单。
- 新增 GitHub Actions workflow `.github/workflows/relay-ci.yml`，覆盖 `npm ci`、relay 语法检查、space verifier tests、relay smoke、本地 smoke、build 和 diff hygiene。
- 更新长期契约文档，统一当前 relay 已支持能力：
  - `/ws/realtime` WebSocket tunnel。
  - `/api/uploads` 与 `/api/voice/transcribe` request streaming。
  - `/generated/*` 与 `/api/voice/speech` response streaming。
  - 未接入 streaming 的其他大型路径仍必须显式失败。
  - 显式 multi-Mac 路由 UI/API 仍未实现；不同 `connectorInstanceId` 的并发 Mac connector 继续安全拒绝。
- 拆分 `server/relay-http.js`：
  - `server/relay-http-body.js`
  - `server/relay-http-static.js`
  - `server/relay-http-stream.js`
- 拆分 `tests/space-verify.test.mjs` fixture 到 `tests/space-verify-fixture.mjs`。
- 运行 `npm audit fix`，将 lockfile 中 `ws` 从 `8.20.0` 更新到 `8.20.1`，`npm audit --audit-level=moderate` 变为 0 vulnerabilities。

## 复杂度状态

| File | Lines | Status |
| --- | ---: | --- |
| `server/relay-http.js` | 225 | 已降到 300 行以内 |
| `server/relay-http-body.js` | 102 | 新 helper，300 行以内 |
| `server/relay-http-static.js` | 94 | 新 helper，300 行以内 |
| `server/relay-http-stream.js` | 164 | 新 helper，300 行以内 |
| `tests/space-verify.test.mjs` | 197 | 已降到 300 行以内 |
| `tests/space-verify-fixture.mjs` | 117 | 新 helper，300 行以内 |
| `server/relay-runtime.js` | 700 | 仍需后续按 auth、Mac connection、pending request、realtime tunnel 拆分 |
| `scripts/relay-mac-client.mjs` | 844 | 仍需后续按 config、HTTP forwarding、streaming、realtime、connection loop 拆分 |
| `scripts/relay-smoke.mjs` | 890 | 仍需后续按 fixture、assert helpers、scenario groups 拆分 |

本轮只拆低风险 helper。剩余三个大文件涉及运行时状态机和真实 connector 行为，不在同一收口补丁中做大规模重写。

## 验证记录

| Command | Exit | Result |
| --- | ---: | --- |
| `npm ci` | 0 | Installed from lockfile; postinstall patched Codex SDK; audit summary 0 vulnerabilities. |
| `node --check server/relay-server.js && node --check server/relay-runtime.js && node --check server/relay-http.js && node --check server/relay-http-body.js && node --check server/relay-http-static.js && node --check server/relay-http-stream.js && node --check server/relay-protocol.js && node --check scripts/relay-mac-client.mjs && node --check scripts/relay-smoke.mjs && node --check scripts/verify-hf-space-core.mjs && node --check tests/space-verify.test.mjs && node --check tests/space-verify-fixture.mjs` | 0 | Syntax checks passed. |
| `npm run test:space-verify` | 0 | Passed 11/11. |
| `npm run smoke:relay` | 0 | Passed; output included `Relay smoke ok`. |
| `npm run smoke` | 0 | Passed; output included local Codex status. |
| `HOST=127.0.0.1 PORT=9798 npm start ... && CODEXMOBILE_URL=http://127.0.0.1:9798/api/status npm run smoke` | 0 | CI-style local server start and smoke passed; server stopped after the check. |
| `npm run build` | 0 | Vite build passed. |
| `npm run space:prepare` | 0 | Generated `dist/hf-space`, 50 files. |
| `npm run space:verify -- --url https://misonl-codexmobile-relay.hf.space --json` | 0 | Public checks passed 4/4; authenticated checks skipped without browser token or pair code. |
| `npm audit --audit-level=moderate` | 0 | Found 0 vulnerabilities. |
| `git diff --check` | 0 | Passed. |

## 线上复验边界

当前只读 Space verifier 通过，线上状态为 `relayState=pairing_required macConnected=false`。本轮没有可用 browser token 或当前 pairing code，因此没有重复执行 authenticated `/api/projects`、browser `/ws`、`/api/chat/send` 或 `/ws/realtime --check-realtime`。

带真实 Mac connector 的最终复验仍需满足以下任一条件：

- 提供当前 Mac 本地 pairing code。
- 提供已存在 browser device token，但不得打印或写入仓库。

复验命令边界：

```bash
npm run space:verify -- --url https://misonl-codexmobile-relay.hf.space --pair-code <pairing-code> --chat-message "CodexMobile relay closeout verification" --check-realtime --require-mac --json
```

若要把真实 realtime provider ready 作为门禁，再追加：

```bash
--require-realtime-ready
```

## PR 状态

- PR: `https://github.com/RNG2018-mlxg/CodexMobile/pull/4`
- State: `OPEN`
- Draft: `true`
- Head: `codex/relay-phase1`
- Base: `main`
- Status checks: 当前 GitHub 返回空；新增 workflow 需要推送本轮改动后才会出现在 PR checks 中。

## 结论

本轮已完成文档口径对齐、CI 门禁定义、低风险复杂度拆分、依赖 audit 修复和本地验证闭环。当前剩余项不是隐藏失败路径，而是明确后续工作：

- 推送本轮改动后确认 GitHub Actions 通过。
- 具备 pairing code 或 browser token 后做 authenticated Space 复验。
- 将 PR 从 draft 切换为 ready for review。
- 分阶段拆分 `server/relay-runtime.js`、`scripts/relay-mac-client.mjs` 和 `scripts/relay-smoke.mjs`。
- 如产品需要多台 Mac 同时在线，再设计 explicit multi-Mac routing UI/API。
