# CR-RELAY-SECRET-ROTATION-2026-05-18

## 范围

本记录覆盖 relay secret rotation grace window：Space 支持 current secret 与 previous secret 并行接受 Mac connector，便于逐步迁移 connector 凭证。

## 变更摘要

- 新增 `CODEXMOBILE_RELAY_PREVIOUS_SECRET`。
- Mac connector upgrade 接受 `CODEXMOBILE_RELAY_SECRET` 或 `CODEXMOBILE_RELAY_PREVIOUS_SECRET`。
- previous secret 为空时不启用；设置后必须至少 32 字符且不能与 current secret 相同。
- `/api/status` 只暴露 `secrets.previousConfigured`，不暴露 current 或 previous secret 值。
- `space:prepare`、`space:doctor`、README 与 runbook 已同步。

## 验证记录

| Command | Exit | Result |
| --- | --- | --- |
| `node --check server/relay-server.js` | 0 | Passed. |
| `node --check server/relay-runtime.js` | 0 | Passed. |
| `node --check scripts/relay-smoke.mjs` | 0 | Passed. |
| `npm run smoke:relay` | 0 | Passed; previous secret and current secret both connected, wrong secret still rejected. |

## 结论

Relay secret rotation grace window is verified locally. Remaining full-goal work still includes realtime voice, multi-Mac explicit routing, real Space redeploy, frontend runtime review, and final PR/git收口.
