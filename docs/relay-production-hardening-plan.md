# CodexMobile Relay 生产化完善方案

## 1. 目标与非目标

本文补充 `docs/relay-system-design.md` 的生产化决策，用于把 Phase 1 relay 从“可用 smoke”推进到“可控试运行”。

目标：

- 明确 Phase 1 真实部署验收标准。
- 补齐限流、防暴力、密钥轮换、观测和故障分级。
- 定义 Phase 2 streaming 的最小安全协议，避免重新引入无界 buffering。
- 保持 Mac 本地服务作为业务事实源。

非目标：

- 不把 HuggingFace Space 变成 Codex 执行环境。
- 不在 Phase 1 支持 upload、voice、speech、generated asset 或 realtime voice 全量等价。
- 不引入数据库、队列或多 Mac 路由，除非后续阶段明确需要。

## 2. 阶段门禁

### Phase 1A：离线可重复验证

进入条件：

- `npm run build` 通过。
- `npm run smoke` 验证本地直连。
- `npm run smoke:relay` 验证离线 relay 协议、鉴权、状态事件、重连和 unsupported route。
- Docker 镜像可以启动 relay server，并通过 `/api/status` 和 `/` 探针。

通过标准：

- 无 Mac connector 时，forwardable API 返回 `503 mac_offline`。
- Mac connector 在线但本地服务离线时，返回 `503 mac_local_offline`。
- 未认证浏览器请求返回 `401 pairing_required`。
- `/ws/realtime` HTTP fallback 明确返回 `501`，WebSocket 隧道走真实 connector；大型二进制 route 明确返回 `501` 或 `413`。
- connector 只允许转发到配置的本地 CodexMobile origin，拒绝协议相对 URL 和绝对外部 URL。

### Phase 1B：真实公网试运行

进入条件：

- Phase 1A 全部通过。
- HuggingFace Space secrets 已配置，且 relay secret 不在仓库、日志或截图中出现。
- Mac connector 使用本地环境变量或 shell secret 启动。

通过标准：

- 手机浏览器能从 Space URL 加载 PWA。
- 手机通过 Space 配对后拿到 Mac 有效 device token。
- 通过 Space 调用 `/api/projects` 返回 Mac 侧真实项目。
- 通过 Space 调用 `/api/chat/send` 返回 `202`，并在 `/ws` 收到 Mac 侧事件。
- 停止 Mac connector 后，Space 状态在 10 秒内变为 `macConnected: false`，新请求返回 `503 mac_offline`。
- 停止 Mac 本地服务但保持 connector 在线时，新请求返回 `503 mac_local_offline`。
- Space 容器重启后，connector 能重连；浏览器 token 可通过 Mac 复验恢复。
- 手动检查 Space 与 Mac 日志，不出现 bearer token、relay secret、配对码、请求体或本地完整路径。

### Phase 1C：受控日常使用

进入条件：

- Phase 1B 至少完成一次。
- 已记录试运行报告，包含命令、时间、Space URL、Mac connector 日志摘要和失败项。

通过标准：

- `/api/status` 暴露足够排障的安全状态与 counters。
- 有明确的 secret rotation 操作流程。
- 有最小限流策略，能限制 pairing 与 token validation 暴力尝试。
- 有失败分级和用户可见状态映射。

## 3. 安全加固

### 3.1 密钥与 token

Relay secret：

- 至少 32 字符随机值，建议 32 字节随机数的 base64url 编码。
- 只用于 `/relay/mac` connector 鉴权。
- 不得作为浏览器 token 接受。
- 不得写入 `.env.example`、README 示例真实值、日志或 smoke 之外的固定值。

浏览器 device token：

- 仍由 Mac 本地服务签发和校验。
- Space 只缓存 token hash，不缓存明文 token。
- cache TTL 默认不超过 5 分钟。
- Space 重启后必须向 Mac 复验，不得自行恢复授权。

密钥轮换：

- Space 使用 `CODEXMOBILE_RELAY_SECRET` 作为 current secret。
- 可选设置 `CODEXMOBILE_RELAY_PREVIOUS_SECRET` 作为 grace-window previous secret。
- current 与 previous 必须显式配置且不同，状态只暴露 previous 是否存在，不暴露任何 secret 值。
- 完成 Mac connector 迁移后必须清空 previous secret。

### 3.2 限流与防暴力

Phase 1 最小策略：

- `/api/pair` 按可信 client IP 做内存限流。
- token validation cache miss 按 token hash 前缀和可信 client IP 做内存限流；已缓存通过的 browser token 不消耗该限流 bucket。
- 该 token validation bucket 不是已鉴权请求的通用速率上限；如进入多用户或 hostile 网络环境，需要单独设计 per-token request cap。
- Mac connector 鉴权失败按 socket remote address 做短 TTL deny list。
- 限流命中返回 `429 relay_rate_limited`。

默认建议：

| 目标 | 窗口 | 上限 |
| --- | --- | --- |
| `/api/pair` | 60 秒 | 10 次 |
| token validation miss | 60 秒 | 60 次 |
| Mac secret 鉴权失败 | 5 分钟 | 5 次 |
| 单浏览器并发 relay 请求 | 即时 | 6 个 |
| 全局 pending relay 请求 | 即时 | 64 个 |

限流只保护 relay 传输层，不替代 Mac 本地认证。

可信 client IP 规则：

- 默认只使用 `req.socket.remoteAddress`。
- 只有在明确配置 `CODEXMOBILE_RELAY_TRUST_PROXY=1` 时，才读取 `x-forwarded-for` 的第一个公网 IP。
- 即使启用 trust proxy，也必须保留 `remoteAddress` 作为日志字段，用于排查代理伪造或平台差异。
- 不接受浏览器自定义 header 覆盖限流 key。

内存 bucket 清理：

- 每个 bucket 保存 `count`、`windowStartedAt` 和 `blockedUntil`。
- 过期 bucket 在每次访问和定时 sweep 时清理。
- sweep 间隔不超过窗口长度，默认 60 秒。
- bucket 总数超过上限时，优先删除最早过期或最久未访问的 bucket。

响应体：

```json
{ "error": "relay_rate_limited", "retryAfter": 30 }
```

`retryAfter` 单位为秒，前端应只禁用触发限流的操作。

### 3.3 Origin 与路径边界

Mac connector 必须只请求 `CODEXMOBILE_RELAY_LOCAL_URL` 对应 origin：

- relay envelope 的 `path` 必须以单个 `/` 开头。
- 拒绝 `//host/path`、`http://host/path`、`https://host/path` 和控制字符。
- connector 构造 URL 时只使用本地 base 的 origin，加上 relay path 的 pathname 与 search。
- 不转发 fragment。

Space 不应信任浏览器传来的 `host`、`x-forwarded-host` 或 query token 作为转发目标。

## 4. 可观测性与状态模型

### 4.1 状态字段

`GET /api/status` 应继续只返回安全字段。Phase 1C 建议增加：

```json
{
  "relayState": "ready",
  "limits": {
    "pendingRequestsMax": 64,
    "browserPendingRequestsMax": 6,
    "requestBodyMaxBytes": 2097152,
    "heartbeatMs": 15000,
    "idleHeartbeatMs": 300000
  },
  "metrics": {
    "relayRequestsTotal": 100,
    "relayRequestsFailed": 3,
    "relayRequestsTimedOut": 1,
    "rateLimitedTotal": 2,
    "authValidationMissTotal": 8
  }
}
```

`relayState` 枚举：

- `starting`
- `pairing_required`
- `mac_offline`
- `mac_local_offline`
- `ready`
- `degraded`

前端状态与能力开关契约见 `docs/relay-frontend-ux-contract.md`。

### 4.2 日志事件

所有日志使用单行结构化文本或 JSON。必须包含：

- `event`
- `requestId`，如适用
- `method`
- `path`，不含 query
- `status`
- `durationMs`
- `macConnectionEpoch`，如适用

禁止包含：

- authorization header
- cookie
- relay secret
- browser token
- pairing code
- chat、voice、upload、generated asset body
- Mac 用户名或完整本地路径

最小事件集：

- `relay.started`
- `relay.request.completed`
- `relay.request.failed`
- `relay.rate_limited`
- `browser.ws.connected`
- `browser.ws.disconnected`
- `mac.connected`
- `mac.disconnected`
- `mac.local_status_changed`
- `mac.heartbeat_missed`

## 5. Phase 2 Streaming 设计

### 5.1 适用路径

Phase 2 只在以下路径启用 streaming：

- `POST /api/uploads`
- `POST /api/voice/transcribe`
- `POST /api/voice/speech`
- `GET /generated/*`
- 后续明确需要的大响应 API

`/ws/realtime` 仍单独作为 Phase 3，不能用普通 HTTP chunk 协议伪装完成。

### 5.2 帧协议

请求：

```json
{ "type": "http.request.start", "requestId": "uuid", "method": "POST", "path": "/api/uploads", "headers": {}, "totalBytes": 1000000 }
```

```json
{ "type": "http.request.chunk", "requestId": "uuid", "sequence": 1, "encoding": "base64", "data": "...", "bytes": 262144 }
```

```json
{ "type": "http.request.end", "requestId": "uuid", "chunks": 4, "totalBytes": 1000000 }
```

响应：

```json
{ "type": "http.response.start", "requestId": "uuid", "status": 200, "headers": {} }
```

```json
{ "type": "http.response.chunk", "requestId": "uuid", "sequence": 1, "encoding": "base64", "data": "...", "bytes": 262144 }
```

```json
{ "type": "http.response.end", "requestId": "uuid", "chunks": 4, "totalBytes": 1000000 }
```

错误：

```json
{ "type": "http.stream.error", "requestId": "uuid", "status": 502, "error": "relay_stream_aborted" }
```

### 5.3 Backpressure 与限制

硬限制：

- 单 chunk 原始字节默认 256 KB。
- 单 request 总字节不超过本地同 route 限制。
- 每个 stream 必须有 idle timeout 和 total timeout。
- 每个方向都必须检查 WebSocket `bufferedAmount`。
- `bufferedAmount` 超过阈值时暂停读取；持续超限则中止 stream。

中止规则：

- 浏览器 HTTP 断开时，Space 发送 `http.stream.error` 给 Mac。
- Mac WebSocket 断开时，Space 关闭浏览器响应并释放 pending stream。
- Space 超时后释放全部 chunk buffer。
- 迟到 chunk 只记录 `late_chunk_ignored`，不得重建已关闭 stream。

禁止：

- 把完整文件读入内存后再 base64。
- 在 Space 落盘缓存 upload、voice 或 generated asset。
- 对 generated asset 取消鉴权。

## 6. 真实部署验收记录模板

具体部署步骤、回滚和排障见 `docs/relay-deployment-runbook.md`。每次 Phase 1B/1C 试运行记录到 `docs/reviews/`：

```markdown
# CR-RELAY-DEPLOY-YYYY-MM-DD

## 环境

- Space URL:
- Mac device:
- Commit:
- Relay secret rotation: yes/no

## 命令

- npm run build:
- npm run smoke:
- npm run smoke:relay:
- Docker probe:

## 真实链路

- PWA load:
- Pair via Space:
- /api/projects:
- /api/chat/send:
- /ws event:
- Mac connector stopped:
- Mac local server stopped:
- Space restarted:

## 日志抽查

- Space log sensitive data:
- Mac log sensitive data:

## 结论

- Pass/Fail:
- Follow-up:
```

## 7. ADR 摘要

| 决策 | 结论 | 理由 | 代价 |
| --- | --- | --- | --- |
| 事实源 | Mac 本地服务 | 保持 token、会话、Codex 执行一致 | Space 依赖 Mac 在线 |
| Phase 1 body | small-body-only | 快速验证 HTTP 与事件链路 | 上传、语音、图片暂不等价 |
| Space 存储 | 无持久化 | 适配 HF 免费层与安全边界 | 重启后需 Mac 复验 token |
| connector 转发 | localhost HTTP | patch 小，复用现有 handler | 需要双进程运行 |
| token cache | hash key + 短 TTL | 降低内存泄露影响 | 每次重启需复验 |
| streaming | Phase 2 chunk 协议 | 避免 base64 大包 OOM | 实现复杂度后移 |
