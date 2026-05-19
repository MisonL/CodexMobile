# Relay Final Completion Goal

## Goal

将 `codex/relay-phase1` 从可评审状态推进到可合并完成状态：代码职责继续收敛，验证证据可重复，PR 状态清楚，所有需要真实外部条件的门禁都有明确边界。

## Tasks

- [x] 拆分 `server/relay-runtime.js` 的 realtime tunnel、stream response、Mac connection 等职责。验证：语法检查、`npm run smoke:relay`、`npm run test:space-verify`。
- [x] 拆分 `scripts/relay-mac-client.mjs` 的 HTTP forwarding、request streaming、realtime tunnel 和 connection loop。验证：语法检查、`npm run smoke:relay`。
- [x] 梳理 `client/src/App.jsx` 与 `client/src/styles.css` 的拆分路径，优先抽出低风险 API/relay 状态组件或 hooks。验证：`npm run build`。
- [x] 复核 realtime provider-ready 门禁。若本机没有 realtime API key，只记录 tunnel 已验证与 provider-ready 未覆盖原因；若具备配置，运行 `space:verify --check-realtime --require-realtime-ready --require-mac`。
- [x] 固化 iPhone PWA 实机回归清单：安装、触控、小屏、浅色/深色、网络切换和 Space 配对。验证：能执行则记录结果，不能执行则标记外部设备门禁。
- [x] 复核上游 PR 与 fork CI 状态，确保最新 head、CI run、merge state 和 review 状态可审计。
- [x] 将多 Mac 正式路由、公网/多人安全加固明确为后续产品阶段，不伪装为当前分支完成项。
- [x] 更新 `docs/reviews/` 收口记录，写清本轮命令、退出码、完成项和外部条件项。
- [x] 执行最终验证：`npm run smoke:relay`、`npm run test:space-verify`、`npm run build`、`git diff --check`，并检查 `git status --short --branch`。

## Done When

- [x] 当前分支无隐藏失败路径，自动化门禁通过。
- [x] 可完成的代码拆分已经落地，并有测试证据。
- [x] 不能在本机完成的真实设备或 provider 门禁被明确记录为外部条件。
- [x] PR、CI、分支和工作区状态可直接用于合并判断。
