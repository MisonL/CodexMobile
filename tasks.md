# CodexMobile Tasks

| ID | 标题 | 内容 | 验收标准 | 审查要求 | 状态 | 标签 |
| --- | --- | --- | --- | --- | --- | --- |
| CM-CLI-001 | CLI dry-run 安装骨架 | 新增 npm bin 入口、CLI 用户目录解析、macOS LaunchAgent plist dry-run 生成、`doctor`、`status`、`install --dry-run` 基础命令；不写入系统自启配置，不改变现有 `npm start` 行为。 | `npm run test:cli` 通过；`node bin/codexmobile.mjs install --dry-run --json` 输出计划且不创建 LaunchAgent；`doctor --json` 和 `status --json` 可在无外部 API key、无真机场景运行；`npm start` 入口保持为 `node server/index.js`。 | 检查无 secret/token 输出；检查 dry-run 无系统副作用；检查 package bin 与发布文件边界；检查路径解析覆盖 macOS、Windows、Linux。 | 已完成 | 高优先级 |
| CM-CLI-002 | CLI 服务启停与日志管理 | 将本地 Node 服务抽象为 CLI 可管理的 `serve`、`start`、`stop`、`restart`、`logs`；日志写入用户级状态目录，同时保持源码开发模式可用。 | 相关单元测试通过；本机启动后 `status` 可识别 PID、端口和日志路径；停止命令只停止 CLI 管理的进程。 | 检查不会误杀非 CodexMobile 进程；检查 Windows PATH 去重逻辑保留；检查日志不包含密钥。 | 已完成 | 高优先级 |
| CM-CLI-003 | macOS LaunchAgent 安装与卸载 | 在显式 `install` 下写入用户级 LaunchAgent，支持启用、禁用、状态检查和卸载；默认仍需用户显式执行。 | dry-run 和真实写入路径测试通过；plist 内容可由 `plutil -lint` 校验；`uninstall` 默认保留用户数据。 | 检查不会静默写系统配置；检查删除用户数据必须二次确认；检查 LaunchAgent label 和路径稳定。 | 未开始 | 高优先级 |
| CM-CLI-004 | Relay connector 常驻配置 | CLI 支持保存、读取和脱敏展示 relay URL、relay secret、本地 URL，并可管理现有 Mac connector 启动参数。 | 配置读写测试通过；`status` 脱敏展示 relay 配置；现有 `npm run relay:mac` 行为不回归。 | 检查 secret 不进入源码、日志和 git；检查弱 secret 显式失败；检查现有 relay smoke 通过。 | 未开始 | 高优先级 |
| CM-CLI-005 | 文档、验证记录与跨平台边界 | 更新 README、docs/reviews 记录和后续 Windows/Linux 自启边界，明确可自动验证与需真机手测的范围。 | `npm run build`、`npm run smoke`、`npm run smoke:relay` 通过或记录真实跳过原因；文档包含 npm CLI 使用路径。 | 检查文档与 `tasks.md`、代码事实一致；检查没有夸大手机端、Tailscale、Space 或真实 Codex 子进程覆盖范围。 | 未开始 | 待审查 |
