# Relay Branch Closeout

## Goal

将 `codex/relay-phase1` 收口到可评审状态：文档口径与当前代码一致，自动化门禁可重复运行，真实 Space 验证边界清楚，复杂度与后续产品能力有明确任务边界。

## Tasks

- [x] 文档口径对齐：统一 `README.md`、`AGENTS.md`、`docs/relay-*.md` 中 relay 已支持能力、显式错误边界和未实现的 multi-Mac 路由 UI/API。验证：`rg -n "Phase 1 不支持|不是完整支持|暂不等价|Out of scope for Phase 1|realtime voice|generated images" README.md AGENTS.md docs/relay-*.md docs/reviews` 后只保留历史审计或明确后续边界。
- [x] CI 门禁：新增 GitHub Actions，运行 `npm ci`、语法检查、`npm run test:space-verify`、`npm run smoke:relay`、`npm run smoke`、`npm run build` 和 `git diff --check`。验证：本地逐项执行同一组命令。
- [x] 复杂度治理：评估 relay 大文件，优先拆出低风险纯函数/常量；无法安全拆完的部分写入审计边界，不继续扩大核心文件。验证：`wc -l server/relay-runtime.js server/relay-http.js scripts/relay-mac-client.mjs scripts/relay-smoke.mjs tests/space-verify.test.mjs`。
- [x] 当前线上只读验证：运行 public `space:verify`，确认 PWA、safe status、未认证边界和 realtime HTTP fallback。验证：命令 0 退出码且 failed 为 0。
- [x] 真实 Mac 链路复验边界：记录是否具备 browser token 或 pairing code；具备时验证 `/api/projects`、`/ws`、`/api/chat/send`、`/ws/realtime --check-realtime`，不具备时明确跳过原因。
- [x] 后续边界：明确 multi-Mac 正式路由和公网使用加固不伪装完成。验证：`docs/reviews/CR-RELAY-CLOSEOUT-2026-05-19.md` 记录后续任务。
- [x] PR 收口：确认 PR draft 状态、checks、工作区卫生和剩余任务，形成 `docs/reviews/CR-RELAY-CLOSEOUT-2026-05-19.md`。验证：`git status --short --branch` 干净或只含本轮预期文件。

## Done When

- [x] 本轮文档、CI、验证记录均已提交到可审查 diff。
- [x] 所有本地门禁通过，线上只读 verifier 通过。
- [x] 未完成事项只剩明确后续产品任务或需要真实 token/connector 的人工复验项。
