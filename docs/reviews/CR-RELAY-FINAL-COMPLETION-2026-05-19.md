# CR-RELAY-FINAL-COMPLETION-2026-05-19

## 范围

本记录覆盖 `codex/relay-phase1` 在 `CR-RELAY-CLOSEOUT-2026-05-19` 之后的继续收口：最终目标定义、relay runtime 拆分、Mac connector 拆分、前端低风险拆分、当前验证和仍需外部条件的门禁。

## 本轮目标

根目录新增 `relay-final-completion.md`，将剩余工作统一为一个完成目标：可完成的代码拆分和自动化验证在本分支落地；需要真实 provider、真实手机或产品决策的项目只记录为外部门禁，不伪装为当前分支已覆盖。

## 变更摘要

- 拆分 `server/relay-runtime.js`：
  - `server/relay-runtime-mac.js`
  - `server/relay-runtime-realtime.js`
  - `server/relay-runtime-stream-response.js`
- 拆分 `scripts/relay-mac-client.mjs`：
  - `scripts/relay-mac-client-http.mjs`
  - `scripts/relay-mac-client-http-response.mjs`
  - `scripts/relay-mac-client-local.mjs`
  - `scripts/relay-mac-client-realtime.mjs`
- 前端低风险拆分：
  - `client/src/relay-status.js` 提供 relay status 默认值与状态推导。
  - `client/src/voice-utils.js` 提供实时语音错误与语音交接命令判断。
- 更新 `.github/workflows/relay-ci.yml`，将新增 helper 纳入语法检查。

## 复杂度状态

| File | Lines | Status |
| --- | ---: | --- |
| `server/relay-runtime.js` | 288 | 已降到 300 行以内 |
| `server/relay-runtime-mac.js` | 203 | 新 helper，300 行以内 |
| `server/relay-runtime-realtime.js` | 167 | 新 helper，300 行以内 |
| `server/relay-runtime-stream-response.js` | 41 | 新 helper，300 行以内 |
| `scripts/relay-mac-client.mjs` | 242 | 已降到 300 行以内 |
| `scripts/relay-mac-client-http.mjs` | 266 | 新 helper，300 行以内 |
| `scripts/relay-mac-client-http-response.mjs` | 67 | 新 helper，300 行以内 |
| `scripts/relay-mac-client-local.mjs` | 133 | 新 helper，300 行以内 |
| `scripts/relay-mac-client-realtime.mjs` | 138 | 新 helper，300 行以内 |
| `client/src/App.jsx` | 4658 | 已抽出 relay status 与 voice utils；组件级拆分仍需后续单独任务 |
| `client/src/styles.css` | 2554 | 未做视觉行为改动；样式拆分仍需后续单独任务 |

## 验证记录

| Command | Exit | Result |
| --- | ---: | --- |
| `node --check server/relay-server.js ... scripts/verify-hf-space-core.mjs` | 0 | Relay runtime、Mac connector、smoke、Space verifier 相关文件语法检查通过。 |
| `npm run smoke:relay` | 0 | Passed; output included `Relay smoke ok`. |
| `npm run test:space-verify` | 0 | Passed 11/11. |
| `npm run build` | 0 | Vite build passed. |
| `HOST=127.0.0.1 PORT=9798 npm start ... && CODEXMOBILE_URL=http://127.0.0.1:9798/api/status npm run smoke` | 0 | Temporary local server smoke passed; output included `Smoke ok`. |
| `npm run space:verify -- --url https://misonl-codexmobile-relay.hf.space --json` | 0 | Public checks passed 4/4; authenticated checks skipped without browser token or pair code. |
| `git diff --check` | 0 | Passed. |

## 当前 PR 与 CI 状态

- PR: `https://github.com/RNG2018-mlxg/CodexMobile/pull/4`
- Remote PR state after pushing this follow-up: `OPEN`
- Draft: `false`
- Merge state: `CLEAN`
- Upstream `statusCheckRollup`: empty
- Latest pushed head: `62a0db079ddd9fc74c72b6eebfbfb73c103db8f9`
- Latest fork CI: `Relay CI` run `26072308043`, success
- CI URL: `https://github.com/MisonL/CodexMobile/actions/runs/26072308043`

上游 PR 仍未返回 `statusCheckRollup`，因此当前以 fork `Relay CI` run 和本地验证记录作为评审证据。

## 外部门禁

- Realtime provider-ready：当前仍只证明 relay tunnel 和 public fallback。若要证明真实 provider ready，需要本机配置 realtime API key，并使用 browser token 或 pair code 运行 `npm run space:verify -- --url https://misonl-codexmobile-relay.hf.space --token <browser-device-token> --check-realtime --require-realtime-ready --require-mac --json`。
- iPhone PWA 实机：需要真实 iPhone 执行安装、触控、小屏、浅色/深色、网络切换和 Space 配对 smoke。
- Multi-Mac 正式路由：当前分支仍只实现歧义连接安全拒绝。正式支持多台 Mac 需另行设计 route id、浏览器选择 UI/API、token 绑定和 E2E smoke。
- 公网/多人长期使用：当前仍是可信网络/受控试运行边界。进入 hostile network 前，需要 per-token request cap、长期审计日志、secret rotation 演练记录、指标/告警导出和代理 IP 信任策略复核。

## 结论

本轮已把可本地完成的 relay runtime 与 Mac connector 大文件拆分推进到 300 行约束以内，并用 relay smoke、Space verifier tests、前端 build、本地 server smoke 和 public Space verifier 复验。剩余未完成项属于组件级前端持续拆分或需要外部真实条件的产品/运维门禁，不是当前 relay Phase 1 的隐藏失败路径。
