# Relay Full Hardening Goal

## Goal

把 `codex/relay-phase1` 在当前可合并基础上继续推进：最新代码真实部署到 Space，authenticated E2E 尽可能跑通，外部条件门禁可执行，前端与非 relay 大文件继续低风险拆分，后续产品级能力形成明确任务边界。

## Tasks

- [x] Space redeploy：将当前 head 部署到 `misonL/codexmobile-relay`，验证 public Space 入口。验证：`npm run space:deploy` 与 `npm run space:verify -- --json`。
- [x] Authenticated Space E2E：使用临时本地 server、Mac connector 和 pairing code 覆盖 `/api/projects`、`/ws`、`/api/chat/send`、`/ws/realtime`。验证：`space:verify --require-mac --check-realtime --chat-message ...`。
- [x] Realtime provider-ready：检查是否具备真实 realtime provider 配置；具备则跑 `--require-realtime-ready`，不具备则记录缺口和可复现命令。
- [x] iPhone PWA 实机门禁：固化安装、触控、小屏、浅色/深色、网络切换和 Space 配对清单；能自动覆盖的补浏览器/mobile viewport smoke，真机项记录为人工门禁。
- [x] Frontend split：继续从 `client/src/App.jsx` 与 `client/src/styles.css` 抽低风险模块和样式文件。验证：`npm run build`。
- [x] Non-relay split：继续治理 `server/index.js`、`server/realtime-voice.js`、`server/lark-cli.js` 等大文件中低风险纯函数/路由边界。验证：语法检查、本地 smoke、build。
- [x] Product hardening roadmap：为 explicit multi-Mac routing、per-token request cap、长期审计日志、指标/告警导出和公网/多人使用写出任务边界与验证口径。
- [x] Final verification：运行 relay smoke、Space verifier tests、build、本地 smoke、Space public/auth verifier、diff hygiene，并更新 `docs/reviews/`。

## Done When

- [x] 能自动完成的部署、E2E、拆分、文档和验证均已落地。
- [x] 需要真实 API key、真机或产品决策的项都有明确门禁、命令和记录位置。
- [ ] 最新提交已 push，fork CI 成功，PR 状态可审计。

## Current Evidence

- Review record: `docs/reviews/CR-RELAY-FULL-HARDENING-2026-05-19.md`.
- Latest Space deploy: `misonL/codexmobile-relay` main `fdf3d17`.
- Authenticated Space E2E: passed 9/9.
- Strict realtime provider-ready: blocked by missing local realtime voice API key, fails explicitly with `voice.realtime.error`.
- iPhone PWA: automated 390x844 browser viewport passed; real-device install and network switching remain manual release gates.
