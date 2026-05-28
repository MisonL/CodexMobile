# CR-HF-SPACE-RELAY-MAC-CONNECTOR-SUMMARY-2026-05-28

## 范围

本摘要取代本分支早期的阶段性 `CR-*` 记录和一次性 `docs/superpowers/plans/*` 执行计划。保留的长期事实源为 `README.md`、`tasks.md`、`hf-space-relay-mac-connector.md`、`docs/relay-*.md` 和本文。

## 已完成能力

- HuggingFace Space relay 与 Mac connector 增量架构：移动端 PWA 通过 Space relay 访问本机 CodexMobile，本地 LAN、Tailscale、HTTPS 与 `npm start` 路径保持兼容。
- Relay 认证与状态：pairing 仍由 Mac 本地服务签发 device token；Space 只缓存验证结果并保留 `pairing_required`、`mac_offline`、`mac_local_offline` 等显式状态。
- Request/response streaming：`/api/uploads`、`/api/voice/transcribe`、`/api/voice/speech`、`/generated/*` 走 chunked relay，不在 Space 落盘缓存大文件。
- Realtime tunnel：浏览器 `/ws/realtime` 经 Space 和 Mac connector 转发到本地 `/ws/realtime`，HTTP fallback 明确返回 `relay_realtime_http_upgrade_required`。
- Connector hardening：包含 `connectorInstanceId`、`macConnectionEpoch`、stale response 拒绝、secret rotation grace window、keepalive、multi-Mac 歧义拒绝和 LaunchAgent 管理。
- CLI 与 runtime path：`codexmobile` CLI 支持 doctor/status/start/stop/logs/install/relay-config，服务端 writable state 统一从 `CODEXMOBILE_HOME` 派生。
- 分支收敛：当前功能线为 `codex/hf-space-relay-mac-connector`，后续任务记录在 `tasks.md` 的 `CM-RELAY-012` 到 `CM-RELAY-018`。

## 最近验证

本轮清理和代码收敛后执行：

| Command | Result |
| --- | --- |
| `node --test tests/relay-real-chat-smoke-utils.test.mjs` | Passed, 4 tests |
| `npm run test` | Passed, 206 tests |
| `npm run lint` | Passed |
| `npm run smoke:relay` | Passed, `Relay smoke ok` |
| `npm run build` | Passed |
| `git diff --check` | Passed |

历史真实部署验证已覆盖 HuggingFace Space public/authenticated flow、pairing、`/api/projects`、browser `/ws`、`/api/chat/send`、Space restart recovery、Mac connector stop recovery 和 Mac local service stop recovery。后续若需要重新证明线上状态，应按 `docs/relay-deployment-runbook.md` 重新生成一份当日验收记录。

## 保留门禁

- `CM-RELAY-012`：真实 realtime provider-ready，需要有效 provider key 和 live Mac connector。
- `CM-RELAY-013`：真实 iPhone PWA 安装、触控、键盘、横竖屏、网络切换和 Space 配对手工回归。
- `CM-RELAY-014` / `CM-RELAY-015`：正式 explicit multi-Mac routing 设计与实现；当前仍只安全拒绝歧义连接。
- `CM-RELAY-016`：生产观测、长期审计日志、requestId 追踪和脱敏扫描。
- `CM-RELAY-017`：公网多人安全加固，包括 proxy trust、origin allowlist、CSRF/Origin 检查、token rotation 和 abuse response。
- `CM-RELAY-018`：上述任务完成后的最终审计。

## 文档清理口径

已删除早期逐步推进产生的阶段性 CR 与详细执行计划，避免根目录和 `docs/reviews` 继续保留重复文档。真实运行手册、协议设计和当前任务计划仍保留。
