# CR-RELAY-DOCKER-SPACE-FULL-VALIDATION-2026-05-19

## 范围

本记录覆盖当前 `codex/relay-phase1` 最新代码的两种部署场景复验：

- 本地 Docker relay：`http://127.0.0.1:9790`
- HuggingFace Space relay：`https://misonl-codexmobile-relay.hf.space`

验证过程中未记录 relay secret、browser token 或配对码明文。

## 修复

- `server/codex-runner.js`：将 Codex CLI 的 `Under-development features enabled: ...` 非致命 warning 降级为 activity，不再触发 `chat-error`。
- `server/codex-runner-events.js`：新增 Codex runner 事件策略 helper。
- `server/codex-runner-event-format.js`：拆出 stream item 字段提取、状态标签和 status-update 格式化逻辑，使 `server/codex-runner.js` 回到 300 行以内。
- `tests/codex-runner-events.test.mjs`：覆盖非致命 warning 与真实错误的区分。
- `package.json`：新增 `npm run test:server`，让服务端事件策略测试可重复执行。

## 本地验证

| 命令 | 退出码 | 结果 |
| --- | ---: | --- |
| `npm run test:cli` | 0 | 47 tests passed. |
| `npm run test:server` | 0 | 3 tests passed. Covers the warning classifier and full `emitCodexEvent` behavior for downgraded warnings vs real item errors. |
| `npm run test:space-verify` | 0 | 11 tests passed. |
| `npm run build` | 0 | Vite production build passed. |
| `npm run smoke` | 0 | Local service status smoke passed. |
| `npm run smoke:relay` | 0 | Relay smoke passed, including offline, invalid connector, ambiguous route, body limit, pending limit, reconnect, streaming, and realtime tunnel paths. |
| Relay syntax check list | 0 | `server/relay-server.js`, `server/relay-runtime.js`, `server/relay-http.js`, `server/codex-runner.js`, `server/codex-runner-events.js`, `server/codex-runner-event-format.js`, `scripts/relay-mac-client.mjs`, `scripts/verify-hf-space-core.mjs`, `scripts/prepare-hf-space.mjs`, and `scripts/deploy-hf-space.mjs` passed `node --check`. |
| `git diff --check` | 0 | Passed. |
| Complexity line check | 0 | `server/codex-runner.js` 257 lines, `server/codex-runner-events.js` 202 lines, `server/codex-runner-event-format.js` 135 lines. |

## 本地 Docker 部署

| Item | Value |
| --- | --- |
| Image | `codexmobile-relay:20260519-events` |
| Container | `codexmobile-relay-docker-smoke` |
| Local URL | `http://127.0.0.1:9790` |
| Mac local service | managed local service `http://127.0.0.1:3321` |
| Connector | host process, `ws://127.0.0.1:9790/relay/mac` |

Docker build:

- `docker build -t codexmobile-relay:20260519-events .`
- Exit: 0
- Build included `npm ci` and `npm run build`.

Docker public probes:

- `npm run space:verify -- --url http://127.0.0.1:9790 --json`
- Exit: 0
- Passed 4/4 public checks: built PWA HTML, safe relay status, explicit realtime HTTP fallback, unauthenticated projects returned `pairing_required`.

Docker authenticated verifier:

- `npm run space:verify -- --url http://127.0.0.1:9790 --pair-code <redacted> --device-name docker-smoke --require-mac --check-realtime --chat-message "请只回复 ok" --timeout-ms 300000 --json`
- Exit: 0

| Check | Result |
| --- | --- |
| PWA load | passed |
| Relay status | passed, `macConnected=true` |
| Realtime HTTP fallback | passed |
| Unauthenticated projects | passed |
| Pair through relay | passed |
| Authenticated projects | passed, `projects=9` |
| Browser WebSocket | passed, `relayState=ready` |
| Realtime WebSocket tunnel | passed, tunnel reached Mac and returned explicit provider configuration error |
| Chat send | passed, returned `202` |

Additional Docker chat terminal check:

- Browser WebSocket observed `chat-complete` for the submitted turn using a separate terminal-event check.
- This confirms the relay accepted the request and the downstream Codex run reached terminal success after the non-fatal warning fix.

Strict realtime provider-ready gate:

- `npm run space:verify -- --url http://127.0.0.1:9790 --pair-code <redacted> --device-name docker-realtime-strict --require-mac --require-realtime-ready --timeout-ms 120000 --json`
- Exit: 1, expected.
- Reason: `voice.realtime.error: 未配置实时语音 API Key`.

## HuggingFace Space 部署

| Item | Value |
| --- | --- |
| Space repo | `misonL/codexmobile-relay` |
| Space URL | `https://misonl-codexmobile-relay.hf.space` |
| Deploy command | `GIT_TERMINAL_PROMPT=0 npm run space:deploy -- --remote https://huggingface.co/spaces/misonL/codexmobile-relay` |
| Space branch | `main` |
| Previous Space commit | `9276190` |
| New Space commit | `ec18b5a` |

Deploy result:

- `npm run space:prepare` generated `dist/hf-space`.
- Temporary Space git repo committed generated files as `deploy: CodexMobile Relay`.
- `git push --force` updated Space `main` from `9276190` to `ec18b5a`.
- Exit: 0.
- Space warm-up was checked through `/api/status`; the new relay process reported `relayStartedAt=2026-05-19T14:17:36.830Z`.

Space public verifier:

- `npm run space:verify -- --url https://misonl-codexmobile-relay.hf.space --json`
- Exit: 0

| Check | Result |
| --- | --- |
| PWA load | passed |
| Relay status | passed, `relayState=pairing_required macConnected=true` |
| Realtime HTTP fallback | passed |
| Unauthenticated projects | passed, `pairing_required` |

Space authenticated verifier:

- Initial authenticated reruns during Space warm-up produced transient `fetch failed` and `WebSocket 503` failures. After `/api/status` returned the new relay process and the Mac connector reconnected, the same verifier passed.
- `npm run space:verify -- --url https://misonl-codexmobile-relay.hf.space --pair-code <redacted> --device-name space-smoke-stable --require-mac --check-realtime --chat-message "请只回复 ok" --timeout-ms 300000 --json`
- Exit: 0

| Check | Result |
| --- | --- |
| PWA load | passed |
| Relay status | passed, `macConnected=true` |
| Realtime HTTP fallback | passed |
| Unauthenticated projects | passed |
| Pair through Space | passed |
| Authenticated projects | passed, `projects=9` |
| Browser WebSocket | passed, `relayState=ready` |
| Realtime WebSocket tunnel | passed, tunnel reached Mac and returned explicit provider configuration error |
| Chat send | passed, returned `202` |

Additional Space chat terminal check:

- Browser WebSocket observed `chat-complete` for the submitted turn using a separate terminal-event check.

Strict realtime provider-ready gate:

- `npm run space:verify -- --url https://misonl-codexmobile-relay.hf.space --pair-code <redacted> --device-name space-realtime-strict --require-mac --require-realtime-ready --timeout-ms 120000 --json`
- Exit: 1, expected.
- Reason: `voice.realtime.error: 未配置实时语音 API Key`.

## Browser Smoke

| Target | Viewport | Result |
| --- | --- | --- |
| `http://127.0.0.1:9790` | mobile 390x844 | Pairing screen rendered with root mounted, input and connect button visible, `overflowX=0`. |
| `https://misonl-codexmobile-relay.hf.space` | mobile 390x844 | Pairing screen rendered with root mounted, input and connect button visible, `overflowX=0`. |

## Cleanup State

- Temporary Mac connector processes used for Docker and Space authenticated checks were stopped after verification.
- The managed local CodexMobile service was restarted without the temporary fixed pairing code environment.
- Docker relay container remains running as `codexmobile-relay-docker-smoke` on `127.0.0.1:9790` using image `codexmobile-relay:20260519-events`.
- Post-cleanup status checks show both Docker and Space relays in `pairing_required` with `macConnected=false`, which is expected after stopping the temporary connectors.

## 结论

- 当前最新代码已完成本地 Docker relay 和 HuggingFace Space relay 的 public、authenticated、WebSocket、realtime tunnel、chat send、chat terminal event、移动视口 smoke 验证。
- Realtime tunnel 已验证；provider-ready 未验证，原因是本机未配置 realtime voice API key。
- 真实 iPhone 添加到主屏幕、实体触控、横竖屏、键盘弹起、蜂窝和 Wi-Fi 网络切换仍属于人工真机门禁，不能由本轮自动验证替代。
