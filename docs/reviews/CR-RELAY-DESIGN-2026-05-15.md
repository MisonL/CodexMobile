# CR-RELAY-DESIGN-2026-05-15

## 范围

本次审查的 relay 设计文档：

- `docs/relay-mac-client-design.md`
- `docs/relay-hf-space-design.md`

外部审查方：

- Claude CLI，只读审查。
- Gemini CLI，只读审查。

被审查功能是在现有 CodexMobile 本地局域网、Tailscale、HTTPS 和 PWA 行为基础上，新增 HuggingFace Space 中转访问与 Mac connector。

## 已采纳问题

### P0：浏览器鉴权必须保持 Mac 有效

问题：

- 早期设计允许 Space 创建浏览器 device token。
- Mac 本地服务拥有 trusted device 状态，会拒绝这些 Space 生成的 token。

决策：

- 使用 Mac-auth-source mode。
- Space `POST /api/pair` 转发到 Mac。
- Mac 返回浏览器 device token。
- Space 只在内存中缓存验证结果，并可向 Mac 复验。

已更新：

- `docs/relay-system-design.md`
- `docs/relay-hf-space-design.md`
- `docs/relay-mac-client-design.md`

### P0：路由策略必须避免本地与 relay 漂移

问题：

- 固定 relay allowlist 漏掉了 quota、Feishu、session rename/delete、message delete、turn lookup 等现有路由。

决策：

- relay 对已认证 `/api/*` 使用 default-forward。
- Space-owned exceptions 是 `/api/status`、`/api/pair` 和 `/relay/*`。
- 不支持的路由必须显式返回 `501`，不得静默失败。

### P0：大型二进制 body 不能使用单个 base64 JSON envelope

问题：

- Uploads、voice audio、generated images 和 speech output 可能超过安全的单消息 JSON 大小。
- Base64 会放大内存占用，并可能阻塞 Node 事件循环。

决策：

- Phase 1 只支持有界小体积 body。
- 大型二进制 route 返回 `413 relay_body_too_large` 或 `501 relay_streaming_required`。
- 完整能力对齐需要带 backpressure 的分块 WebSocket 帧。

### P1：Mac 重连需要 epoch 和 stale-response rejection

问题：

- 残留 WebSocket 连接可能阻塞重连，或返回迟到响应。

决策：

- Mac hello 包含 `connectorInstanceId`。
- Space 分配 `connectionId` 和 `macConnectionEpoch`。
- Pending request 绑定 epoch。
- 来自同一 connector instance 的有效重连可以抢占旧 socket。
- 旧 epoch 的迟到响应必须忽略。

### P1：HuggingFace 免费层休眠必须作为正常状态处理

问题：

- 持续心跳可能对抗 Space sleep，并造成重连循环。

决策：

- 只有存在浏览器 socket 或请求时使用 active heartbeat。
- idle mode 退避到 60-300 秒。
- reconnect long-idle ceiling 是 5 分钟。
- 状态必须区分 Space waking、Mac reconnecting、Mac local offline、pairing required 和 ready。

### P1：Realtime voice 不属于 Phase 1 parity

问题：

- `/ws/realtime` 需要全双工 streaming 和 backpressure。

决策：

- Phase 1 返回明确的 `501 relay_realtime_unsupported`。
- Phase 2 覆盖 realtime voice 的 latency、disconnect 和 backpressure 检查。

## 新增验证门禁

本地直连回归：

- `npm start` 在没有 relay 变量时可工作。
- `npm run start:env` 本地 HTTPS 行为保持不变。
- 本地 `/api/status`、`/api/pair`、`/api/projects`、`/ws` 和 `/ws/realtime` 行为保持不变。

Relay Phase 1：

- Space `/api/status` 返回 `mode: relay`。
- 未认证 forwardable API 返回 `401 pairing_required`。
- Mac connector 离线返回 `503 mac_offline`。
- Mac connector 在线但本地 server 离线返回 `503 mac_local_offline`。
- 通过 relay 配对返回 Mac 有效 token。
- `/api/projects` 到达 Mac。
- `/api/chat/send` 返回 `202`。
- 浏览器 `/ws` 收到来自 Mac 的事件。
- 重连创建新 epoch，stale response 被忽略。
- `/generated/*` 未鉴权返回 `401`，已鉴权后在 Phase 1 返回 `501 relay_streaming_required`，不在 Space 落盘。
- 不支持的 realtime 与大型二进制 route 显式失败。

Relay Phase 2：

- Chunked upload、voice、speech 和 generated assets。
- `/generated/*` 使用流式 relay 转发到 Mac，并继续要求鉴权。
- 超限 body 返回 `413`。
- 断线释放 pending stream 状态。

## 残余风险

- HuggingFace Space 冷启动时间不受 CodexMobile 控制。
- 纯内存 Space mode 会在重启后丢失 validation cache。
- 完整 binary/media parity 推迟到 chunked streaming 实现后。
- Multi-Mac support 在明确 device routing 前保持 out of scope。
