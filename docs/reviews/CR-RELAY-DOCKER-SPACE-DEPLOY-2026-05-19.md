# CR-RELAY-DOCKER-SPACE-DEPLOY-2026-05-19

## 范围

本记录覆盖 2026-05-19 对 `codex/relay-phase1` 的两阶段真实部署验证：

1. 本机 Docker relay 部署与宿主机 Mac connector 验证。
2. HuggingFace Space 公网部署与公网 authenticated relay 验证。

验证过程中未记录 relay secret、browser token 或配对码明文。

## 本机 Docker 部署

| Item | Value |
| --- | --- |
| Image | `codexmobile-relay:b796c9f` |
| Container | `codexmobile-relay-docker-smoke` |
| Local URL | `http://127.0.0.1:9790` |
| Mac local service | temporary `http://127.0.0.1:9798` |
| Connector | host process, `ws://127.0.0.1:9790/relay/mac` |

Docker build result:

- `docker build -t codexmobile-relay:238daa4 .` followed by `docker tag codexmobile-relay:238daa4 codexmobile-relay:b796c9f` after committing the verifier fix.
- Exit: 0
- Build included `npm ci` and `npm run build`.
- Vite build produced `dist/index.html` and client assets.

Docker public probe:

- `/api/status`: `mode=relay`, `relayState=pairing_required`, `macConnected=false`.
- `/`: returned built PWA HTML with `id="root"`.
- Unauthenticated `/api/projects`: returned `401 pairing_required`.
- Status limits included `browserTokenRequestsPerMinute=120` and `browserTokenRequestWindowMs=60000`.
- Final local Docker container was recreated from `codexmobile-relay:b796c9f` on `127.0.0.1:9790`; final status probe returned `mode=relay`, `relayState=pairing_required`, `macConnected=false`.

Docker authenticated verifier:

| Check | Result |
| --- | --- |
| PWA load | passed, built PWA HTML |
| Relay status | passed, `relayState=pairing_required macConnected=true` |
| Realtime HTTP fallback | passed, `relay_realtime_http_upgrade_required` |
| Unauthenticated projects | passed, `pairing_required` |
| Pair through relay | passed |
| Authenticated projects | passed, `projects=1` |
| Browser WebSocket | passed, `relayState=ready` |
| Realtime WebSocket tunnel | passed, tunnel reached Mac and returned explicit provider configuration error |
| Chat send | skipped, no `--chat-message` was passed to avoid creating a real Codex request |

## Verifier 修复

Docker authenticated verifier first exposed a false positive in `space:verify`: the sensitive field scanner treated `limits.browserTokenRequestsPerMinute` as token leakage because the safe metric name contains `Token`.

Fix:

- Added safe status field allowlist for per-token limit and metric names.
- Updated the Space verifier fixture to include these fields by default.
- Verification: `node --check scripts/verify-hf-space-core.mjs && node --check tests/space-verify-fixture.mjs && npm run test:space-verify`
- Exit: 0, `tests=11 pass=11`.

## HuggingFace Space 部署

| Item | Value |
| --- | --- |
| Space repo | `misonL/codexmobile-relay` |
| Space URL | `https://misonl-codexmobile-relay.hf.space` |
| Deploy command | `GIT_TERMINAL_PROMPT=0 npm run space:deploy -- --remote https://huggingface.co/spaces/misonL/codexmobile-relay` |
| Space branch | `main` |
| Space deploy commit | `e46d15f` |
| Previous Space commit | `fdf3d17` |

Deploy result:

- `npm run space:prepare` generated `dist/hf-space`.
- Temporary Space git repo committed generated files as `deploy: CodexMobile Relay`.
- `git push --force` updated Space `main` from `fdf3d17` to `e46d15f`.
- Exit: 0.

## Space 公网验证

Public verifier:

| Check | Result |
| --- | --- |
| PWA load | passed, built PWA HTML |
| Relay status | passed, `relayState=pairing_required macConnected=false` |
| Realtime HTTP fallback | passed, `relay_realtime_http_upgrade_required` |
| Unauthenticated projects | passed, `pairing_required` |
| Authenticated checks | skipped, missing browser token or pair code |

Authenticated verifier with temporary local service and Mac connector:

| Check | Result |
| --- | --- |
| PWA load | passed, built PWA HTML |
| Relay status | passed, `relayState=pairing_required macConnected=true` |
| Realtime HTTP fallback | passed, `relay_realtime_http_upgrade_required` |
| Unauthenticated projects | passed, `pairing_required` |
| Pair through Space | passed |
| Authenticated projects | passed, `projects=1` |
| Browser WebSocket | passed, `relayState=ready` |
| Realtime WebSocket tunnel | passed, tunnel reached Mac and returned explicit provider configuration error |
| Chat send | skipped, no `--chat-message` was passed to avoid creating a real Codex request |

## 边界

- 本轮已真实部署 Docker relay 和 HuggingFace Space relay。
- 公网 Space 验证覆盖了 PWA、status、安全边界、配对、项目列表、browser WebSocket 和 realtime tunnel。
- Realtime provider-ready 未作为通过项，因为本机没有配置 realtime voice API key；返回的是明确的 `voice.realtime.error`。
- Chat send 未触发，避免创建真实 Codex 请求和消耗模型额度；如需测试发送消息，应单独传入 `--chat-message` 并接受该副作用。
