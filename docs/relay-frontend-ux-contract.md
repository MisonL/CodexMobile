# CodexMobile Relay 前端状态 UX 契约

本文定义 relay 模式下前端如何展示状态、禁用能力和处理错误。底层传输契约见 `docs/relay-system-design.md`。

## 1. 状态来源

前端状态来自：

- `GET /api/status`
- 浏览器 `/ws` 首包 `connected`
- 后续 `relay-status`
- API 错误体 `{ "error": "..." }`

优先级：

1. 最近一次明确错误，例如 `429 relay_rate_limited`。
2. 最新 `relay-status`。
3. 最近一次 `/api/status`。
4. 本地 WebSocket 连接状态。

前端不得因为 Space 可访问就显示 Codex ready。只有 Space、Mac connector 和 Mac 本地服务都可用时才显示可执行状态。

## 2. UI 状态映射

| relay state | 判断条件 | 顶栏 | 主要操作 | 自动重试 |
| --- | --- | --- | --- | --- |
| `pairing_required` | `authenticated=false` 或 401 `pairing_required` | 需要配对 | 显示配对页，禁用项目和发送 | 否 |
| `mac_offline` | `macConnected=false` | Mac 未连接 | 禁用发送、上传、语音、图片；允许刷新状态 | 是 |
| `mac_local_offline` | `localStatus.reachable=false` | 本地服务离线 | 禁用业务操作；提示先启动 Mac 本地服务 | 是 |
| `ready` | `authenticated=true`、`macConnected=true`、`localStatus.reachable=true` | 已连接 | 允许文本、普通 `/ws`、streaming media 与 realtime voice | 是 |
| `degraded` | 计数器显示 timeout 或 heartbeat miss 上升 | 连接不稳定 | 允许轻量操作，显示非阻塞提示 | 是 |
| `rate_limited` | 429 `relay_rate_limited` | 请求过快 | 禁用触发该限流的按钮到 `retryAfter` | 延迟 |
| `unsupported` | 501 `relay_streaming_required`、`relay_realtime_unsupported` 或 `relay_realtime_http_upgrade_required` | 中转暂不支持 | 显示功能级提示，不清除登录态 | 否 |
| `disconnected` | 浏览器 `/ws` 断开且 HTTP status 不可用 | 已断开 | 保留页面状态，禁用新请求 | 是 |

## 3. Phase 1 功能开关

Relay Phase 1 允许：

- 加载 PWA。
- 配对。
- 项目与会话列表。
- 文本 chat send。
- 普通 `/ws` 事件。
- 显式小体积 JSON / text API。

Relay request streaming 已允许：

- `/api/uploads` 上传文件。
- `/api/voice/transcribe` 语音转写上传。

Relay response streaming 已允许：

- `/generated/*` 生成图片二进制读取。
- `/api/voice/speech` 语音朗读音频流。

Relay realtime tunnel 已允许：

- `/ws/realtime` 实时语音。

Relay 仍禁用或提示不支持：

- 大响应下载。

禁用规则：

- 不要隐藏功能入口导致用户以为数据丢失。
- 对暂不支持的功能显示明确提示：“中转模式暂不支持此能力，请使用本地直连或 Tailscale”。
- 不要把 unsupported 误处理为登录失效。

## 4. 错误文案

| error | 用户可见文案 | 行为 |
| --- | --- | --- |
| `pairing_required` | 需要重新配对这台 Mac。 | 跳转配对页或显示配对弹层。 |
| `mac_offline` | Mac 连接器未在线。 | 保留当前页面，禁用新任务，自动刷新状态。 |
| `mac_local_offline` | Mac 本地 CodexMobile 服务未启动。 | 提示在 Mac 上启动 `npm start`。 |
| `relay_request_timeout` | 中转请求超时。 | 允许重试，不清除 token。 |
| `mac_reconnected` | Mac 连接已刷新，请重试。 | 自动刷新状态，允许重试。 |
| `relay_body_too_large` | 当前中转模式不支持这么大的内容。 | 保留输入，不自动重试。 |
| `relay_streaming_required` | 此能力需要本地直连或后续流式中转支持。 | 不清除 token。 |
| `relay_realtime_unsupported` | 实时语音中转不可用。 | 保留登录态，提示检查 Space、Mac connector 和本地服务版本。 |
| `relay_realtime_http_upgrade_required` | 实时语音需要 WebSocket 连接。 | 不清除 token。 |
| `relay_rate_limited` | 请求过快，请稍后再试。 | 按 `retryAfter` 禁用对应操作。 |

## 5. 前端验收

必须覆盖：

- `connected` 首包能更新 relay status。
- `relay-status` 后续广播能更新 Mac 在线与 local status。
- Mac 离线后，发送按钮不可继续提交新任务。
- `mac_local_offline` 不会清除浏览器 token。
- 501 unsupported 不会跳转配对页。
- 429 rate limit 会给出可恢复提示。
- Space 重启后，前端能重新连接并重新拉取 `/api/status`。

建议 Playwright 场景：

- mock `/api/status` 为每个 relay state，截图确认顶栏、按钮和提示。
- mock `/api/chat/send` 返回 `503 mac_offline`，确认输入不丢失。
- mock `/ws/realtime` WebSocket 转发 `voice.realtime.ready`，确认实时语音入口可进入 ready 状态。
