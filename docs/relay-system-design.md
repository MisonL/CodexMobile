# CodexMobile Relay 体系设计

## 1. 范围

本文是 HuggingFace Space 中转服务与 Mac 连接器功能的共享系统契约。

生产化补充方案见 `docs/relay-production-hardening-plan.md`。部署 runbook 见 `docs/relay-deployment-runbook.md`。前端状态 UX 契约见 `docs/relay-frontend-ux-contract.md`。本文定义长期系统契约；补充文档定义真实部署、限流、密钥轮换、观测、前端状态、streaming 与 realtime tunnel 的落地门禁。

Relay 功能是增量能力，只新增一条远程访问路径：

```text
手机浏览器 -> HuggingFace Space relay -> Mac connector -> Mac 本地服务
```

它不替代现有本地访问路径：

```text
手机浏览器 -> Mac 局域网地址 -> Mac 本地服务
手机浏览器 -> Tailscale 地址 -> Mac 本地服务
手机浏览器 -> Mac HTTPS 地址 -> Mac 本地服务
```

现有本地命令保持原语义：

- `npm start`
- `npm run start:env`
- `npm run start:bg`
- `npm run smoke`

本地直连模式不得依赖 relay 专用命令、环境变量或密钥。

## 2. 控制合同

- 主目标：手机通过 Space URL 可以操作 Mac 上的 CodexMobile 运行时，同时不破坏现有本地直连能力。
- 验收标准：
  - 本地直连模式继续通过现有 smoke 和浏览器检查。
  - Space 中转服务可以提供 PWA，并返回中转状态。
  - 浏览器通过 relay 配对后获得 Mac 有效的 device token。
  - 中转路径下 `/api/projects`、`/api/chat/send` 和 `/ws` 事件可以到达 Mac。
  - Mac connector 离线时明确返回 `503 mac_offline`。
  - Mac connector 在线但 Mac 本地 CodexMobile 服务离线时明确返回 `503 mac_local_offline`。
  - 未认证浏览器请求明确返回 `401 pairing_required`。
  - 大型或暂不支持的二进制路径必须显式失败，或使用分块流式传输；不得伪造成功。
- 护栏：
  - 禁止 fallback 到 Space 本地 Codex。
  - 不要求 Space 持久化存储。
  - 禁止记录密钥、请求体、完整本地路径、上传内容或生成图片字节。
  - 禁止把 Mac 暴露为公网入站服务。
- 恢复目标：
  - 在 Space 容器已经启动且网络可达后，健康的 Mac connector 应在正常网络条件下 30 秒内恢复连接。
  - Space 冷启动时间不计入这 30 秒，必须在 UI 或状态模型中单独体现。
- 回滚触发：
  - 中转路径在没有在线 Mac connector 和可达 Mac 本地服务时仍显示在线。
  - 浏览器认证与 Mac 本地认证可能静默分叉。
  - 二进制转发存在导致 Space 进程 OOM 的风险。

## 3. 权限与事实源边界

| 领域 | 权威事实源 |
| --- | --- |
| Codex 执行 | Mac 本地服务 |
| `~/.codex` 配置与会话 | Mac 本地服务 |
| 浏览器 device token 来源 | Mac 本地服务 |
| 公网 HTTPS/WSS 入口 | HuggingFace Space 中转服务 |
| connector 传输鉴权 | Space 与 Mac connector 共享的 relay secret |
| 实时事件持久性 | 中转服务不保证持久化；Mac API 是状态事实源 |

Mac 本地服务仍然是 CodexMobile 业务行为的事实源。Space 只作为传输适配器和公网入口。

## 4. 鉴权决策

默认 relay 鉴权模型是 **Mac-auth-source mode**。

### 4.1 浏览器配对

Space 上的 `POST /api/pair` 通过 connector 转发到 Mac。Mac 本地服务生成浏览器 device token。浏览器像本地直连模式一样，在当前访问地址的本地存储中保存这个 Mac 有效 token。

收益：

- Mac 继续作为 device token 权威来源。
- 中转转发可以复用现有本地鉴权契约。
- 本地直连与 relay 访问使用同一套 trusted-device 模型。

失败行为：

- Mac connector 离线时，Space `POST /api/pair` 返回 `503 mac_offline`。
- 配对码无效时，原样返回 Mac 的响应。
- 浏览器本地存储不可写时，前端必须让配对显式失败，不能假装成功。
- Space 重启并丢失内存 token cache 后，下一个浏览器请求可以先向 Mac 复验再转发。

### 4.2 Space 上的浏览器 token 校验

对可转发路由，Space 按以下流程校验浏览器 token：

1. 如果 token 命中 relay 内存中的 valid-token cache，则接受。
2. 否则，如果 Mac connector 在线，则向 Mac connector 发送校验请求。connector 使用该浏览器 token 调用本地服务做校验，例如 `GET /api/status`。
3. 校验成功后将结果短 TTL 缓存在内存中。
4. 如果无法校验，则根据 Mac connector 和 Mac 本地服务可达性返回 `401 pairing_required`、`503 mac_offline` 或 `503 mac_local_offline`。

Space 不得自行生成浏览器 token。relay、Mac connector 或 Mac 本地服务短暂离线时，前端不得自动清除已保存的浏览器 token；只有重新配对成功才覆盖旧 token。

### 4.3 Mac connector 鉴权

Mac connector 使用以下请求头连接 Space：

```text
Authorization: Bearer <CODEXMOBILE_RELAY_SECRET>
```

这个 secret 只用于 Mac connector 控制通道，不得作为浏览器 device token 接受。

## 5. 路由策略

Space 中转服务对已认证 API 请求使用 default-forward 策略。

规则：

- `GET /api/status` 由 Space 处理，并返回 relay 状态。
- `POST /api/pair` 不要求已有浏览器 token，直接转发到 Mac，因为它是配对入口。
- `/relay/*` 下的 relay 管理路径由 Space 处理。
- 其他所有 `/api/*` 路径都要求浏览器鉴权，并转发到 Mac。
- 不支持的 relay-only WebSocket 路径必须显式失败。

这样可以避免本地服务新增 API 后 relay 路径出现隐性漂移。

特殊路径：

- `/api/feishu/auth/callback` 发布前必须明确归类。第一版中转服务要么在文档化 public URL 配置后转发到 Mac，要么返回 `501 relay_unsupported` 并给出清晰 UI 提示。
- `/ws/realtime` 通过 `realtime.open`、`realtime.frame` 和 `realtime.close` 帧连接到 Mac 本地 `/ws/realtime`，由 Mac 本地服务继续作为实时语音业务事实源。
- relay 模式下 `/generated/*` 必须要求浏览器鉴权，并通过 response streaming 带 backpressure 地转发到 Mac。Space 不落盘、不缓存。

## 6. 二进制与流式传输契约

中转服务不得把大型请求体或响应体作为单个 JSON base64 消息发送。

### 6.1 二进制策略

Relay 对小体积 JSON/text 请求继续使用 buffered 转发。`/api/uploads` 和 `/api/voice/transcribe` 使用 chunked request streaming 转发到 Mac connector，`/generated/*` 与 `/api/voice/speech` 使用 chunked response streaming 返回浏览器，避免 Space 缓冲完整 multipart body 或大型二进制响应。

限制：

- JSON 请求体：2 MB。
- 小型二进制 base64 body：解码后 2 MB。
- `/api/uploads` request stream：50 MB。
- `/api/voice/transcribe` request stream：10 MB。
- 其他未接入 streaming 的大型响应路径必须明确返回 `413 relay_body_too_large` 或 `501 relay_streaming_required`。

这可以在验证基础中转链路时避免内存和事件循环风险。

### 6.2 流式协议要求

upload、voice、speech audio、generated images 和大型响应的完整兼容必须使用分块帧：

```json
{
  "type": "http.request.start",
  "requestId": "uuid",
  "method": "POST",
  "path": "/api/uploads",
  "headers": {},
  "totalBytes": 1048576
}
```

```json
{
  "type": "http.request.chunk",
  "requestId": "uuid",
  "sequence": 1,
  "encoding": "base64",
  "data": "...",
  "bytes": 262144
}
```

```json
{
  "type": "http.request.end",
  "requestId": "uuid",
  "chunks": 4,
  "totalBytes": 1048576
}
```

响应流使用等价帧：

- `http.response.start`
- `http.response.chunk`
- `http.response.end`
- `http.stream.error`
- `realtime.open`
- `realtime.frame`
- `realtime.close`
- `realtime.error`

流式规则：

- chunk 有上限，默认每块原始 payload 最大 256 KB。
- 每条 stream 的总字节数限制必须等于或严于本地模式。
- 当对端 WebSocket buffer 偏高时，必须暂停读取以实现 backpressure。
- 断线时双方释放 pending buffer，并让请求失败。
- 已关闭请求的迟到 chunk 必须忽略并安全记录。
- realtime 帧必须带 `requestId`、单调递增 `sequence`、`encoding`、`bytes` 和 `macConnectionEpoch`，任一方向序号或字节数不匹配时关闭隧道。

## 7. Mac connector 连接模型

每个 Mac connector 进程发送：

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

Space 分配：

- `connectionId`
- `macConnectionEpoch`

待处理请求必须绑定到 `macConnectionEpoch`。

连接替换：

- 携带有效 relay secret 且 `connectorInstanceId` 相同的新连接可以抢占旧 socket。
- 缺失或为空的 `connectorInstanceId` 必须关闭为 `invalid_connector_instance_id`。
- 携带有效 relay secret 但 `connectorInstanceId` 不同的新连接必须被拒绝为 `ambiguous_mac_route`，直到实现显式 multi-Mac route。
- 抢占时旧待处理请求以 `502 mac_reconnected` 失败。
- 旧 epoch 的迟到响应必须忽略。
- 抢占后向浏览器 socket 广播 `relay-status`。

这可以避免 ghost socket 阻塞 Mac 快速重连。

## 8. 心跳与 HuggingFace 休眠

Mac connector 默认使用低频 HTTP keepalive 访问 Space 同源 `/api/status?keepalive=1`，避免只有空闲 WebSocket 长连接时 Space 自动休眠。该机制必须显式可配置、可关闭、可观测，不得携带 relay secret 或浏览器 token。

心跳策略：

- 活跃模式：存在浏览器 socket 或进行中请求时，每 15 秒心跳一次。
- 空闲模式：退避到 60-300 秒心跳，具体可配置。
- Space keepalive：默认 240 秒，活动间隔下限 60 秒，`CODEXMOBILE_RELAY_KEEPALIVE_MS=0` 表示关闭。
- 重连退避：初始 1 秒，前几次最大 30 秒，长空闲上限 5 分钟。
- 稳定在线 60 秒后重置退避。

状态应区分：

- `space_waking`
- `mac_connector_reconnecting`
- `mac_local_offline`
- `pairing_required`
- `ready`

只有 Space relay 和 Mac 本地服务都可达时，UI 才能显示为 ready。

## 9. 事件语义

relay event 是 live best-effort 信号，不保证持久化。

规则：

- 浏览器 `/ws` 连接后先收到兼容本地模式的 `connected`，其中包含当前 relay status；后续 Mac 状态变化通过 `relay-status` 广播。
- 浏览器重连后应调用 `/api/sync` 或 `/api/chat/turns/:id` 从 Mac 恢复当前状态。
- `eventId` 仅用于 best-effort 去重；relay 不承诺 Space 休眠或浏览器重连后的 replay。
- 出现 event gap 后，以 Mac API 为状态事实源。

## 10. 请求头与日志安全

请求头转发 allowlist：

- `authorization`
- `content-type`
- `accept`
- `user-agent`
- `x-codexmobile-*`

响应头转发 allowlist：

- `content-type`
- `content-length`
- `cache-control`
- `x-codexmobile-*`

禁止转发或记录：

- `cookie`
- `set-cookie`
- `proxy-authorization`
- relay secret
- query token
- chat、upload、voice、auth、generated asset 的请求体
- 完整 Mac 本地路径
- Mac 用户名

日志默认使用不带 query 的 path，除非 query 明确进入 allowlist。

## 11. 状态契约

relay 模式下 `GET /api/status` 返回安全字段：

```json
{
  "mode": "relay",
  "authenticated": true,
  "requiresPairing": false,
  "macConnected": true,
  "macDeviceName": "mison-mac",
  "macConnectionEpoch": 3,
  "macLastSeenAt": "2026-05-15T00:00:10.000Z",
  "localStatus": {
    "reachable": true,
    "checkedAt": "2026-05-15T00:00:09.000Z"
  },
  "pendingRelayRequests": 0,
  "relayStartedAt": "2026-05-15T00:00:00.000Z"
}
```

稳定错误体：

```json
{ "error": "pairing_required" }
```

```json
{ "error": "mac_offline" }
```

```json
{ "error": "mac_local_offline" }
```

```json
{ "error": "relay_streaming_required" }
```

## 12. 阶段门禁

### Phase 0：设计门禁

- 鉴权桥接使用 Mac-auth-source mode。
- 路由策略是 default-forward，并明确 Space-owned exceptions。
- 二进制策略是 small-body-only 或 chunked streaming。
- 连接模型包含 epoch 和迟到响应拒绝。
- 本地直连模式不依赖 relay 启动条件。

### Gate 1：HTTP 与事件 relay

必须通过：

- `npm start` 在没有 relay 环境变量时可用。
- `npm run start:env` 保持本地 HTTPS 行为。
- Space `/api/status` 返回 `mode: relay`。
- 未认证 forwardable API 返回 `401 pairing_required`。
- Mac connector 离线返回 `503 mac_offline`。
- Mac 本地服务离线返回 `503 mac_local_offline`。
- 通过 Space 调用 `POST /api/pair` 返回 Mac 有效 token。
- 通过 Space 调用 `/api/projects` 返回 Mac 项目数据。
- 通过 Space 调用 `/api/chat/send` 返回 `202`。
- 浏览器 `/ws` 收到来自 Mac 的状态事件。
- Mac 重连创建新 epoch，旧响应被忽略。
- 未接入 streaming 的二进制路径显式失败。

### Gate 2：二进制与媒体能力对齐

必须通过：

- `/api/uploads` 支持 chunked relay 或显式有界失败。
- `/api/voice/transcribe` 支持有界 request streaming。
- `/api/voice/speech` 支持有界 response streaming。
- `/generated/*` 使用 chunked relay 转发到 Mac，要求鉴权，并且不在 Space 持久化。
- 超限 body 返回 `413`。
- 断线释放 pending stream 状态。
- `/ws/realtime` 支持带 backpressure 的全双工隧道。

### Gate 3：realtime provider 与多设备加固

必须通过：

- `/ws/realtime` 真实 provider 端到端延迟、断线和取消路径通过运行态复验。
- 浏览器重连后通过 Mac API 恢复状态。
- 多浏览器 event fanout 的作用域清晰且有文档。
- 如支持 multi-Mac，路由必须显式，禁止 ambiguous routing；在显式路由 UI/API 完成前，不同 connector 必须被拒绝。

## 13. 审查证据

本设计已纳入 Claude 与 Gemini 的外部审查意见，覆盖：

- Mac browser-token 与 Space browser-token 权威边界。
- default-forward 路由覆盖。
- 大型二进制 payload 使用 JSON base64 envelope 的 OOM 风险。
- `/generated/*` 鉴权与 no-cache 行为。
- Mac connector 残留连接与迟到响应竞态。
- HuggingFace 免费层休眠与冷启动 UX。
- realtime voice 的 relay 兼容边界。
- 本地直连回归门禁。
