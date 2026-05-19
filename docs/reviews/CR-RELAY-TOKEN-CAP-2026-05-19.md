# CR-RELAY-TOKEN-CAP-2026-05-19

## 范围

本记录覆盖 `codex/relay-phase1` 在 2026-05-19 增补的 per-token request cap、可观测指标、审计日志口径和不依赖真机或外部 API key 的自动化验证。

## 行为边界

- 默认限流参数：
  - `CODEXMOBILE_RELAY_TOKEN_REQUESTS_PER_MINUTE=120`
  - `CODEXMOBILE_RELAY_TOKEN_REQUEST_WINDOW_MS=60000`
- 限流 key 使用 browser token hash，不记录明文 token。
- 计入 cap 的路径：
  - 已鉴权 HTTP relay 转发，例如 `/api/projects`。
  - 已鉴权 generated asset relay，例如 `/generated/*`。
  - 已鉴权 browser WebSocket upgrade：`/ws`。
  - 已鉴权 realtime WebSocket upgrade：`/ws/realtime`。
- 不计入 cap 的路径：
  - `/api/status`，用于故障诊断和观测。
  - `/api/pair`，继续使用独立 client IP 维度限流。
  - token validation miss，继续使用独立 token hash + client IP 维度限流。
- 超限语义：
  - HTTP 返回 `429`，body 为 `error=relay_rate_limited`、`reason=relay_token_request_limit_exceeded`、`retryAfter>0`。
  - WebSocket upgrade 返回 `429 Too Many Requests`，包含 `Retry-After` header。
  - 其他 browser token 不受当前 token 的 cap 牵连。

## 可观测指标

`/api/status` 暴露以下限流配置和计数：

| Field | 语义 |
| --- | --- |
| `limits.browserTokenRequestsPerMinute` | 当前 browser token 请求窗口上限。 |
| `limits.browserTokenRequestWindowMs` | 当前 browser token 请求窗口毫秒数。 |
| `metrics.browserTokenRequestsTotal` | 已接纳的 browser token relay 请求和 WebSocket upgrade 总数。 |
| `metrics.browserTokenRateLimitedTotal` | 被 per-token request cap 拒绝的请求和 WebSocket upgrade 总数。 |
| `metrics.rateLimitedTotal` | 所有限流拒绝总数，包含 per-token、pending、pair、Mac auth 等来源。 |

## 审计日志口径

per-token request cap 命中时记录结构化事件：

```text
event=relay.rate_limited
reason=relay_token_request_limit_exceeded
retryAfter=<seconds>
transport=websocket
```

HTTP 命中同一 cap 时也记录 `relay.rate_limited`，包含 `reason=relay_token_request_limit_exceeded` 和 `retryAfter`。日志不得包含 browser token 明文、relay secret、请求 body 或敏感 query。

## 自动化覆盖

`npm run smoke:relay` 已覆盖：

- `/api/status` 暴露 per-token limits。
- 同一 browser token 在窗口内前 120 次 `/api/projects` 转发到 Mac。
- 第 121 次同 token HTTP 请求返回 `429 relay_rate_limited`、`reason=relay_token_request_limit_exceeded`、`retryAfter>0`。
- 同一 token 被打满后，`/ws` WebSocket upgrade 返回 429 且包含 `Retry-After`。
- 不同 browser token 仍可正常转发。
- `/api/status` 暴露 `browserTokenRequestsTotal` 和 `browserTokenRateLimitedTotal`。

## 验证记录

| Command / Check | Exit | Result |
| --- | ---: | --- |
| Relay CI syntax `node --check` 清单 | 0 | 覆盖 relay server/runtime/http、Mac client、relay smoke、Space verifier 和相关 helper。 |
| `npm run test:space-verify` | 0 | Passed 11/11。 |
| `npm run smoke:relay` | 0 | Passed，输出包含 `Relay smoke ok`。 |
| CI-style local server smoke on `127.0.0.1:9798` | 0 | 临时启动 `npm start` 后执行 `CODEXMOBILE_URL=http://127.0.0.1:9798/api/status npm run smoke`，输出包含 `Smoke ok`。 |
| `npm run build` | 0 | Vite build passed。 |
| `git diff --check` | 0 | Passed。 |

## 结论

本轮 per-token request cap、可观测指标、审计日志口径和自动化验证已在本地闭环。该验证不依赖真机、HuggingFace Space 在线状态、外部 realtime provider API key 或手工 browser token。
