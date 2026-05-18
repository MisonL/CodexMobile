# CR-RELAY-MULTIMAC-GUARD-2026-05-18

## 范围

本记录覆盖 multi-Mac ambiguous routing 防护：在未实现显式 Mac 选择和路由前，Space 不允许不同 `connectorInstanceId` 的 Mac connector 静默替换 active Mac。

## 变更摘要

- 同一 `connectorInstanceId` 的重连抢占语义保持不变。
- 不同 `connectorInstanceId` 的并发连接关闭为 `4009 ambiguous_mac_route`。
- 缺失 `connectorInstanceId` 的 `mac.hello` 关闭为 `4002 invalid_connector_instance_id`。
- 原 active Mac 不被替换，既有浏览器请求继续转发到原 Mac。
- 新增 `metrics.multiMacRejectedTotal` 用于观察被拒绝的并发 Mac。

## 验证记录

| Command | Exit | Result |
| --- | --- | --- |
| `node --check server/relay-runtime.js` | 0 | Passed. |
| `node --check scripts/relay-smoke.mjs` | 0 | Passed. |
| `node --check scripts/relay-smoke-support.mjs` | 0 | Passed. |
| `npm run smoke:relay` | 0 | Passed; missing connector ID was rejected, different connector was rejected, and original Mac continued serving `/api/projects`. |
| `npm run smoke` | 0 | Passed. |
| `npm run build` | 0 | Passed. |
| `npm run test:space-verify` | 0 | Passed, 4 tests. |
| `git diff --check` | 0 | Passed. |

## 结论

Ambiguous multi-Mac replacement is blocked locally. Remaining full-goal work still includes explicit multi-Mac routing UI/API, realtime voice, real Space redeploy, frontend runtime review, and final PR/git收口.
