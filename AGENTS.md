# AGENTS.md - CodexMobile 仓库执行约束

本文件为 AI 辅助开发定义本仓库的核心约束与防踩坑指南。所有结论必须基于代码事实、测试结果、版本控制记录或运行日志。

## 1. 核心原则

- 沟通语言：全程使用中文，直接收束当次诉求，不附加无关建议。
- 事实优先：不要凭印象判断项目状态。先查 `README.md`、`package.json`、`docs/`、代码和 `git status`。
- Debug-First：禁止为“先跑通”添加隐藏回退、静默容错或假成功路径。失败必须显式暴露为错误、异常、日志或失败测试。
- 阶段目标：先保证行为等价和输入输出正确，再考虑性能优化和基准测试。
- 工作区保护：本仓库可能存在用户未提交改动。不得回退、覆盖或格式化无关文件。

## 2. 项目事实

- 项目类型：面向 iPhone 的 Codex PWA 客户端，本机 Node.js 桥接服务 + React/Vite 前端。
- 服务入口：`server/index.js`。
- 前端目录：`client/`，Vite 配置在 `client/vite.config.js`。
- Relay 入口：`server/relay-server.js`、`scripts/relay-mac-client.mjs`。
- 本地 ASR 服务：`asr-service/app.py`，启动脚本为 `scripts/start-asr.mjs`。
- 本地状态目录：`.codexmobile/`，不得提交。
- 主要文档：`README.md` 和 `docs/relay-*.md`。
- 项目内技能：`skills/*/SKILL.md`，涉及飞书文档、云空间、表格或幻灯片操作时必须先读对应技能。

## 3. 任务工作流

### 3.1 任务来源与锁定

- 默认唯一任务跟踪文件为 `tasks.md`。若该文件不存在，以用户当前明确指令作为本轮任务来源；不得自行虚构任务状态。
- 若用户要求建立长期任务循环，先创建或确认 `tasks.md`，再按任务文件执行。
- 每次只处理一个原子任务。循环流程：读取 -> 锁定 -> 开发 -> 验证 -> 自审 -> 标记完成 -> 提交。
- 筛选规则：优先处理状态为“未开始”且标签为“高优先级”的任务；若为空，按文件顺序处理第一个“未开始”任务。
- 禁止并行开发多个任务；可以并行读取文件或并行执行互不影响的只读检查。

### 3.2 建议任务文件结构

建议 `tasks.md` 使用表格记录：

```markdown
| ID | 标题 | 内容 | 验收标准 | 审查要求 | 状态 | 标签 |
| --- | --- | --- | --- | --- | --- | --- |
```

状态仅使用：`未开始`、`进行中`、`已完成`。

每行必须包含可执行边界：

- 内容：明确修改位置和修改理由。
- 验收标准：可验证、可复现、客观可判定。
- 审查要求：明确需要检查的动作，例如“验证 relay 错误码”或“确认前端禁用态”。

### 3.3 自审与回退

每个原子任务结束前必须完成：

- 对照验收标准逐条确认。
- 对照审查要求逐项检查。
- 运行最小相关验证命令。
- 使用 `git diff --name-only` 确认没有任务范围外的残余改动。
- 若验证失败，先定位根因，不得把失败改写为静默通过。

### 3.4 Code Review 模式

当任务标题包含 `[Code Review]` 时，切换为严格审计模式：

- 基于 `git diff` 或目标文件读取变更。
- 对照本文件、`README.md`、相关 `docs/` 契约和可用检查清单审查。
- 执行可用的类型检查、构建和 smoke test。
- 输出审计报告到 `docs/reviews/CR-{ID}.md`。
- 若发现严重问题，在任务跟踪文件中追加修复任务，状态置为“未开始”。
- 审计任务默认不修改业务代码，只输出报告和后续任务。

## 4. 工程质量红线

- 禁止为迎合测试硬编码假设。
- 只修改当前原子任务所需文件，不顺手修复无关问题。
- 显式处理边界条件，不隐藏失败。
- 外部输入必须在边界处校验，包括 HTTP 请求、WebSocket 消息、上传文件、环境变量和 CLI 输出。
- 业务逻辑优先依赖注入或显式参数，不在核心流程中硬编码具体环境。
- 优先返回新值表达状态变化，避免修改函数入参与隐式全局状态。
- 非兼容性要求场景下，避免保留过时兼容分支和死代码。

### 4.1 复杂度约束

| 指标 | 上限 | 超限处理 |
| --- | --- | --- |
| 函数长度 | 50 行以内，不含空行 | 拆分辅助函数 |
| 文件长度 | 300 行以内 | 按职责拆分 |
| 嵌套深度 | 3 层以内 | 使用卫语句或提前返回 |
| 位置参数 | 3 个以内 | 改为配置对象 |
| 圈复杂度 | 10 以内 | 拆分分支逻辑 |
| magic number | 0 | 抽取命名常量 |

### 4.2 纯文本约束

- 代码、注释、日志字符串和 Markdown 文档中禁止使用 Emoji、Unicode 装饰符号及任何非标准 ASCII 装饰性字符。
- 中文和英文正文允许使用；列表使用 `-`、`*` 或数字列表。
- 注释只解释非直观的原因、约束或契约，不解释显而易见的代码。

### 4.3 安全基线

- 严禁在源码中硬编码密钥、凭证、token、证书或个人路径。
- 密钥必须来自环境变量、`.env` 或系统密钥管理；`.env` 不得提交。
- 用户在会话中粘贴密钥用于调试属于正常流程；仅当密钥被写入源码文件时才触发泄漏风险告警。
- 数据库、外部 HTTP、CLIProxyAPI、飞书和 OpenAI 兼容接口调用必须显式处理鉴权失败和超时。
- 上传文件、生成图片、语音临时文件和本地认证数据不得进入 Git。

## 5. 测试与验证

### 5.1 常用命令

```bash
npm install
npm run build
npm start
npm run smoke
npm run smoke:relay
npm run start:relay
npm run relay:mac
npm run asr:start
```

### 5.2 最小验证口径

- 前端或共享 API 变更：至少运行 `npm run build`。
- 主服务变更：至少运行 `npm run smoke`；涉及真实浏览器交互时补充浏览器 smoke。
- Relay 变更：至少运行 `npm run smoke:relay`，并检查 HTTP/WebSocket 错误语义。
- Mac connector 变更：验证 `npm run relay:mac` 相关逻辑，优先用可重复的纯函数或 smoke 覆盖退避、重试和错误路径。
- ASR 变更：验证 `asr-service/requirements.txt`、`asr-service/app.py` 和 `npm run asr:start` 相关启动路径。
- 飞书技能变更：先阅读 `skills/*/SKILL.md`，再用最小权限和最小样本验证。

### 5.3 记录要求

- 主线回归验证记录应沉淀到 `docs/reviews/`，包含命令、退出码、通过或失败摘要、跳过原因。
- 若当前环境无法连接真实依赖，报告中必须写清楚“已覆盖语义，未覆盖真实环境”。
- 不得将本地构建通过等同于手机端、Tailscale、HuggingFace Space 或真实 Codex 子进程全部通过。

### 5.4 结构化数据规则

- 处理 JSON、CSV、WebSocket payload、relay envelope 或 provider response 时，必须明确定义字段顺序、类型和业务含义。
- 多版本格式必须显式区分，不得靠宽松解析吞掉协议错误。
- 测试应覆盖字段缺失、字段错位、空值、超时、鉴权失败和不支持能力。

## 6. Relay 与移动端领域约束

- Relay 投递语义、请求 ID、浏览器 token、Mac connector token 和 pending request 限制不得私自改变。
- 当前 relay 已支持 `/ws/realtime` WebSocket 隧道、`/api/uploads` 与 `/api/voice/transcribe` 的 request streaming，以及 `/generated/*` 与 `/api/voice/speech` 的 response streaming。新增或未接入 streaming 的大型路径必须返回明确错误，不得伪装成功。
- 显式 multi-Mac 路由 UI/API 仍未实现；在完成正式路由模型前，不同 `connectorInstanceId` 的并发 Mac connector 必须被拒绝，不能静默替换 active Mac。
- 429 或限流错误必须保留 `retryAfter` 等可执行信息，前端需据此禁用相关操作。
- Mac connector 重连必须可观测，退避策略应可测试，不得用无限快速重试压垮 Space。
- 移动端界面应优先真实可用：iPhone 小屏、触控、PWA 安装、浅色和深色主题都需考虑。
- 前端不得用仅桌面可见的布局掩盖移动端重叠、遮挡或不可点击问题。

## 7. 环境与运行

| 项目 | 要求 | 验证命令 |
| --- | --- | --- |
| Node.js | 20+ | `node --version` |
| npm | 随 Node 安装 | `npm --version` |
| Codex 配置 | 默认读取 `~/.codex` | 检查 `CODEX_HOME` |
| 私有网络 | Tailscale 或局域网 | 手机访问电脑私网 IP 的 `3321` 端口 |
| Docker | 可选，用于 ASR 或 Space | `docker --version` |
| Python | 可选，用于 ASR 服务 | `python3 --version` |

常用本地地址：

- 本机 HTTP：`http://127.0.0.1:3321`
- 默认 HTTPS：`https://127.0.0.1:3443`
- 本地 ASR：`http://127.0.0.1:8000/v1/audio/transcriptions`

## 8. 提交与文件卫生

- 每个原子任务单独提交，提交信息清晰说明改动内容。
- 提交前运行 `git diff --name-only`，确认只包含任务边界内文件。
- 默认不提交 `.env`、`.codexmobile/`、证书、日志、上传文件、生成图片、编辑器缓存和个人配置。
- 默认不提交 `node_modules/`，除非用户明确要求且仓库策略已经如此定义。
- 若需要更新 `package-lock.json`，必须说明触发原因，例如依赖升级或重新安装。
- 不得删除或重排用户未提交改动。

## 9. 最新认知索引

理解当前阶段代码真相时，优先查阅：

- 全局说明：`README.md`
- Relay 系统设计：`docs/relay-system-design.md`
- Relay 部署：`docs/relay-deployment-runbook.md`
- 前端 UX 契约：`docs/relay-frontend-ux-contract.md`
- 阶段审计报告：`docs/reviews/`

规则：

- `AGENTS.md` 只保留长期约束。
- 阶段性详细认知统一沉淀到 `docs/reviews/`。
- 若文档和代码事实冲突，以任务跟踪文件、`git log` 和当前代码为准，并回写文档。

## 10. 历史踩坑备忘

新增踩坑记录时使用以下格式：

```markdown
- 日期/ID：YYYY-MM-DD 或任务 ID
- 现象：具体失败表现
- 原因：根本原因
- 修复：解决方案和相关提交或文档
```

## 11. Skills 使用规则

- 开始任务前扫描项目已知技能文档；涉及 `skills/` 中场景时必须阅读对应 `SKILL.md`。
- 启用技能时在沟通中声明技能名称与用途。
- 常规开发不强制命中特定技能，仅在语义明确匹配时启用。
