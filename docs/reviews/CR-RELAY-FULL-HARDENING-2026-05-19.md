# CR-RELAY-FULL-HARDENING-2026-05-19

## 范围

本记录覆盖 `relay-full-hardening-goal.md` 的继续收口：当前 head 重新部署到 HuggingFace Space、authenticated Space E2E、realtime provider-ready 门禁、iPhone 移动视口 smoke、前端与非 relay 大文件拆分、CI 语法检查清单和产品级 hardening 边界。

## 变更摘要

- 前端拆分：
  - `client/src/PairingScreen.jsx`
  - `client/src/TopBar.jsx`
  - `client/src/FeishuLogoIcon.jsx`
  - `client/src/styles-foundation.css`
- 主服务拆分：
  - `server/http-utils.js`
  - `server/realtime-voice-config.js`
  - `server/realtime-voice-handoff.js`
  - `server/realtime-voice-providers.js`
  - `server/lark-cli-definitions.js`
  - `server/lark-cli-runner.js`
  - `server/lark-cli-status.js`
- 更新 `.github/workflows/relay-ci.yml`，把新增 server helper 纳入 `node --check`。
- 更新 `docs/relay-production-hardening-plan.md`，固化 multi-Mac、per-token cap、长期审计日志、指标/告警、公网多人安全和 realtime provider-ready 的后续任务边界。

## 复杂度状态

| File | Lines | Status |
| --- | ---: | --- |
| `server/realtime-voice.js` | 210 | 已降到 300 行以内 |
| `server/realtime-voice-config.js` | 276 | 新 helper，300 行以内 |
| `server/realtime-voice-handoff.js` | 222 | 新 helper，300 行以内 |
| `server/realtime-voice-providers.js` | 64 | 新 helper，300 行以内 |
| `server/lark-cli.js` | 276 | 已降到 300 行以内 |
| `server/lark-cli-runner.js` | 209 | 新 helper，300 行以内 |
| `server/lark-cli-status.js` | 236 | 新 helper，300 行以内 |
| `server/lark-cli-definitions.js` | 61 | 新 helper，300 行以内 |
| `server/index.js` | 1516 | 已抽出 HTTP 工具；仍需后续继续按路由职责拆分 |
| `client/src/App.jsx` | 4557 | 已抽出配对页、顶栏和飞书图标；仍需后续继续按组件拆分 |
| `client/src/styles.css` | 2373 | 已抽出基础和顶栏样式；仍需后续继续按页面/组件样式拆分 |

## 验证记录

| Command / Check | Exit | Result |
| --- | ---: | --- |
| relay/server/connector/verifier `node --check` 清单 | 0 | 包含新增 `server/http-utils.js`、`server/realtime-voice-*`、`server/lark-cli-*`，全部通过。 |
| `npm run test:space-verify` | 0 | Passed 11/11. |
| `npm run smoke:relay` | 0 | Passed; output included `Relay smoke ok`. |
| `CODEXMOBILE_URL=http://127.0.0.1:9798/api/status npm run smoke` with temporary local server | 0 | Passed; output included `Smoke ok`. |
| `npm run build` | 0 | Vite build passed. |
| `git diff --check` | 0 | Passed. |
| Chrome mobile viewport smoke | 0 | 390x844 touch viewport opened local PWA; pairing screen visible; input/button bounds valid; no horizontal overflow. |
| Chrome dark theme smoke | 0 | Set `codexmobile.theme=dark`, reloaded 390x844 viewport; `data-theme=dark`; no horizontal overflow. |
| `GIT_TERMINAL_PROMPT=0 npm run space:deploy -- --remote https://huggingface.co/spaces/misonL/codexmobile-relay` | 0 | Deployed current package; Space `main` moved from `a9c72b0` to `fdf3d17`. |
| `npm run space:verify -- --url https://misonl-codexmobile-relay.hf.space --json` | 0 | Public checks passed 4/4; authenticated checks skipped without token or pair code. |
| HuggingFace SDK `add_space_secret` for `CODEXMOBILE_RELAY_SECRET` | 0 | Space secret synchronized from ignored local state file; command did not print the secret. |
| Temporary local server + Mac connector + authenticated `space:verify --require-mac --check-realtime --chat-message ...` | 0 | Passed 9/9; projects=9, browser `/ws` relayState=ready, `/api/chat/send` returned 202, realtime tunnel reached Mac. |
| Strict `space:verify --require-realtime-ready` | 1 | Expected gate failure: `expected voice.realtime.ready, got voice.realtime.error: 未配置实时语音 API Key`. |

## 线上复验边界

- Space public verifier passed after the latest deploy.
- Authenticated Space E2E passed after synchronizing Space `CODEXMOBILE_RELAY_SECRET` with the ignored local secret file and starting a temporary Mac connector.
- Realtime tunnel is verified. Provider-ready is not verified because this machine does not currently configure a realtime voice API key.
- The temporary authenticated test used a temporary `CODEXMOBILE_HOME` under `/tmp` and was removed after verification.

## iPhone PWA 门禁

自动覆盖：

- 本地 PWA 首屏在 390x844 touch viewport 下可见。
- 明暗主题几何不溢出。
- Space PWA HTML 通过 public verifier。

仍需人工真机覆盖：

- iPhone 添加到主屏幕后的 standalone 启动。
- 触控输入、抽屉、发送、语音按钮和文档面板。
- 小屏、浅色/深色、横竖屏和键盘弹起。
- Wi-Fi、蜂窝、Tailscale 或公网 Space 网络切换。

## 结论

本轮可自动完成的部署、authenticated E2E、移动 viewport smoke、拆分和验证均已落地。剩余外部门禁是 realtime provider API key 和真实 iPhone PWA 手工回归，不作为当前 relay Phase 1 的隐藏通过项。
