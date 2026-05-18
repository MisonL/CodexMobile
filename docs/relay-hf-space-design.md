# HuggingFace Space 中转服务设计

共享中转契约定义在 `docs/relay-system-design.md`。如本文与体系设计冲突，以体系设计为准。

真实部署、限流、密钥轮换、观测和 Phase 2 streaming 门禁见 `docs/relay-production-hardening-plan.md`。部署步骤见 `docs/relay-deployment-runbook.md`，前端状态 UX 见 `docs/relay-frontend-ux-contract.md`。

## 1. 目标

HuggingFace Space 中转服务是 CodexMobile 远程访问的公网 HTTPS 与 WebSocket 入口。它向手机提供 PWA，鉴权浏览器设备，接受 Mac connector WebSocket，并把浏览器请求转发到 Mac。

中转服务有意保持无状态。它不运行 Codex，不读取 `~/.codex`，不存储用户项目数据。

relay 模式是增量部署目标，必须兼容现有 CodexMobile 本地直连模式。当前 Mac 托管服务、局域网访问、Tailscale 访问、HTTPS 证书路径、PWA 行为、本地鉴权、语音、图片、上传、Lark、额度查询和 Codex 执行都继续有效，不得被 HuggingFace relay 替代。

## 2. HuggingFace 运行假设

本文面向 HuggingFace Spaces 的 Docker 模式免费 CPU 层。

运行假设：

- 应用监听 Space 端口，默认 `7860`。
- Docker Space 端口可通过 Space README YAML 中的 `app_port` 声明。
- 环境变量和 secrets 在 Space Settings 中配置。
- 默认运行磁盘视为 ephemeral。relay 状态必须能在磁盘丢失后通过 Mac 重连和浏览器 token 复验恢复。
- Space 可能休眠或重启。Mac connector 和手机浏览器必须容忍重连。
- relay 不得试图用人工心跳流量让免费 Space 永久保持唤醒。

relay 正确性不得依赖持久化存储。

## 3. 控制合同

- 主目标：Space 提供一个手机可访问的稳定入口，同时所有 Codex 执行仍在 Mac 上完成。
- 验收标准：
  - `GET /` 返回 PWA。
  - `GET /api/status` 返回 relay 模式和 Mac 连接状态。
  - 浏览器通过 Space 配对时实际到达 Mac，并返回 Mac 有效 token。
  - Mac 连接后，浏览器 API 调用能到达 Mac 并返回真实 Mac 结果。
  - Mac connector 离线时，可转发 API 返回 HTTP `503 mac_offline`。
  - Mac connector 在线但本地 CodexMobile server 离线时，可转发 API 返回 HTTP `503 mac_local_offline`。
- 护栏：
  - 禁止 fallback 到 Space 本地 Codex。
  - chat、upload、voice、auth 或 relay 协议路径不得记录 secret 或 request body。
  - 不要求持久化存储。
  - 未认证浏览器不得访问 forwardable API。
- 采样计划：
  - 记录每次 Mac connect 和 disconnect。
  - 在内存中记录请求数量、超时数量、待处理请求数量和最近 Mac 心跳时间。
  - 通过 `/api/status` 暴露安全状态。
- 恢复目标：
  - Space 重启后，Mac connector 重连且现有 browser token 通过 Mac 复验后，relay 恢复可用。如果 Mac 拒绝 token，浏览器必须通过 Mac 重新配对。
  - Mac 重连后，过期 pending request 失败，新请求开始接受。
- 回滚触发：
  - browser token 与 Mac connector secret 无法区分。
  - 没有 Mac connector 时 relay 仍报告在线。
- 边界：
  - Space 中转服务只处理公网传输、浏览器鉴权、connector 鉴权、请求转发和事件分发。
- 兼容边界：
  - `npm start`、`npm run start:env`、`npm run start:bg` 和本地 Mac 访问保持现有行为。
  - `npm run start:relay` 是新的 Space-only entrypoint。
  - relay 代码不得让本地模式依赖 HuggingFace 专用环境变量或 relay secrets。

## 4. 拓扑

```text
Phone browser
  |
  | HTTPS / WSS
  v
HuggingFace Space 中转服务
  |  - PWA static files
  |  - Browser auth
  |  - Mac connector auth
  |  - Pending request map
  |  - 浏览器事件分发
  |
  | WSS, Mac initiated
  v
Mac connector
  |
  v
Mac 上的本地 CodexMobile 服务
```

relay 是控制面网关。Mac 是状态 owner 和数据面执行器。

原有拓扑继续支持：

```text
Phone browser
  |
  | LAN, Tailscale, or Mac HTTPS
  v
Mac CodexMobile server
  |
  v
~/.codex, project files, Codex SDK, local tools
```

relay 拓扑是新增路径，不是替代路径。

## 4.1 模式矩阵

| 模式 | Server entrypoint | Browser URL | 需要 HuggingFace Space | 需要 Mac connector |
| --- | --- | --- | --- | --- |
| 本地直连 | `npm start` | `http://<mac-ip>:3321` | 否 | 否 |
| 本地 HTTPS | `npm run start:env` | Mac HTTPS 或 Tailscale Serve URL | 否 | 否 |
| Space relay | Space 中的 `npm run start:relay` | `https://<space>.hf.space` | 是 | 是 |

兼容规则：

- relay 入口可以复用前端构建产物和共享 helper。
- 不得改变默认本地服务入口。
- 不得让本地模式依赖 HuggingFace 专用环境变量或 relay secrets。

## 5. 公共接口

### 浏览器 HTTP

| Method | Path | 行为 |
| --- | --- | --- |
| `GET` | `/` | 提供 PWA。 |
| `GET` | `/assets/*` | 提供静态资源。 |
| `GET` | `/api/status` | 返回 relay 和 Mac 连接状态。 |
| `POST` | `/api/pair` | 转发到 Mac，让 Mac 继续作为浏览器 token 权威来源。 |
| Any | `/api/*` | 要求浏览器 token，然后在 Mac 连接后转发到 Mac。 |
| `GET` | `/generated/*` | 要求浏览器 token。使用 response streaming 转发到 Mac，不缓存。 |

这些行为只适用于 Space 中转服务。直接发往 Mac 的请求继续使用现有本地服务行为。`/api/*` 规则是 default-forward：新增本地 API route 默认转发，除非明确标记为 Space-owned 或 relay-unsupported。

### 浏览器 WebSocket

| Path | 行为 |
| --- | --- |
| `/ws?token=...` | CodexMobile 状态更新的浏览器事件流。 |
| `/ws/realtime?token=...` | 实时语音 WebSocket 隧道，转发到 Mac 本地 `/ws/realtime`。 |

### Mac WebSocket

| Path | 行为 |
| --- | --- |
| `/relay/mac` | 已鉴权的 Mac connector 控制通道。 |

`/ws/realtime` 必须通过带 backpressure 的全双工 tunnel 转发，不得在 Space 复制实时语音 provider 业务逻辑。

## 6. 鉴权模型

relay 有两个独立鉴权域。

### 浏览器鉴权

浏览器鉴权使用 Mac-auth-source mode：

- `POST /api/pair` 通过 connector 转发到 Mac。
- Mac 本地服务校验配对码并返回 device token。
- 浏览器把 device token 存储在 local storage。
- 浏览器传递 `Authorization: Bearer <device-token>`。
- Space 将已校验 token hash 短 TTL 缓存在内存中。

由于免费 Space 磁盘是 ephemeral，浏览器 validation cache 只保存在内存中。Space 重启后，relay 可以在 Mac connector 在线时向 Mac 复验浏览器 token。如果无法复验，relay 返回稳定错误，而不是自行生成 token。

### Mac connector 鉴权

Mac connector 使用独立 relay secret：

```text
Authorization: Bearer <CODEXMOBILE_RELAY_SECRET>
```

规则：

- 浏览器 device token 不得鉴权为 Mac connector。
- Mac relay secret 不得鉴权为浏览器 device token。
- Relay secret 存储在 HuggingFace Secrets 和 Mac 本地环境中。
- 启动时拒绝缺失、空值或过短 relay secret。

建议 relay secret 至少为 32 字节随机值的 base64url 编码。

relay secret 永远不能作为浏览器 token 接受。浏览器 token 永远不能作为 Mac connector 凭证接受。

## 7. 请求转发

Space relay 维护：

```text
macSocket: WebSocket | null
browserSockets: Set<WebSocket>
pendingRequests: Map<requestId, PendingRequest>
macInfo: { deviceName, connectedAt, lastSeenAt, protocolVersion }
metrics: in-memory counters
```

转发流程：

```text
浏览器 HTTP 请求
  -> 本地校验浏览器 token，或向 Mac connector 请求校验
  -> if no macSocket, return 503
  -> 按大小限制读取 body
  -> create requestId
  -> 保存带 timeout 的 pending resolver
  -> send http.request to macSocket
  -> wait for http.response or http.error
  -> 写回浏览器响应
```

relay 是传输适配器，不应复制 `server/index.js` 中的本地业务逻辑。Phase 1 中，转发请求应由 Mac connector 调用现有本地 CodexMobile HTTP 服务执行，以保持本地服务作为兼容事实源。

Timeout 行为：

- 默认请求 timeout：`120000` ms。
- chat send 可以快速返回 `202`，长时间 Codex 执行继续通过 event WebSocket 回传。
- voice 和 image route 可以有按路由配置的 timeout override，但仍必须有边界。
- 大型二进制路径必须使用 chunked streaming 或显式有界失败。

pending request 清理：

- Mac disconnect 时，所有 pending request 以 `502` 失败。
- timeout 时向浏览器返回 `502`，并忽略同 `requestId` 的迟到响应。
- 无效 response envelope 会关闭 Mac socket，并让 pending request 失败。
- Mac 重连时分配新的 `macConnectionEpoch`；旧 epoch 的迟到响应必须忽略。
- 缺失或为空的 `connectorInstanceId` 必须关闭为 `4002 invalid_connector_instance_id`。
- 不同 `connectorInstanceId` 的并发 Mac 连接必须关闭为 `4009 ambiguous_mac_route`，直到实现显式 multi-Mac route。

大型 request/response body 不得作为单个 base64 JSON message 缓冲。Phase 1 只支持小型有界 body。完整 upload、voice、speech、generated-image 能力需要 `docs/relay-system-design.md` 中定义的分块流协议。

## 8. 事件 fanout

Mac connector 将本地 CodexMobile 运行时事件转发给 relay：

```json
{
  "type": "event",
  "eventId": "uuid",
  "payload": {
    "type": "status-update",
    "status": "running"
  }
}
```

relay 将 `payload` 广播给已鉴权浏览器 `/ws` socket。

浏览器 socket 规则：

- WebSocket upgrade 时校验浏览器 token。
- 发送包含 relay status 的初始 `connected` event。
- 未鉴权 socket 用 HTTP `401` 关闭。
- close 或 error 时从集合中移除 socket。

如果浏览器 token 已在 relay 内存 cache 中命中，即使 Mac 后续离线，浏览器 `/ws` 仍可连接，并先收到兼容本地模式的 `connected` 包；其中的 relay status 会标记 `macConnected: false`。如果 token 不能在本地 cache 命中且 Mac 无法复验，`/ws` upgrade 会返回明确的认证或服务不可用错误。

首包示例：

```json
{
  "type": "connected",
  "status": {
    "mode": "relay",
    "macConnected": false
  }
}
```

## 9. 状态 API

`GET /api/status` 返回安全 relay 状态。

示例：

```json
{
  "mode": "relay",
  "authenticated": true,
  "requiresPairing": false,
  "trustedDevices": 1,
  "macConnected": true,
  "macDeviceName": "mison-mac",
  "macConnectionEpoch": 3,
  "macConnectedAt": "2026-05-15T00:00:00.000Z",
  "macLastSeenAt": "2026-05-15T00:00:10.000Z",
  "localStatus": {
    "reachable": true,
    "checkedAt": "2026-05-15T00:00:09.000Z"
  },
  "pendingRelayRequests": 0,
  "relayStartedAt": "2026-05-15T00:00:00.000Z"
}
```

永远不要包含：

- relay secret
- 浏览器 device token
- 上游 authorization header
- 原始 request body
- local Mac path，除非当前 Mac API 已明确有意暴露

## 10. 失败模式

| 失败 | Relay 响应 |
| --- | --- |
| Mac connector 未连接 | 可转发 HTTP route 返回 `503 mac_offline`。 |
| Mac 已连接但本地 server 离线 | 可转发 HTTP route 返回 `503 mac_local_offline`。 |
| Mac hello 缺失 connector ID | 新 WebSocket 关闭为 `4002 invalid_connector_instance_id`。 |
| 不同 Mac connector 并发连接 | 新 WebSocket 关闭为 `4009 ambiguous_mac_route`。 |
| Mac 在请求期间断开 | Pending request 返回 `502`。 |
| Mac 响应 timeout | 请求返回 `502`。 |
| Mac auth 无效 | WebSocket 以 `401` 拒绝。 |
| 重复 Mac connector | 同一 connector instance 可以抢占旧 socket；请求绑定 epoch。 |
| Space 重启 | Mac 重连；浏览器 token 验证缓存通过向 Mac 复验重建。 |
| invalid envelope | 关闭 Mac socket，让 pending request 失败，并安全记录错误。 |

forwardable route 不得在未经过 Mac 执行时返回成功。

## 11. 配置

Space variables：

```bash
CODEXMOBILE_MODE=relay
PORT=7860
HOST=0.0.0.0
CODEXMOBILE_RELAY_REQUEST_TIMEOUT_MS=120000
CODEXMOBILE_RELAY_HEARTBEAT_MS=15000
CODEXMOBILE_RELAY_IDLE_HEARTBEAT_MS=300000
CODEXMOBILE_RELAY_PENDING_REQUESTS_MAX=64
CODEXMOBILE_RELAY_BROWSER_PENDING_REQUESTS_MAX=6
```

Space secrets：

```bash
CODEXMOBILE_RELAY_SECRET=<base64url-random-secret>
```

本地直连模式不得要求这些 Space variables 或 secrets。缺少 relay 配置只能让 `start:relay` 或 `relay:mac` 失败，不能影响普通本地启动。

Space README YAML：

```yaml
---
title: CodexMobile Relay
sdk: docker
app_port: 7860
---
```

Dockerfile 形态：

```dockerfile
FROM node:20-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build
ENV HOST=0.0.0.0
ENV PORT=7860
EXPOSE 7860
CMD ["npm", "run", "start:relay"]
```

## 12. 安全控制

启动校验：

- `CODEXMOBILE_MODE` 必须等于 `relay`。
- `CODEXMOBILE_RELAY_SECRET` 必须存在且足够强。
- 配对码校验属于 Mac 本地服务。relay 启动不得要求 `CODEXMOBILE_PAIRING_CODE`。

Header handling：

- 将浏览器 `authorization` 转发给 Mac 本地服务。
- 永远不要把 Mac connector `authorization` 转发到浏览器 route。
- 剥离 hop-by-hop headers：
  - `connection`
  - `upgrade`
  - `transfer-encoding`
  - `keep-alive`
  - `proxy-authenticate`
  - `proxy-authorization`
  - `te`
  - `trailer`

日志：

- 记录 method、path、status、duration、requestId。
- chat、upload、voice、pair、auth 或 relay path 不记录 body。
- 包含 `authorization`、`cookie`、`token`、`secret` 或 `key` 的 header 必须脱敏。

Body limits：

- 尽可能沿用现有 CodexMobile 限制：
  - JSON：2 MB。
  - Upload：50 MB。
  - Voice：10 MB。
- relay 请求超限返回 `413`。
- 未实现 streaming 的大型二进制 route 返回 `413 relay_body_too_large` 或 `501 relay_streaming_required`，不得缓冲为单个 base64 JSON payload。

## 13. 可观测性

最小内存 counter：

- `relayRequestsTotal`
- `relayRequestsFailed`
- `relayRequestsTimedOut`
- `macConnectsTotal`
- `macDisconnectsTotal`
- `macHeartbeatMissesTotal`
- `browserSocketsCurrent`
- `pendingRequestsCurrent`

最小结构化日志事件：

- `relay.started`
- `browser.paired`
- `browser.ws.connected`
- `mac.connected`
- `mac.disconnected`
- `relay.request.completed`
- `relay.request.failed`
- `relay.request.timeout`

第一版不要求外部 metrics 服务。

## 14. 实施计划

1. 拆分静态资源服务与 auth helper，使 relay mode 可以复用。
   - 保持现有 local mode 行为。

2. 新增 relay 协议 helper。
   - 文件：`server/relay-protocol.js`。
   - 校验 message type、requestId、status、body encoding 和 safe headers。

3. 新增 relay server 模块。
   - 文件：`server/relay-server.js`。
   - 负责浏览器鉴权、Mac 鉴权、pending request map、浏览器 WebSocket 事件分发和 status API。

4. 新增 `start:relay` script。
   - 只运行 relay server。
   - 必要 secrets 无效时 fast fail。
   - 不改变 `npm start`。

5. 新增 Docker Space 文件。
   - `Dockerfile`。
   - 可选 Space README 部署片段。

6. 新增离线 relay 测试。
   - `/api/status` 返回 `mode: relay`。
   - 没有 Mac 时 forwardable route 返回 `503`。
   - connector 在线但本地 server 离线时 forwardable route 返回 `503 mac_local_offline`。
   - 无效 Mac secret 被拒绝。
   - oversized body 返回 `413`。
   - 本地 `npm start` 不要求 relay 环境变量。
   - 未认证访问 generated asset 返回 `401`。
   - realtime relay 通过真实 connector 转发到 Mac 本地 `/ws/realtime`。

7. 新增本地双进程 integration smoke。
   - 启动本地 CodexMobile server。
   - 启动 relay server。
   - 启动 Mac connector。
   - 通过 relay 请求 `/api/projects` 并验证结果来自 Mac。
   - 通过 relay 配对并验证返回 token 对 Mac 有效。
   - 重连 Mac connector，并验证旧 epoch 的迟到响应被忽略。

8. 新增本地直连 regression smoke。
   - 启动现有本地 server。
   - 验证 `GET /api/status`。
   - 验证本地浏览器 WebSocket upgrade 仍正常。
   - 验证现有 direct route 语义不变。

## 15. 复杂性转移账本

| 字段 | 决策 |
| --- | --- |
| 原复杂性位置 | 手机必须通过 LAN 或 Tailscale 直接访问 Mac。 |
| 新位置 | 公网传输与重连逻辑转移到 HuggingFace Space 中转服务。 |
| 收益 | 手机获得稳定 HTTPS 入口，且无需暴露 Mac 入站端口。 |
| 新成本 | relay 鉴权、pending request 跟踪、heartbeat、reconnect、cold-start 处理。 |
| 失效模式 | Space 错误显示在线、Mac 请求中途断开、内存状态重置。 |

## 16. 阶段边界

Phase 1：

- 浏览器 HTTP 转发。
- 浏览器 `/ws` 事件分发。
- Mac connector 单 active 连接。
- 内存鉴权与指标。
- 现有本地直连模式保持不变。

Phase 2：

- `/ws/realtime` voice relay。
- 大型 generated asset 使用流式传输，避免 buffering。
- 如启用付费持久化存储，可选持久化验证缓存。

Phase 3：

- Multi-Mac support。
- Device management UI。
- relay 侧审计视图。
