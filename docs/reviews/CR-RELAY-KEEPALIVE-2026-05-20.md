# CR-RELAY-KEEPALIVE-2026-05-20

本记录覆盖 Space keepalive 机制审查和补强。范围包括 Mac connector keepalive helper、connector 接入、配置解析、README、部署 runbook 和 relay 设计文档。

## Review Findings

- 已修复：keepalive URL 派生原先未拒绝非 WebSocket relay URL，`https://.../relay/mac` 会被错误降级为 `http://.../api/status?keepalive=1`。现在仅接受 `ws:` 和 `wss:`，否则抛出 `relay_keepalive_invalid_relay_url`。
- 已修复：Claude 第一轮复查发现 keepalive URL 派生会保留 URL userinfo。现在 `wss://user:pass@host/relay/mac` 会被拒绝，避免凭据进入 HTTP keepalive URL。
- 已修复：Gemini 第一轮复查发现 keepalive fetch response body 未释放，长期运行可能影响连接复用。现在每次 ping 后会 cancel response body。
- 已修复：`CODEXMOBILE_RELAY_KEEPALIVE_MS` 原先允许极小正数，误配可能造成高频请求。现在 `0` 显式关闭，活动间隔低于 `60000` 时回退默认 `240000`。
- 已修复：定时 keepalive 原先可能在上一轮请求未完成时继续发起新请求。现在同一时刻只允许一个 keepalive ping in flight。
- 已修复：旧设计文档仍写着不得用人工流量阻止 Space 休眠，与当前 keepalive 要求冲突。现已改为低频、可配置、可关闭、无密钥的 HTTP keepalive 契约。

## Mechanism Assessment

- 正确性：Mac connector 对 Space 同源 `/api/status?keepalive=1` 做未认证 HTTP GET，不转发到 Mac，不消耗 browser token request cap，不改变 relay 请求转发语义。
- 安全性：keepalive 请求不携带 relay secret、browser token、cookie 或请求体；日志只记录状态码或错误信息。
- 可靠性：失败记录为 `keepalive_failed`，不伪装成功；请求超时为 10 秒；重连和 WebSocket heartbeat 逻辑保持独立。
- 可配置性：默认 `240000` ms，最小活动间隔 `60000` ms，`0` 可关闭。
- 可观测性：成功日志为 `state=keepalive status=...`，失败日志为 `state=keepalive_failed reason=...`。

## External Review

| Reviewer | Result |
| --- | --- |
| Claude first pass | Warning: reject relay URL userinfo before deriving HTTP keepalive URL. Fixed with regression test. |
| Gemini first pass | Warning: release or consume fetch response body. Fixed with regression test. |
| agy first pass | Blocked by CLI authentication timeout; no review result produced. |
| Claude second pass | No blocking findings; no Critical, Warning or Info findings. |
| Gemini second pass | No blocking findings; implementation considered robust. |

## Validation

| Command | Exit | Result |
| --- | --- | --- |
| `node --test tests/relay-mac-client-keepalive.test.mjs` | 0 | 10 keepalive tests passed. |
| `npm run test:relay-mac` | 0 | 11 relay Mac tests passed. |
| `npm run test:cli` | 0 | 47 CLI tests passed. |
| `npm run test:space-verify` | 0 | 12 Space verifier tests passed. |
| `npm run smoke:relay` | 0 | Relay smoke passed; expected negative-path logs included offline Mac, invalid connector id, ambiguous route, body limit, pending limit and reconnect. |
| `npm run build` | 0 | Vite production build passed. |
| `node --check scripts/relay-mac-client-keepalive.mjs && node --check scripts/relay-mac-client-config.mjs && node --check scripts/relay-mac-client.mjs && node --check scripts/prepare-hf-space.mjs` | 0 | Syntax checks passed. |
| `git diff --check` | 0 | No whitespace errors. |

## Remaining Risk

- 本轮未重新部署真实 HuggingFace Space，也未等待真实平台休眠窗口验证 keepalive 是否长期阻止休眠。
- HuggingFace 官方文档确认 free hardware 会在未使用一段时间后 sleep；是否允许长期依赖 keepalive 防休眠属于平台策略风险，仍需线上运行观察。
- keepalive 只能在 Mac connector 进程存活时工作；Mac 休眠、网络断开或 connector 退出时，Space 仍可能进入 sleep。
