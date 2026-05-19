# CR-RELAY-REVIEW-FIXES-2026-05-19

## Scope

本记录覆盖 `CM-CLI-008`：`codex/relay-phase1` 对 `main` review 后的两项修复。范围包括 CLI stop stale PID 复用保护，以及 Mac connector 无效 JSON response 不再静默降级为空对象。

## Fixes

- `cli/process-manager.mjs`：`stopManagedServer` 在 PID 仍存在时，会用 `ps -p <pid> -o command=` 校验命令行仍匹配记录的 CLI path 和 `serve` 命令；不匹配时只清理 stale state，不发送 kill。
- `scripts/relay-mac-client-body.mjs`：本地服务返回 `application/json` 但 body 不是合法 JSON 时，保留原始 text 响应，不再改写为 `{}`。
- `tests/cli-process-manager.test.mjs`：新增 PID 复用场景和 live command 校验测试。
- `tests/relay-mac-client-body.test.mjs`：新增无效 JSON response 编码测试。
- `package.json`：新增 `npm run test:relay-mac` 作为 Mac connector 相关单元测试入口。

## Verification

| Command | Exit code | Result |
| --- | --- | --- |
| `node --test tests/cli-process-manager.test.mjs tests/relay-mac-client-body.test.mjs` red phase | 1 | 新增两个测试分别失败于 stale PID 仍被 stop、无效 JSON 仍返回 `bodyEncoding=json`。 |
| `node --test tests/cli-process-manager.test.mjs tests/relay-mac-client-body.test.mjs` | 0 | 12 tests passed. |
| `npm run test:relay-mac` | 0 | 1 Mac connector body test passed. |
| `npm run test:cli` | 0 | 37 CLI tests passed. |
| `npm run test:relay-runtime` | 0 | 2 relay runtime tests passed. |
| `npm run test:space-verify` | 0 | 11 Space verifier tests passed. |
| `npm run smoke:relay` | 0 | Relay smoke ok，包含离线、限流、重连和错误路径。 |
| `npm run build` | 0 | Vite production build completed. |
| `git diff --check` | 0 | No whitespace errors. |

## Notes

- Windows 仍保留原有 PID 存活检查；macOS/Linux 已增加命令行匹配，覆盖本仓库当前 macOS CLI 安装路径的误杀风险。
- 无效 JSON response 继续作为成功 HTTP response 传递，但以 `text` 编码暴露原始内容，避免伪造空 JSON 成功路径。
