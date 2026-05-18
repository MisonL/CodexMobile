# CR-RELAY-REALTIME-TUNNEL-2026-05-18

## 范围

本记录覆盖 `/ws/realtime` realtime voice relay tunnel：浏览器连接 Space `/ws/realtime` 后，由 Space 通过 Mac connector 打开 Mac 本地 `/ws/realtime`，并在两条 WebSocket 之间转发文本和二进制帧。

## 变更摘要

- Space relay upgrade handler 不再对 `/ws/realtime` WebSocket 返回 `501`，而是先校验 browser token，再创建 realtime tunnel。
- Mac connector 新增 `realtime.open`、`realtime.frame`、`realtime.close` 和 `realtime.error` 处理。
- realtime tunnel 帧绑定 `requestId`、`macConnectionEpoch`、单调 `sequence` 和 `bytes`，序号或字节数不匹配时关闭隧道。
- HTTP 方式访问 `/ws/realtime` 仍明确返回 `501 relay_realtime_http_upgrade_required`，避免把非 WebSocket 请求静默转发。
- 文档和 Space verify 口径改为区分 WebSocket tunnel 与 HTTP fallback。

## TDD 记录

| Step | Command | Exit | Result |
| --- | --- | --- | --- |
| Red | `npm run smoke:relay` | 1 | 新增 realtime tunnel 用例收到 `Unexpected server response: 501`。 |

## 验证记录

| Command | Exit | Result |
| --- | --- | --- |
| `node --check server/relay-runtime.js` | 0 | Passed. |
| `node --check server/relay-server.js` | 0 | Passed. |
| `node --check server/relay-http.js` | 0 | Passed. |
| `node --check server/relay-protocol.js` | 0 | Passed. |
| `node --check scripts/relay-mac-client.mjs` | 0 | Passed. |
| `node --check scripts/relay-smoke.mjs` | 0 | Passed. |
| `node --check scripts/verify-hf-space-core.mjs` | 0 | Passed. |
| `node --check tests/space-verify.test.mjs` | 0 | Passed. |
| `npm run smoke:relay` | 0 | Passed; realtime tunnel forwarded local ready event, browser ping, and binary frame through the real relay server and real connector. |
| `npm run smoke` | 0 | Passed. |
| `npm run test:space-verify` | 0 | Passed, 4 tests. |
| `npm run build` | 0 | Passed. |

## 结论

Realtime voice now has a local relay tunnel path verified through the real relay server, real Mac connector process, and local WebSocket fixture. Remaining full-goal work still includes real Space redeploy, frontend runtime review, explicit multi-Mac routing UI/API, and final PR/git收口.
