# HuggingFace Space 中转 Mac 客户端设计

共享中转契约定义在 `docs/relay-system-design.md`。如本文与体系设计冲突，以体系设计为准。

真实部署、connector 安全边界、密钥轮换、观测和 Phase 2 streaming 门禁见 `docs/relay-production-hardening-plan.md`。部署步骤见 `docs/relay-deployment-runbook.md`，前端状态 UX 见 `docs/relay-frontend-ux-contract.md`。

## 1. 目标

Mac 客户端是运行在 Codex 所在 Mac 上的本地 connector 进程。它主动通过 WebSocket 连接 HuggingFace Space 中转服务，接收中转服务转发的浏览器请求，在本地 CodexMobile 运行时执行，并把响应和 Codex 事件回传给中转服务。

Space 不需要入站访问 Mac。Mac 主动发起并持有长连接。

这是增量远程访问模式，不替代现有 CodexMobile 本地服务、局域网访问、Tailscale 访问、本地 HTTPS listener 或当前 iPhone PWA 行为。现有启动命令 `npm start`、`npm run start:env`、`npm run start:bg` 以及直接访问 `http://<mac-ip>:3321` 的语义保持不变。

## 2. 控制合同

- 主目标：连接到 Space 的手机浏览器实际控制 Mac 上的 Codex runtime，而不是 Space 容器中的运行时。
- 验收标准：
  - 手机可以从 Space 加载 PWA。
  - 手机通过 Space 配对后获得 Mac 有效的浏览器 device token。
  - 手机可以列出 Mac `~/.codex` 中的项目和会话。
  - 手机可以提交 chat turn，并接收来自 Mac 的实时状态事件。
  - Mac 客户端断开时，Space 报告离线，而不是接受伪成功任务。
- 护栏：
  - Codex 凭证、OpenAI key、Lark token、本地文件、完整本地路径或大型二进制 payload 不得持久化到 Space。
  - 禁止静默 fallback 到 Space 本地 Codex 执行。
  - 每个被转发请求都有 timeout 和显式错误响应。
- 恢复目标：网络恢复后，Mac 客户端重启应在 30 秒内恢复中转可用性。
- 回滚触发：鉴权失败、请求路由出现歧义，或浏览器可见状态在没有 Mac 客户端连接时显示在线。
- 边界：只新增中转传输、Mac connector 和中转状态面。Codex 执行和 `~/.codex` 访问仍保留在 Mac 侧。
- 兼容边界：除非 relay 模式显式选择传输适配器，否则不得改变现有本地模式 API 行为、浏览器 token 行为、本地静态文件服务、上传处理、语音能力、图片生成、Lark 集成或 Codex 执行语义。

## 3. 拓扑

```text
iPhone browser
  |
  | HTTPS and browser WebSocket
  v
HuggingFace Space 中转服务
  |
  | Mac-initiated WebSocket
  v
Mac connector
  |
  | 进程内模块调用或 localhost HTTP
  v
CodexMobile 本地运行时
  |
  v
~/.codex, project files, Codex SDK, local tools
```

Space 中转服务是控制面和公网入口。Mac connector 是数据面执行器。Mac 仍然拥有 Codex 会话、上传文件、生成文件、本地鉴权和工具执行状态。

## 4. 进程模型

### Space 中转服务

运行在 HuggingFace Docker Space 中。

职责：

- 提供构建后的 PWA。
- 鉴权手机设备。
- 每个 relay token 接受一个 active Mac connector。
- 将 `/api/*` 请求转发给已连接的 Mac connector。
- 将 Mac connector 发来的 `/ws` 事件转发给浏览器客户端。
- connector 离线时报告 `macConnected: false`。
- 只保留短生命周期的内存请求与连接状态。

非职责：

- 不读取 `~/.codex`。
- 不执行 Codex。
- 不存储上传文件、生成图片或本地工具凭证。
- Mac 离线时不提供 fallback 实现。

### Mac connector

作为 Node.js 进程运行在 Mac 上。

职责：

- 使用 relay 鉴权打开 `wss://<space>/relay/mac`。
- 与 Space 保持心跳。
- 接收 Space 发来的 request envelope。
- 调用本地 CodexMobile handler 或本地 HTTP 服务执行请求。
- 将 response envelope 回传给 Space。
- 订阅本地 CodexMobile 广播事件并向上游转发。
- Space 休眠或网络断开时使用指数退避重连。

非职责：

- 不直接提供公网 HTTP 服务。
- 不暴露 internet listener。
- 除非显式配置，否则不持久化 Space 侧浏览器 token。

兼容规则：

- connector 可以依赖现有本地 CodexMobile server。
- connector 不要求用户停止直接使用本地 server。
- connector 应可选且可独立启动。它不运行时，本地 LAN/Tailscale 访问仍然工作。

## 4.1 兼容模式

| 模式 | 命令形态 | 公共入口 | 执行 owner | 现有行为 |
| --- | --- | --- | --- | --- |
| 本地直连 | `npm start` | Mac LAN/Tailscale URL | Mac server | 不变 |
| 本地 HTTPS | 带证书配置的 `npm run start:env` | Mac HTTPS/Tailscale Serve URL | Mac server | 不变 |
| Relay Mac connector | `npm run relay:mac` 加本地 server | HuggingFace Space URL | Mac server via connector | 新增 |

第一版 relay 实现应采用 sidecar 方式：

```text
Mac 本地服务继续运行在 127.0.0.1:3321
Mac relay client 连接到 Space
手机可以选择 Mac 本地 URL 或 Space URL
```

这样可以避免侵入式重构，并保留当前用户工作流。

## 5. Mac Client 状态机

```text
starting
  -> connecting
  -> authenticating
  -> online
  -> reconnecting
  -> online

terminal states:
  auth_failed
  configuration_error
```

状态转换：

- 缺少或无效的必要环境变量时，`starting -> configuration_error`。
- 网络失败时，`connecting -> reconnecting`。
- relay secret 被拒绝时，`authenticating -> auth_failed`。
- 连续两个 heartbeat ack 缺失时，`online -> reconnecting`。
- 成功重连并收到 hello ack 后，`reconnecting -> online`。

connector 应记录每次状态转换的 timestamp、state、relay URL 和安全 reason，不得记录 secret 或 bearer token。

## 6. 环境变量

Mac connector：

```bash
CODEXMOBILE_RELAY_URL=wss://<space>.hf.space/relay/mac
CODEXMOBILE_RELAY_SECRET=<long random secret>
CODEXMOBILE_RELAY_DEVICE_NAME=<mac-name>
CODEXMOBILE_RELAY_LOCAL_URL=http://127.0.0.1:3321
CODEXMOBILE_RELAY_HEARTBEAT_MS=15000
CODEXMOBILE_RELAY_REQUEST_TIMEOUT_MS=120000
CODEXMOBILE_RELAY_IDLE_HEARTBEAT_MS=300000
```

Space relay：

```bash
CODEXMOBILE_MODE=relay
CODEXMOBILE_RELAY_SECRET=<same long random secret>
PORT=7860
```

relay secret 应放在 HuggingFace Space Secrets 和 Mac 本地 shell secrets 中，不要把真实值写入 `.env.example`。

## 7. WebSocket 协议

所有消息均为 JSON。每个 request-response exchange 使用一个 `requestId`。大型 body 不得作为单个 JSON base64 envelope 发送。共享 streaming 契约和 Phase 1 小体积限制定义在 `docs/relay-system-design.md`。

### Mac hello

```json
{
  "type": "mac.hello",
  "protocolVersion": 1,
  "connectorInstanceId": "uuid",
  "deviceName": "mison-mac",
  "startedAt": "2026-05-15T00:00:00.000Z",
  "clientVersion": "0.1.0",
  "localStatus": {
    "reachable": true,
    "checkedAt": "2026-05-15T00:00:00.000Z"
  },
  "capabilities": ["http", "events"]
}
```

鉴权应放在 WebSocket 请求头中：

```text
Authorization: Bearer <CODEXMOBILE_RELAY_SECRET>
```

### Relay ack

```json
{
  "type": "relay.hello",
  "protocolVersion": 1,
  "connectionId": "uuid",
  "macConnectionEpoch": 1,
  "serverTime": "2026-05-15T00:00:00.000Z",
  "accepted": true
}
```

### 小体积 HTTP 请求转发

```json
{
  "type": "http.request",
  "requestId": "uuid",
  "method": "GET",
  "path": "/api/projects",
  "headers": {
    "authorization": "Bearer browser-device-token"
  },
  "bodyEncoding": "json",
  "body": null,
  "timeoutMs": 120000
}
```

允许的小体积 body encoding：

- `json`
- `text`
- `base64`

`base64` 只用于 Phase 1 限制内的小体积 body。上传、语音音频、生成图片和其他大型 body 必须先实现分块流式帧，relay 才能宣称与本地直连模式能力对齐。

### HTTP 响应转发

```json
{
  "type": "http.response",
  "requestId": "uuid",
  "status": 200,
  "headers": {
    "content-type": "application/json; charset=utf-8"
  },
  "bodyEncoding": "json",
  "body": {
    "projects": []
  }
}
```

### 错误转发

```json
{
  "type": "http.error",
  "requestId": "uuid",
  "status": 502,
  "error": "Mac connector request timed out"
}
```

### 运行时事件

```json
{
  "type": "event",
  "eventId": "uuid",
  "payload": {
    "type": "status-update",
    "status": "running",
    "label": "正在思考"
  }
}
```

Space 将 `event.payload` 广播给浏览器 `/ws` 客户端。

### 心跳

```json
{ "type": "ping", "sentAt": 1760000000000 }
```

```json
{ "type": "pong", "sentAt": 1760000000000 }
```

## 8. 路由规则

relay 模式对浏览器 API 调用使用 default-forward。Space-owned exceptions：

- `GET /api/status`
- `POST /api/pair`，无需已有浏览器鉴权，直接转发到 Mac，以保持 Mac 的 device-token authority
- `/relay/*`

其他所有已认证 `/api/*` 请求都转发到 Mac。下表列出重点路径，但不是完整 allowlist：

| 路径 | Space 行为 |
| --- | --- |
| `GET /api/status` | 返回 Space 状态和 Mac 连接状态。 |
| `POST /api/pair` | 无需已有浏览器鉴权，转发到 Mac，让 Mac 返回 Mac 有效的 device token。 |
| `GET /api/projects` | 转发到 Mac connector。 |
| `POST /api/sync` | 转发到 Mac connector。 |
| `GET /api/projects/:id/sessions` | 转发到 Mac connector。 |
| `GET /api/sessions/:id/messages` | 转发到 Mac connector。 |
| `POST /api/chat/send` | 转发到 Mac connector。 |
| `POST /api/chat/abort` | 转发到 Mac connector。 |
| `POST /api/uploads` | 仅在 streaming 支持或显式 small-body gate 后转发到 Mac connector。 |
| `POST /api/voice/*` | 仅在 streaming 支持或显式 small-body gate 后转发到 Mac connector。 |
| `GET /generated/*` | 要求浏览器鉴权。使用 response streaming 转发到 Mac，Space 不持久化、不缓存。 |
| `GET /api/quotas/codex` | 转发到 Mac connector。 |
| `GET/POST /api/feishu/*` | 转发到 Mac connector，除非 callback 路由被明确标记为 unsupported。 |
| `PATCH/DELETE /api/projects/:id/sessions/:sessionId` | 转发到 Mac connector。 |
| `DELETE /api/sessions/:id/messages/:messageId` | 转发到 Mac connector。 |

没有 Mac connector 在线时，forwardable route 必须返回：

```json
{
  "error": "Mac connector is offline"
}
```

HTTP 状态码为 `503`。

这些路由规则只适用于从 Space relay 进入的请求。直接发往 Mac 本地服务的请求继续使用现有 `server/index.js` handler。

`/ws/realtime` 属于 Phase 2，除非已实现带 backpressure 的全双工 tunnel。Phase 1 必须显式失败并返回 `501 relay_realtime_unsupported`，不得挂起或静默降级。

## 9. 本地执行策略

第一版实现应使用 localhost HTTP 转发：

```text
Mac connector 接收请求
  -> fetch(CODEXMOBILE_RELAY_LOCAL_URL + path)
  -> return status, selected headers, and body to Space
```

这样可以保持第一版 patch 较小，并避免立即把 `server/index.js` 重构为可 import 的 route handler。后续在 `server/index.js` 拆分出复用模块后，可以再改为进程内 handler 调用。

兼容理由：

- Localhost forwarding 把当前本地 server 作为兼容契约。
- 现有本地路由仍然是事实源。
- relay-specific 代码在 transport 稳定前保持在现有 request handler 之外。
- 任何未来进程内重构都必须保留当前 HTTP API 契约，并先通过本地模式回归检查。

Mac connector 可以在本地 CodexMobile server 尚未健康时启动。它仍应连接 Space，让手机看到真实的 `localStatus: offline`，而不是泛化的 Mac disconnected 状态。

connector 使用以下请求检查本地健康：

```text
GET http://127.0.0.1:3321/api/status
```

如果本地 status 失败：

- 尽可能保持 Space WebSocket 连接。
- 向 Space 报告 `localStatus: offline`。
- 可转发业务请求返回或失败为 `503 mac_local_offline`。
- 使用 backoff 持续探测本地 server。
- 本地健康恢复后再恢复转发。

## 10. 重连与退避

使用带 jitter 的指数退避：

- 初始延迟：1 秒。
- 活跃使用时最大延迟：30 秒。
- 长空闲最大延迟：5 分钟。
- 稳定在线 60 秒后重置退避。
- 心跳间隔：15 秒。
- 心跳 miss 阈值：2。
- 空闲心跳间隔：60-300 秒。

connector 不应试图用持续人工流量阻止 HuggingFace 免费层休眠。有浏览器 socket 或请求时使用活跃心跳；relay 未被使用时进入长空闲退避。

## 11. 安全规则

- relay secret 用于 Mac connector 到 Space 的鉴权。
- 浏览器 device token 用于手机到 Space 的鉴权。
- 浏览器 token 仍必须转发到 Mac 本地服务，以保持现有授权行为一致。
- Space 不得记录 upload、chat、voice 或 auth route 的请求体。
- Mac connector 必须脱敏：
  - `authorization`
  - `x-codexmobile-token`
  - `cookie`
  - 任何 key 中包含 `token`、`secret` 或 `key` 的字段
- Space 必须拒绝未知 connector 协议版本。
- 默认每个 relay secret 只有一个 active Mac connector。
- 每个 connector 有 `connectorInstanceId`、`connectionId` 和 `macConnectionEpoch`。
- pending request 绑定创建它的 epoch。
- 来自同一 connector instance 的有效重连可以抢占旧 socket。
- 抢占会让旧 pending request 以 `502 mac_reconnected` 失败。
- 旧 epoch 的迟到响应必须忽略。

## 12. 可观测性

最小日志：

- connector 状态转换。
- relay Mac connect 和 disconnect 事件。
- 请求 route、method、status、duration 和 requestId。
- timeout count。
- 心跳 miss 计数。
- reconnect count。

最小状态字段：

```json
{
  "mode": "relay",
  "macConnected": true,
  "macDeviceName": "mison-mac",
  "macLastSeenAt": "2026-05-15T00:00:00.000Z",
  "pendingRelayRequests": 0
}
```

## 13. 实施计划

1. 新增共享 relay 协议 helper。
   - 文件：`server/relay-protocol.js`。
   - 包含 envelope 校验、requestId 生成、timeout helper 和安全 header 过滤。

2. 新增 Mac connector 脚本。
   - 文件：`scripts/relay-mac-client.mjs`。
   - 连接 `CODEXMOBILE_RELAY_URL`。
   - 使用 `CODEXMOBILE_RELAY_SECRET` 鉴权。
   - 将收到的 request envelope 转发到 `CODEXMOBILE_RELAY_LOCAL_URL`。
   - 将响应 stream 回 relay。

   兼容检查：

   - `npm start` 在没有任何 relay 环境变量时仍可工作。
   - `npm run smoke` 仍然检查本地 `/api/status`。

3. 新增 Space 中转服务模式。
   - 文件：`server/relay-server.js` 或 `server/index.js` 中的 guarded mode。
   - 提供 PWA。
   - 本地处理 browser auth。
   - 维护 Mac connector socket 和 pending request map。
   - 转发浏览器事件和 Mac connector 事件。

4. 新增 package scripts。
   - `npm run relay:mac`
   - `npm run start:relay`

   兼容检查：

   - 不改变 `npm start` 的含义。
   - 本地直连模式不要求 relay dependencies 或 secrets。

5. 新增 Docker Space 入口。
   - `Dockerfile`
   - 暴露 HuggingFace `PORT`，默认 `7860`。
   - server 启动前执行 build。

6. 新增 smoke checks。
   - 本地 Mac connector health。
   - relay 离线路由返回 `503`。
   - relay online 后 `/api/projects` 到达 Mac。
   - 浏览器 WebSocket 收到 Mac 转发的 `status-update` event。
   - `/generated/*` 未鉴权返回 `401`，已鉴权后通过 response streaming 返回 Mac 本地生成文件。
   - 现有本地直连 `/api/projects`、`/api/chat/send`、`/ws`、upload、voice、image 和 Lark route 行为保持不变。

## 13.1 回归边界

声明 relay support 完成前，必须分别验证两条路径：

本地直连路径：

```text
手机或浏览器 -> Mac CodexMobile server -> 本地 Codex runtime
```

Relay 路径：

```text
手机或浏览器 -> HuggingFace Space 中转服务 -> Mac connector -> Mac
CodexMobile server -> 本地 Codex runtime
```

relay 测试通过不代表本地直连模式仍正常；本地测试通过也不代表 relay 模式可用。它们是两个独立 gate。

## 14. 残余风险

- HuggingFace 免费 Space 会休眠，手机首次请求可能需要等待 cold start 和 Mac reconnect。
- 纯内存模式下 Space 验证缓存会在重启后丢失。现有浏览器 token 必须向 Mac 复验；如果 Mac 拒绝该 token，浏览器需要重新通过 Mac 配对。
- 大型上传和生成图片可能超过 relay 内存舒适范围。第一版应强制执行现有上传大小限制，并避免无界 buffering。
- realtime voice 经过双 WebSocket relay 可能增加延迟，应在基础 chat relay 可用后再测试。
