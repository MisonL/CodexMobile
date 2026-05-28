# CR-RELAY-RUNTIME-PATHS-2026-05-20

## Scope

本记录覆盖 `codex/relay-phase1` review 后的本地 runtime path 收口：CLI 已将 `CODEXMOBILE_HOME` 传给服务端，服务端本地状态写入也必须统一从该目录派生，避免安装态仍写回源码检出目录的 `.codexmobile`。

## Changes

- 新增 `server/runtime-paths.js`，集中定义服务端数据根目录、状态目录、上传目录、生成图片目录、TLS 目录、ASR 模型缓存目录和 lark-cli 临时目录。
- `CODEXMOBILE_HOME` 设置时，服务端状态写入统一派生自该目录；未设置时继续使用仓库 `.codexmobile`，保持源码开发模式兼容。
- 上传文件、生成图片、图片提示状态、Feishu OAuth 状态、配对状态、隐藏/删除状态、mobile session index、lark-cli agent/guard 和 ASR cache 均切到统一路径。
- `start:bg` 和 ASR 启动脚本现在也显式按仓库根解析 runtime 路径，避免相对 `CODEXMOBILE_HOME` 因调用 cwd 不同而分叉。
- `start:bg` 对派生出的 runtime home 增加绝对路径断言，并补充 `cwd != rootDir` 的相对路径测试，防止未来重构回退。
- README 同步说明 `CODEXMOBILE_HOME` 是本地数据根目录，不是单一 `state` 目录。

## Verification

| Command | Exit | Result |
| --- | --- | --- |
| `node --test tests/server-runtime-paths.test.mjs` | 0 | 5 个服务端 runtime path helper 和模块导入断言通过。 |
| `npm run test:server` | 0 | 15 个 server tests 通过。 |
| `npm run test:space-verify` | 0 | 12 个 Space verifier tests 通过。 |
| `npm run test:cli` | 0 | 49 个 CLI tests 通过，覆盖 CLI 传递 `CODEXMOBILE_HOME` 的既有行为。 |
| `npm run build` | 0 | Vite production build 通过。 |
| `git diff --check` | 0 | 无 whitespace 错误。 |
| 从非仓库 cwd 运行 `scripts/start-server.mjs` | 0 | `PORT=43921`、相对 `CODEXMOBILE_HOME=../tmp/codexmobile-start-bg-smoke` 下 `/api/status` 返回 200，日志和 `auth-state.json` 写入解析后的 runtime 目录，验证后清理进程与临时目录。 |
| 临时 `CODEXMOBILE_HOME` + `npm start` + `npm run smoke` | 0 | `/api/status` smoke 通过；`auth-state.json` 写入临时 `CODEXMOBILE_HOME/state`。 |

## Notes

- 搜索服务端和脚本中的硬编码 `.codexmobile` 写入点后，剩余命中仅为 `server/runtime-paths.js` 默认路径和 `tests/server-runtime-paths.test.mjs` 断言。
- 本次不改变 relay 协议语义、token 语义或 Mac connector 路由行为。
