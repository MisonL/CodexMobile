# CodexMobile Relay 部署 Runbook

本文用于 HuggingFace Docker Space relay 的真实部署、验证、回滚和排障。体系设计见 `docs/relay-system-design.md`，生产化门禁见 `docs/relay-production-hardening-plan.md`。

## 1. 部署前检查

本地代码检查：

```bash
npm install
npm run build
npm run smoke
npm run smoke:relay
npm run space:prepare
npm run smoke:relay:browser-fixture
npm audit --audit-level=high
git diff --check
```

Docker 本地探针：

```bash
docker build -t codexmobile-relay-smoke .
docker rm -f codexmobile-relay-smoke-run >/dev/null 2>&1 || true
docker run -d \
  --name codexmobile-relay-smoke-run \
  -e CODEXMOBILE_RELAY_SECRET=<at-least-32-character-random-secret> \
  -p 9790:7860 \
  codexmobile-relay-smoke
curl -fsS http://127.0.0.1:9790/api/status
curl -fsS http://127.0.0.1:9790/
docker rm -f codexmobile-relay-smoke-run
```

通过条件：

- `/api/status` 返回 `mode: relay`。
- 新容器返回 `macConnected: false`。
- `/` 返回构建后的 PWA HTML，不是 fallback 文本。
- 本地直连 `npm run smoke` 仍通过。

本地浏览器 UX fixture：

```bash
npm run build
npm run smoke:relay:browser-fixture
```

打开 fixture 输出的本地 URL，并在浏览器本地存储中写入 `codexmobile.deviceToken=valid-token` 后刷新页面。通过条件：

- 顶栏显示 `已连接`，项目名来自 fake Mac connector。
- 停止 fixture 或断开 fake Mac 后，页面变为 `Mac 未连接`，发送、上传和语音入口不可继续发起新任务。
- 使用 `CODEXMOBILE_RELAY_FIXTURE_RATE_LIMIT_CHAT=1 npm run smoke:relay:browser-fixture` 启动时，发送文本后只禁用发送操作，并显示 `请求过快，请 ... 秒后再试`。

## 2. HuggingFace Space 配置

官方 Docker Spaces 文档参考：`https://huggingface.co/docs/hub/en/spaces-sdks-docker`。

Space README 顶部 YAML：

```yaml
---
title: CodexMobile Relay
sdk: docker
app_port: 7860
---
```

推荐先生成 HuggingFace Docker Space 工作目录：

```bash
npm run space:prepare
```

默认输出到 `dist/hf-space`，目录内包含 Space README YAML、Dockerfile、`package*.json`、`client/`、`server/` 和运行 relay 所需的 `scripts/`。该目录不得包含 `.env`、`.codexmobile/`、`node_modules/` 或任何 relay secret。

Space variables：

```text
CODEXMOBILE_MODE=relay
HOST=0.0.0.0
PORT=7860
CODEXMOBILE_RELAY_REQUEST_TIMEOUT_MS=120000
CODEXMOBILE_RELAY_HEARTBEAT_MS=15000
CODEXMOBILE_RELAY_IDLE_HEARTBEAT_MS=300000
CODEXMOBILE_RELAY_PENDING_REQUESTS_MAX=64
CODEXMOBILE_RELAY_BROWSER_PENDING_REQUESTS_MAX=6
```

Space secret：

```text
CODEXMOBILE_RELAY_SECRET=<at-least-32-character-random-secret>
```

规则：

- `CODEXMOBILE_RELAY_SECRET` 只能放在 Space Secrets，不写入 README、Dockerfile、`.env.example` 或截图。
- Space URL 使用 HuggingFace 分配的 HTTPS 域名。
- Docker Space 默认端口是 `7860`；若修改 `app_port`，必须同步 `PORT`。

## 3. Mac 侧启动

先启动本地 CodexMobile：

```bash
npm run build
npm start
```

确认本地服务：

```bash
curl -fsS http://127.0.0.1:3321/api/status
```

启动 connector：

```bash
CODEXMOBILE_RELAY_URL=wss://<space>.hf.space/relay/mac \
CODEXMOBILE_RELAY_SECRET=<same-secret-as-space> \
CODEXMOBILE_RELAY_LOCAL_URL=http://127.0.0.1:3321 \
CODEXMOBILE_RELAY_DEVICE_NAME=<mac-name> \
npm run relay:mac
```

Mac 侧通过条件：

- connector 日志出现 `state=online`。
- Space `/api/status` 中 `macConnected` 为 `true`。
- `localStatus.reachable` 为 `true`。

## 4. 真实链路验收

用手机浏览器访问 Space URL。

检查项：

| 步骤 | 预期 |
| --- | --- |
| 加载 PWA | 首页正常加载，无 fallback 文本。 |
| 配对 | 输入 Mac 本地服务配对码后成功，浏览器保存 Mac device token。 |
| 项目列表 | `/api/projects` 返回 Mac 侧项目。 |
| 发送消息 | `/api/chat/send` 返回 `202`。 |
| WebSocket 事件 | `/ws` 收到 `status-update`、`assistant-update` 或 `chat-complete`。 |
| Mac connector 停止 | Space 状态变为 `mac_offline`，新请求返回 `503 mac_offline`。 |
| Mac 本地服务停止 | connector 保持在线，业务请求返回 `503 mac_local_offline`。 |
| Space 重启 | connector 自动重连，浏览器 token 通过 Mac 复验恢复。 |
| 日志抽查 | 不出现 token、secret、配对码、请求体或完整本地路径。 |

验收结果记录到 `docs/reviews/CR-RELAY-DEPLOY-YYYY-MM-DD.md`。

## 5. 回滚

快速回滚策略：

1. 停止 Mac connector。
2. 在 HuggingFace Space Settings 中暂停或删除 relay Space。
3. 手机回到 Mac 局域网、Tailscale 或 Mac HTTPS 地址访问。
4. 保留 Space 和 Mac connector 日志用于排查。

触发回滚：

- 没有 Mac connector 时 UI 仍显示 ready。
- 未认证请求能访问 forwardable API。
- Space 日志出现 token、secret、配对码或请求体。
- relay 路径把请求转发到非 `CODEXMOBILE_RELAY_LOCAL_URL` origin。
- chat send 接受但 Mac 没有收到请求。

## 6. Secret Rotation

Phase 1 单 secret 轮换：

1. 停止 Mac connector。
2. 在 Space Settings 中更新 `CODEXMOBILE_RELAY_SECRET`。
3. Restart Space。
4. 用新 secret 启动 Mac connector。
5. 验证 `/api/status`、配对、`/api/projects`、`/api/chat/send` 和 `/ws`。

失败回退：

- 如果新 secret 无法连接，恢复旧 Space secret。
- Restart Space。
- 用旧 secret 启动 connector。
- 记录失败原因，不在日志或文档中写出 secret 值。

## 7. 常见故障

| 现象 | 优先检查 |
| --- | --- |
| Space 一直 Starting | README YAML 是否为 `sdk: docker`，`app_port` 是否与 `PORT` 一致，容器是否监听 `0.0.0.0`。 |
| `/api/status` 失败 | Space logs、`CODEXMOBILE_MODE`、`CODEXMOBILE_RELAY_SECRET` 长度。 |
| `mac_offline` | connector 是否运行，`CODEXMOBILE_RELAY_URL` 是否是 `wss://.../relay/mac`。 |
| `mac_local_offline` | Mac 本地 `http://127.0.0.1:3321/api/status` 是否可访问。 |
| 配对失败 | Mac 本地服务打印的配对码是否正确，浏览器是否访问 Space URL 而不是旧本地 URL。 |
| `/ws` 401 | 浏览器 token 未配对或 Space 重启后 Mac 无法复验 token。 |
| `/ws/realtime` 501 | Phase 1 预期行为，实时语音仍需本地直连。 |
| 上传、语音或生成图片失败 | Phase 1 预期行为，需等待 Phase 2 streaming。 |

## 8. 部署记录模板

```markdown
# CR-RELAY-DEPLOY-YYYY-MM-DD

## 环境

- Commit:
- Space URL:
- Mac device:
- Local URL:
- Secret rotation: yes/no

## 预检

- npm run build:
- npm run smoke:
- npm run smoke:relay:
- npm audit --audit-level=high:
- git diff --check:
- Docker probe:

## 真实链路

- PWA load:
- Pair via Space:
- /api/projects:
- /api/chat/send:
- /ws event:
- Stop connector:
- Stop local server:
- Restart Space:

## 日志抽查

- Space sensitive data:
- Mac sensitive data:

## 结论

- Pass/Fail:
- Blocking issues:
- Follow-up tasks:
```
