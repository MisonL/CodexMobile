# CR-RELAY-CLOSEOUT-2026-05-19

## 范围

本记录覆盖 `codex/relay-phase1` 的 2026-05-19 收口推进：文档口径、CI 门禁、复杂度治理、依赖安全、当前本地验证和线上 Space 验证。

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
| `scripts/relay-smoke.mjs` | 70 | 已拆为场景编排入口 |
| `scripts/relay-smoke-*.mjs` | 63-189 | fixture、assert helpers、scenario groups 均在 300 行以内 |
| `scripts/relay-mac-client.mjs` | 742 | 已拆出 config、body、backpressure、reconnect helper；仍需后续按 HTTP forwarding、streaming、realtime、connection loop 继续拆分 |
| `scripts/relay-mac-client-*.mjs` | 18-51 | 新 helper，300 行以内 |
| `server/relay-runtime.js` | 700 | 仍需后续按 auth、Mac connection、pending request、realtime tunnel 拆分 |

本轮继续拆低风险 helper 和 smoke 场景文件。剩余两个大状态机文件涉及 relay runtime 和真实 connector 行为，不在同一收口补丁中做大规模重写。

## 后续门禁边界

- Realtime provider-ready：当前已验证 `/ws/realtime` tunnel 到达 Mac；真实 provider-ready 仍要求本机配置 realtime API key 后执行 `npm run space:verify -- --url https://misonl-codexmobile-relay.hf.space --token <browser-device-token> --check-realtime --require-realtime-ready --require-mac --json`。
- Multi-Mac 正式路由：当前 PR 只实现歧义连接安全拒绝。正式支持多台 Mac 同时在线前，必须先定义 route id、浏览器选择 UI/API、token 与 route 绑定、连接抢占规则和 E2E smoke。
- 长期公网或多人使用：当前仍按可信网络/受控试运行定位。进入 hostile network 前，必须补 per-token request cap、长期审计日志、secret rotation 演练记录、指标/告警导出和代理 IP 信任策略复核。
- 手机端实机回归：自动化只证明桌面构建、本地 smoke、relay smoke 和 Space public/auth 链路。发布前仍需 iPhone PWA 安装、触控、小屏布局、浅色/深色主题和网络切换手工 smoke。
- PR checks 可见性：fork `Relay CI` 是当前自动化门禁；上游 PR `statusCheckRollup` 为空时，以 fork Actions run 和 PR 描述中的 run id 作为评审证据。如上游启用 branch protection，需要把同等 workflow 接入上游 checks。

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
| `GIT_TERMINAL_PROMPT=0 npm run space:deploy -- --remote https://huggingface.co/spaces/misonL/codexmobile-relay` | 0 | Deployed latest branch package to Space; Space `main` moved from `cd2eb3f` to `bb8febc`. |
| `npm run space:verify -- --url https://misonl-codexmobile-relay.hf.space --json` | 0 | Public checks passed 4/4; authenticated checks skipped without browser token or pair code. |
| Temporary local server + Mac connector + `verifySpace({ token, chatMessage, requireMac: true, checkRealtime: true, timeoutMs: 300000 })` | 0 | After latest Space deploy, authenticated checks passed 8/8; sync took 194220 ms and exposed 9 projects. |
| `npm audit --audit-level=moderate` | 0 | Found 0 vulnerabilities. |
| `git diff --check` | 0 | Passed. |
| 2026-05-19 follow-up syntax checks for split relay Mac client and relay smoke helper files | 0 | Passed. |
| 2026-05-19 follow-up `npm run smoke:relay` | 0 | Passed after helper and scenario split; output included `Relay smoke ok`. |
| 2026-05-19 follow-up `npm run test:space-verify` | 0 | Passed 11/11. |
| 2026-05-19 follow-up `HOST=127.0.0.1 PORT=9798 npm start ... && CODEXMOBILE_URL=http://127.0.0.1:9798/api/status npm run smoke` | 0 | Local server smoke passed and temporary server was stopped. |
| 2026-05-19 follow-up `npm run build` | 0 | Vite build passed. |
| 2026-05-19 follow-up `npm run space:verify -- --url https://misonl-codexmobile-relay.hf.space --json` | 0 | Public checks passed 4/4; authenticated checks skipped without browser token or pair code. |

## 线上复验边界

当前分支最新 relay package 已重新部署到 HuggingFace Space commit `bb8febc`。只读 Space verifier 通过，未连接 Mac 时线上状态为 `relayState=pairing_required macConnected=false`。随后使用临时本地 CodexMobile server、临时 `CODEXMOBILE_HOME`、固定 pairing code 和 ignored relay secret 启动 Mac connector，完成 authenticated Space verifier。

Authenticated checks:

- PWA load: passed.
- Relay status with Mac connector: passed, `macConnected=true`.
- Unauthenticated `/api/projects`: passed, `401 pairing_required`.
- Authenticated `/api/projects`: passed, `projects=9`.
- Browser `/ws`: passed, `relayState=ready`.
- `/ws/realtime --check-realtime`: passed as tunnel evidence; Mac local provider returned `voice.realtime.error` because realtime API key is not configured.
- `/api/chat/send`: passed, returned `202` and browser WebSocket event was received.

复验脚本没有打印或写入 browser token、relay secret 或 pairing code。临时 `CODEXMOBILE_HOME` 位于 `/tmp/codexmobile-closeout-state`，验证结束后已删除。

仍未把真实 realtime provider ready 作为门禁，因为本机未配置 realtime API key。如需该门禁，需配置 provider 后执行：

```bash
npm run space:verify -- --url https://misonl-codexmobile-relay.hf.space --token <browser-device-token> --check-realtime --require-realtime-ready --require-mac --json
```

## PR 状态

- PR: `https://github.com/RNG2018-mlxg/CodexMobile/pull/4`
- State: `OPEN`
- Draft: `false`
- Head: `codex/relay-phase1`
- Base: `main`
- Merge state: `CLEAN`
- Upstream PR status rollup: 当前 GitHub 返回空，未显示上游 PR checks。
- Fork CI: `.github/workflows/relay-ci.yml` 已定义 `Relay CI`，在 fork 分支 push 上覆盖 `npm ci`、relay 语法检查、`npm run test:space-verify`、`npm run smoke:relay`、本地 server smoke、`npm run build` 和 `git diff --check`。语法检查清单已包含拆分后的 relay Mac client 与 relay smoke helper。最新 head 是否通过以 GitHub Actions 当前 run 为准。

## 结论

本轮已完成文档口径对齐、CI 门禁定义、低风险复杂度拆分、依赖 audit 修复、本地验证闭环、最新 Space 部署复验和 PR ready 状态确认。当前剩余项不是隐藏失败路径，而是明确后续工作：

- 分阶段继续拆分 `server/relay-runtime.js` 和 `scripts/relay-mac-client.mjs` 的剩余状态机职责。
- 如产品需要多台 Mac 同时在线，再设计 explicit multi-Mac routing UI/API。
- 如进入多人、长期公网或 hostile network 使用场景，再补 per-token request cap、长期日志审计、secret rotation 演练记录、告警/指标导出和真实 provider-ready realtime 门禁。
