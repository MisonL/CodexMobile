# CR-RELAY-PHASE1-2026-05-18

## 范围

本次收口覆盖 CodexMobile Relay Phase 1 的前端 UX、Mac connector 退避、真实 smoke、真实浏览器验证和部署 runbook 记录。

## 变更摘要

- 前端新增 relay 429 `retryAfter` 锁定逻辑，发送、上传、语音相关操作会显示剩余秒数并禁用对应按钮。
- Mac connector 增加可测试的重连退避函数，active 上限 30 秒，idle 上限 5 分钟，稳定在线 60 秒后可重置退避。
- relay runtime 在心跳 ping 中携带 active 标记，用于区分活跃与空闲状态。
- smoke 增加 `retryAfter` 和 connector 退避的纯函数断言。

## 验证

- `npm run smoke:relay`
- `npm run build`
- `node --check scripts/relay-mac-client.mjs`
- `node --check server/relay-runtime.js`
- `node --check client/src/api.js`
- 真实浏览器验证：
  - 本地 relay 页面在 `mac_offline` 状态下显示 `Mac 未连接`，composer 相关操作被禁用。
  - 真实 relay 页面在 `/api/chat/send` 返回 `429 relay_rate_limited` 且 `retryAfter=20` 时，发送按钮显示 `请求过快，请 14 秒后再试` 并禁用。

## 结论

- Phase 1 relay 的本地可验证闭环已推进到可用试运行状态。
- 仍缺 HuggingFace Space 真实外网试运行和 deployment log 归档，需在 Space 可用时补最后一步。
