# CR-RELAY-HARDENING-2026-05-22

## Scope

本记录覆盖 relay 与本地运行路径的收尾 hardening：附件路径边界、relay token 校验前限流、streaming 完整性校验、realtime 队列上限、Mac connector identity 持久化、LaunchAgent 双服务安装与部分失败清理、Space deploy 显式 force、静态未定义引用检查，以及 smoke fixture 对 connector identity 契约的同步。

## Changes

- 附件路径必须位于 `UPLOAD_ROOT` 下，上传图片分类和图片编辑读取基础图片前均校验文件 magic bytes。
- `/api/status`、`/ws`、`/ws/realtime` 在触发 Mac token 校验前执行浏览器 token 限流；Mac 校验 5xx 不再把 `/api/status` 标为 authenticated。
- 前端把 `authValidationDeferred` 视为临时 relay 可用性问题，不会在 Mac 离线或鉴权暂不可达时把已有 token 用户踢回配对页。
- relay request/response streaming 校验 `chunks` 与 `totalBytes`，不匹配时显式失败。
- realtime browser frame 和 pending queue 增加大小与队列上限。
- Mac connector identity 持久写入用户级 `connector-instance-id`；relay 默认 pin 已接受的 connector id。旧 connector 离线且没有活跃浏览器工作或 pending request 时允许显式轮换 identity；并发或活跃工作期间仍拒绝不同 connector。
- macOS install 现在写入本地 server 与 relay connector 两个用户级 LaunchAgent，均设置 `KeepAlive`；`status` 同时返回两个服务的 plist 和 loaded 状态。
- LaunchAgent `bootstrap` 成功后立即进入 cleanup 候选；后续 `kickstart` 或第二服务 `bootstrap` 失败会回收已加载服务，CLI JSON 错误输出保留 cleanup 结果。
- `space:deploy` 需要显式 `--force`，默认 `--source` 按 realpath 校验，不允许通过相对路径或 symlink 逃逸仓库。
- `smoke:relay` 的真实 connector fixture 显式使用 `test-mac`，与 relay identity pinning 契约一致。
- 新增最小 ESLint 配置与 `npm run lint`，启用 `no-undef` 覆盖 Node、浏览器和测试文件，CI 在语法检查前执行静态检查。
- Node.js 运行口径统一为 `20.19+`，`package.json` `engines.node`、README、AGENTS 和 CI `20.19.x` 保持一致。

## Verification

| Command | Exit | Result |
| --- | --- | --- |
| `npm run lint` | 0 | ESLint `no-undef` 静态检查通过。 |
| `npm test` | 0 | 148 个 Node tests 通过。 |
| `npm run test:cli` | 0 | 59 个 CLI tests 通过。 |
| `npm run test:server` | 0 | 25 个 server tests 通过。 |
| `npm run test:client` | 0 | 12 个 relay client status tests 通过。 |
| `npm run test:relay-mac` | 0 | 12 个 relay Mac client tests 通过。 |
| `npm run test:relay-runtime` | 0 | 9 个 relay runtime tests 通过。 |
| `npm run test:deploy` | 0 | 17 个 deploy parser tests 通过。 |
| `npm run test:space-verify` | 0 | 12 个 Space verifier tests 通过。 |
| `npm run build` | 0 | Vite production build 通过。 |
| `npm run space:prepare` | 0 | HuggingFace Docker Space 输出到 `dist/hf-space`，共 153 个文件。 |
| 临时 `HOST=127.0.0.1 PORT=9798 npm start` + `CODEXMOBILE_URL=http://127.0.0.1:9798/api/status npm run smoke` | 0 | 本地 server smoke 通过，验证后清理 `9798` 监听进程。 |
| `npm run smoke:relay` | 0 | Relay smoke ok，覆盖离线、限流、重连、streaming、realtime tunnel 和真实 connector fixture。 |
| `git diff --check` | 0 | 无 whitespace 错误。 |
| 改动文件行数扫描 | 0 | 源码、脚本、样式和测试文件均不超过 300 行；README、runbook 和 package-lock 按文档/锁文件处理。 |

## Notes

- 直接运行 `npm run smoke` 时若没有本地 server 监听默认 `127.0.0.1:3321`，会以 `fetch failed` 失败；这不是业务回归。有效验证口径是先启动本地 server，或通过 `CODEXMOBILE_URL` 指向已启动的临时端口。
- 本轮不新增显式 multi-Mac 路由能力；不同 connector identity 的并发 Mac 或活跃工作期间的轮换仍按 `ambiguous_mac_route` 拒绝。
- ESLint 当前只启用 `no-undef`，目标是补足 `node --check` 无法发现的运行期未定义引用；格式化仍以现有代码风格和 `git diff --check` 为准。
