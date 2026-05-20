# CodexMobile

CodexMobile 是一个面向 iPhone 的 Codex PWA 客户端。它在电脑上启动一个轻量本地桥接服务，通过 Tailscale、局域网或其它私有网络，让手机可以访问并使用这台电脑上的 Codex 项目、会话和模型能力。

这个项目适合个人使用：你可以在 iPhone 主屏像 App 一样打开它，切换 Codex 项目、查看线程、发送文字或语音消息、上传文件，并在手机上接收 Codex 的实时回复和执行状态。

> 本项目不是公网 SaaS、多人控制台或远程桌面工具。建议只在可信私有网络中使用。

## 界面演示

| 项目抽屉 | 对话与模型选择 | 语音整理交给 Codex |
| --- | --- | --- |
| <img src="docs/images/ios-drawer.png" width="260" alt="CodexMobile 项目抽屉" /> | <img src="docs/images/ios-chat.png" width="260" alt="CodexMobile 对话界面" /> | <img src="docs/images/voice-handoff.jpg" width="260" alt="语音对话整理任务后交给 Codex 执行" /> |

## 功能特性

- iPhone 优先的 PWA 界面，可添加到 iOS 主屏
- 读取本机 Codex 项目和会话，支持项目切换、线程展开、重命名和删除
- 新建对话、续聊已有线程，并通过 WebSocket 显示实时状态
- 支持权限模式、模型选择和推理强度选择
- 支持图片/文件上传，文件保存在本机并将路径交给 Codex 使用
- 支持语音输入：前端录音，后端转写后自动发送给 Codex
- 支持实时语音对话：可以持续说想法，由 Realtime 模型即时回应
- 支持“总结一下交给 Codex”：语音模型把口语想法整理成明确任务，确认后交给 Codex 执行
- 支持语音朗读：优先 Edge Neural TTS，可回退 OpenAI 兼容 TTS 或 Windows 本地语音
- 支持飞书文档、PPT、表格和云空间操作：通过本机 `lark-cli` 授权，以用户身份创建、读取和修改
- 移动端任务进度更简洁：只显示创建文档、读取表格、验证结果等关键过程，隐藏命令生命周期噪音
- 支持本地 SenseVoice/FunASR 中文语音识别服务
- 支持生成图片并在移动端展示
- 支持 CLIProxyAPI Codex 额度查询
- 支持浅色/深色主题
- 支持一次性配对码和本机设备 token，适合私有网络访问

## 架构

```text
iPhone PWA
  |
  | HTTPS / WebSocket，建议走 Tailscale 或局域网
  v
CodexMobile Node.js 服务
  |-- 读取 ~/.codex/config.toml
  |-- 读取 ~/.codex/sessions
  |-- 调用 @openai/codex-sdk 发送和续聊
  |-- 调用 OpenAI 兼容接口生成图片
  |-- 调用本地 SenseVoice ASR 或 OpenAI 兼容转写接口
  |-- 可选调用本机 lark-cli 操作飞书文档、PPT、表格和云空间
  |-- 可选调用 CLIProxyAPI 管理接口查询 Codex 额度
```

## 环境要求

- Node.js 20+
- npm
- 已配置好的本机 Codex 环境，默认读取 `~/.codex`
- 手机和电脑在同一私有网络中，例如 Tailscale 或局域网
- 可选：Docker Desktop，用于本地 SenseVoice 语音识别
- 可选：CLIProxyAPI，用于 OpenAI 兼容路由、图片生成或额度查询

## 快速开始

```powershell
git clone https://github.com/RNG2018-mlxg/CodexMobile.git
cd CodexMobile
npm install
npm run build
npm start
```

启动后在电脑浏览器打开：

```text
http://127.0.0.1:3321
```

手机访问时，建议先把电脑和 iPhone 接入 Tailscale 或同一个局域网，然后打开：

```text
http://<电脑的私网 IP>:3321
```

第一次进入需要输入服务启动时打印的 6 位配对码。配对成功后，浏览器会保存设备 token，后续不需要每次重新输入。

## npm CLI 管理

当前分支提供 `codexmobile` CLI 的产品化安装骨架。现有命令支持本机预检、状态查看、服务启停、日志查看和 macOS 用户级 LaunchAgent 显式安装。`install` 只有在用户主动执行非 dry-run 命令时才会写入 `~/Library/LaunchAgents/com.codexmobile.agent.plist`，不会改变现有 `npm start` 使用方式。

本仓库内可直接执行：

```bash
node bin/codexmobile.mjs doctor --json
node bin/codexmobile.mjs start --json
node bin/codexmobile.mjs status --json
node bin/codexmobile.mjs logs --json
node bin/codexmobile.mjs stop --json
node bin/codexmobile.mjs install --dry-run --json
node bin/codexmobile.mjs install --json
node bin/codexmobile.mjs enable --json
node bin/codexmobile.mjs disable --json
node bin/codexmobile.mjs uninstall --json
node bin/codexmobile.mjs relay-config --json
```

发布为 npm 包后，等价入口为：

```bash
npx codexmobile doctor --json
npx codexmobile start --json
npx codexmobile status --json
npx codexmobile logs --json
npx codexmobile stop --json
npx codexmobile install --dry-run --json
npx codexmobile install --json
npx codexmobile enable --json
npx codexmobile disable --json
npx codexmobile uninstall --json
npx codexmobile relay-config --json
```

`doctor` 会检查 Node.js 版本、Codex 配置路径、默认 HTTP/HTTPS 端口、Tailscale 命令可用性和本机私网地址。`start` 会用后台进程运行 `codexmobile serve`，日志写入用户级日志目录；若旧 PID 已被其他进程复用或 state 结构不完整，`start` 会清理 stale state 后重新启动。`stop` 只停止 CLI 状态文件记录且命令行匹配的 CodexMobile 进程；`logs` 会读取最近日志并脱敏 relay secret、Bearer token 和 URL token；`status` 会返回用户级数据目录、日志目录、LaunchAgent 路径、plist 是否存在、`launchctl` 是否已加载和脱敏后的 relay 配置。`install --dry-run` 只输出将要创建的目录、plist 内容、将要执行的 `launchctl` 命令和错误处理说明，其中 `bootout` 仅允许服务未加载或不存在类错误失败；`install` 会写入 plist、执行 `plutil -lint`，再以幂等方式 `bootout` 旧用户服务、`bootstrap` 并 `kickstart`。`enable` 同样会幂等重载并 kickstart 当前用户 LaunchAgent，`disable` 调用 `launchctl bootout`。`uninstall` 默认只移除 plist 并保留用户数据目录；删除用户数据必须显式同时传入 `--remove-data --confirm-remove-data`。

保存 Mac connector 的 relay 配置：

```bash
node bin/codexmobile.mjs relay-config \
  --url wss://<space>.hf.space/relay/mac \
  --secret <至少 32 字符的随机密钥> \
  --local-url http://127.0.0.1:3321 \
  --json
```

该配置写入用户级 `relay.json`，`relay-config --json` 和 `status --json` 只展示脱敏后的 secret。`npm run relay:mac` 会优先读取环境变量；环境变量未设置时，回退读取这份用户级配置。

### CLI 验证范围与跨平台边界

源码检出目录内使用 `node bin/codexmobile.mjs ...`，发布包使用 `npx codexmobile ...`。CLI 状态目录、日志目录和 `relay.json` 均为用户级路径；实际路径以 `node bin/codexmobile.mjs status --json` 返回的 `paths` 为准。

当前自动化覆盖：

- `npm run test:cli`：CLI 路由、用户级路径解析、macOS LaunchAgent plist、进程启停保护、日志脱敏、relay config 读写与脱敏。
- `npm run build`：前端 PWA production build。
- `npm run smoke`：本机 `/api/status` 可访问性。
- `npm run smoke:relay`：本地 relay server、真实 Mac connector 进程、离线/限流/重连/streaming/realtime tunnel smoke。
- `npm run test:space-verify`：Space verifier 的离线单元测试，不等同于真实 HuggingFace Space 部署验证。

当前平台边界：

- macOS：已实现用户级 LaunchAgent，显式 `install` 才写入 `~/Library/LaunchAgents/com.codexmobile.agent.plist`。
- Windows：已覆盖路径解析和子进程 PATH 去重；进程状态目前只做 PID 存活判断，不做命令行归属校验；尚未实现 Task Scheduler 自启安装。
- Linux：已覆盖 XDG 用户数据路径解析；尚未实现 user systemd 自启安装。

以下仍需真实环境复验，不能由本地自动化结果代替：iPhone PWA 安装、移动端 Safari 麦克风权限、手机经 Tailscale 访问、本机重启后 macOS 登录自启、真实 HuggingFace Space authenticated connector、真实 Codex 子进程完整对话链路。

## HuggingFace Space 中转模式

中转模式用于手机无法直连 Mac 私有网络时访问 CodexMobile。公网入口运行在 HuggingFace Docker Space，Mac 上运行 connector 主动连到 Space，再由 Space 转发浏览器请求到 Mac 本地服务。

当前 relay 支持小体积 JSON / text HTTP 请求、普通 `/ws` 事件转发、`/ws/realtime` 实时语音 WebSocket 隧道、`/api/uploads` 和 `/api/voice/transcribe` 的 chunked request streaming，以及 `/generated/*` 和 `/api/voice/speech` 的 chunked response streaming。其他未接入 streaming 的大型响应下载仍然需要本地直连，relay 会返回明确错误。

Space 环境变量示例：

```bash
CODEXMOBILE_MODE=relay
HOST=0.0.0.0
PORT=7860
CODEXMOBILE_RELAY_SECRET=<至少 32 字符的随机密钥>
# 可选：只在轮换窗口内设置旧密钥，完成迁移后清空
CODEXMOBILE_RELAY_PREVIOUS_SECRET=<上一组随机密钥>
```

Space 启动命令：

```bash
npm run start:relay
```

生成不含密钥的 HuggingFace Docker Space 工作目录：

```bash
npm run space:prepare
```

默认输出到 `dist/hf-space`。将该目录内容推送到目标 Space 仓库后，再在 HuggingFace Space Settings 中配置 `CODEXMOBILE_RELAY_SECRET`。

拿到目标 Space git remote 后可直接推送：

```bash
npm run space:deploy -- --remote <huggingface-space-git-remote>
```

部署前检查当前机器是否具备真实试运行条件：

```bash
npm run space:doctor -- --remote <huggingface-space-git-remote>
```

Mac 端需要先启动本地 CodexMobile，再启动 connector：

```bash
npm start
npm run relay:mac
```

如果没有先通过 `relay-config` 保存配置，也可以继续用环境变量启动 connector：

```bash
CODEXMOBILE_RELAY_URL=wss://<space>.hf.space/relay/mac \
CODEXMOBILE_RELAY_SECRET=<同一个随机密钥> \
CODEXMOBILE_RELAY_LOCAL_URL=http://127.0.0.1:3321 \
npm run relay:mac
```

Mac connector 默认每 4 分钟向 Space 同源 `/api/status?keepalive=1` 发送一次不带密钥的 HTTP GET，用于避免 Space 因长时间只有 WebSocket 空闲连接而自动休眠。可通过 `CODEXMOBILE_RELAY_KEEPALIVE_MS=<毫秒>` 调整间隔；活动间隔下限为 60000；设为 `0` 表示显式关闭。

本地 relay smoke：

```bash
npm run smoke:relay
```

更完整的 relay 设计、部署和前端状态契约：

- `docs/relay-system-design.md`
- `docs/relay-production-hardening-plan.md`
- `docs/relay-deployment-runbook.md`
- `docs/relay-frontend-ux-contract.md`

## HTTPS 与 iOS 语音权限

iOS Safari / PWA 通常要求 HTTPS 才能稳定使用麦克风。你可以使用自己的证书、反向代理，或 Tailscale Serve 暴露 HTTPS 地址。

示例：

```powershell
$env:CODEXMOBILE_PUBLIC_URL="https://<your-device>.<your-tailnet>.ts.net:3443/"
npm run start:env
```

如果你使用自签名证书，可以通过环境变量指定：

```powershell
$env:HTTPS_PFX_PATH="C:\path\to\server.pfx"
$env:HTTPS_PFX_PASSPHRASE="change-me"
$env:HTTPS_ROOT_CA_PATH="C:\path\to\root-ca.cer"
npm run start:env
```

## 配置

复制示例配置：

```powershell
Copy-Item .env.example .env
npm run start:env
```

常用配置项：

- `HOST`：服务监听地址，默认 `0.0.0.0`
- `PORT`：HTTP 端口，默认 `3321`
- `HTTPS_PORT`：HTTPS 端口，默认 `3443`
- `CODEXMOBILE_PUBLIC_URL`：手机访问用的公开私网地址
- `CODEXMOBILE_PAIRING_CODE`：可选固定 6 位配对码；不设置则启动时随机生成
- `CODEX_HOME`：Codex 配置目录，默认 `~/.codex`
- `CODEXMOBILE_HOME`：覆盖 CLI 和服务的本地状态目录；CLI 未设置时按平台选择用户级目录，例如 macOS `~/Library/Application Support/CodexMobile`
- `CODEXMOBILE_FEISHU_APP_ID` / `CODEXMOBILE_FEISHU_APP_SECRET`：可选飞书应用凭证，用于 `lark-cli` 文档集成
- `LARK_APP_ID` / `LARK_APP_SECRET`：可选飞书凭证别名，供 `lark-cli` 和 Codex 子进程读取
- `CLIPROXYAPI_CONFIG`：CLIProxyAPI 配置文件路径
- `CLIPROXYAPI_API_KEY` / `CLI_PROXY_API_KEY`：OpenAI 兼容接口密钥
- `CODEXMOBILE_CLIPROXY_MANAGEMENT_URL`：CLIProxyAPI 管理接口地址
- `CODEXMOBILE_CLIPROXY_MANAGEMENT_KEY`：CLIProxyAPI 管理密钥
- `CODEXMOBILE_RELAY_URL`：Mac connector 连接的 Space WebSocket 地址，仅 `npm run relay:mac` 使用
- `CODEXMOBILE_RELAY_SECRET`：Space 和 Mac connector 共享的当前 relay 密钥，至少 32 字符
- `CODEXMOBILE_RELAY_PREVIOUS_SECRET`：可选旧 relay 密钥，只用于 secret rotation grace window，完成迁移后应清空
- `CODEXMOBILE_RELAY_LOCAL_URL`：Mac connector 转发到的本地 CodexMobile 地址，默认 `http://127.0.0.1:3321`
- `CODEXMOBILE_RELAY_KEEPALIVE_MS`：Mac connector 对 Space 的 HTTP keepalive 间隔，默认 `240000`，活动间隔下限 `60000`，设为 `0` 可关闭
- `CODEXMOBILE_RELAY_PENDING_REQUESTS_MAX`：Space 全局 pending relay 请求上限，默认 `64`
- `CODEXMOBILE_RELAY_BROWSER_PENDING_REQUESTS_MAX`：单浏览器 token pending relay 请求上限，默认 `6`

不要提交 `.env`、`.codexmobile`、证书、日志、上传文件、生成图片或本地认证数据。

## 本地中文语音识别

CodexMobile 支持本地 SenseVoice/FunASR 语音识别。第一版默认使用 `iic/SenseVoiceSmall`，更适合中文、粤语、口音和短指令场景。

启动本地 ASR 服务：

```powershell
npm run asr:start
```

默认接口：

```text
http://127.0.0.1:8000/v1/audio/transcriptions
```

语音数据不会保存为聊天附件。服务端只在内存中处理上传音频；如果模型推理必须落临时文件，会在请求结束后立即删除。

相关配置：

- `CODEXMOBILE_LOCAL_TRANSCRIBE_BASE_URL`
- `CODEXMOBILE_TRANSCRIBE_MODEL`
- `CODEXMOBILE_ASR_DEVICE`
- `CODEXMOBILE_ASR_PORT`

## 图片生成

图片生成使用 OpenAI 兼容接口。你可以通过 CLIProxyAPI 或其它兼容服务提供图片模型。

相关配置：

- `CODEXMOBILE_IMAGE_BASE_URL`
- `CODEXMOBILE_IMAGE_API_KEY`
- `CODEXMOBILE_IMAGE_MODEL`
- `CODEXMOBILE_IMAGE_TIMEOUT_MS`

生成的图片默认保存到 `.codexmobile/generated`，不会进入 Git。

## CLIProxyAPI 额度查询

如果本机配置了 CLIProxyAPI 管理接口，CodexMobile 可以在 iPhone 抽屉中查询 Codex 额度。

相关配置：

- `CODEXMOBILE_CLIPROXY_MANAGEMENT_URL`
- `CODEXMOBILE_CLIPROXY_MANAGEMENT_KEY`
- `CLIPROXYAPI_CONFIG`

返回给前端的数据会脱敏，不会返回 access token 或完整密钥。

## 常用脚本

- `npm run build`：构建 PWA 到 `client/dist`
- `npm start`：启动 API、WebSocket 和构建后的 PWA
- `npm run start:env`：读取 `.env` 后启动
- `npm run start:bg`：后台启动服务，日志写入 `.codexmobile`
- `npm run start:relay`：启动 HuggingFace Space relay server
- `npm run relay:mac`：启动 Mac connector，主动连接 Space relay
- `npm run smoke:relay`：运行 relay 离线、转发、事件和重连 smoke
- `npm run asr:start`：构建并启动本地 SenseVoice ASR Docker 容器
- `npm run smoke`：检查本机 `/api/status`

## 私有网络部署建议

推荐方式：

1. 电脑和 iPhone 都安装 Tailscale。
2. 电脑启动 CodexMobile。
3. 使用 Tailscale IP 或 Tailscale Serve HTTPS 地址访问。
4. 第一次访问时输入配对码。
5. 在 iPhone Safari 中选择“添加到主屏幕”。

不建议直接把 CodexMobile 暴露到公网。

## 安全说明

- 配对 token 存储在 `.codexmobile/state`
- 上传文件和生成图片存储在 `.codexmobile`
- `.env.example` 只包含占位配置，不包含真实密钥
- `.gitignore` 已排除 `.env`、`.codexmobile`、证书、日志、构建产物和依赖目录
- CLIProxyAPI / OpenAI key 应通过环境变量或本地配置文件提供
- 本项目默认按单用户、私有网络场景设计

## License

MIT
