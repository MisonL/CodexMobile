# HuggingFace Space Relay and Mac Connector Goal

## Goal

围绕本分支实际开发的主功能线继续收口：通过 HuggingFace Space relay 和 Mac connector，让移动端 PWA 访问本机 CodexMobile，并覆盖已落地的 request/response streaming、realtime tunnel、connector 常驻配置和安全边界。已完成的基础 relay、streaming、realtime tunnel、secret rotation 和 multi-Mac 歧义防护不重复纳入；这里只跟踪仍需开发、真实环境验证或产品决策的内容。

## Tasks

- [x] 分支边界重命名为 `codex/hf-space-relay-mac-connector`。验证：`git branch --show-current`。
- [x] 把剩余项拆成任务文件中的可执行条目。验证：`tasks.md` 只新增未完成或外部门禁任务。
- [ ] 执行 realtime provider-ready 门禁。验证：配置真实 provider key 后运行 `npm run space:verify -- --url https://misonl-codexmobile-relay.hf.space --check-realtime --require-realtime-ready --require-mac --json`；没有 key 时只能记录为外部阻塞，不得伪装通过。
- [ ] 执行 iPhone PWA 真机回归。验证：记录安装到主屏、触控、键盘弹起、横竖屏、浅色/深色、网络切换和 Space 配对结果。
- [ ] 设计 explicit multi-Mac routing。验证：形成 route id、浏览器选择 UI/API、token 绑定、连接抢占和歧义状态契约。
- [ ] 实现 explicit multi-Mac routing。验证：两台 Mac 同时在线时请求按显式 route 转发；未选择 route 时稳定失败，不随机转发。
- [ ] 补齐生产观测与长期审计。验证：失败率、connector offline、rate-limit、requestId 追踪和脱敏日志样本可复现检查。
- [ ] 补齐公网多人安全加固。验证：origin allowlist、proxy trust、CSRF/Origin 检查、token rotation/abuse response 有自动化或可复现实测记录。
- [ ] 最终收口审计。验证：`npm run build`、`npm run smoke`、`npm run smoke:relay`、`npm run test:space-verify`、`git diff --check` 通过或记录真实外部阻塞。

## Done When

- [ ] 所有非外部条件的代码任务已完成并验证。
- [ ] 外部 provider、真机和产品决策门禁有明确状态与复验命令。
- [ ] 分支、PR、CI、Space 和本地验证证据足以判断 HuggingFace Space relay + Mac connector 功能线是否可进入长期公网使用。
