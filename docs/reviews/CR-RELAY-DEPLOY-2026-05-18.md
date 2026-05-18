# CR-RELAY-DEPLOY-2026-05-18

## 环境

- Date: 2026-05-18
- Branch: `main`
- Local commits:
  - `4dbf061 feat: add relay transport and connector`
  - `09166ea docs: document relay phase one rollout`
  - `6ab8450 fix: broadcast initial sync after startup`
  - `d596285 docs: record relay space deployment blocker`
  - `36b7198 chore: add HuggingFace Space prepare script`
  - `9f0235c test: add relay browser fixture coverage`
  - `72cfe04 chore: add HuggingFace Space deploy helper`
- Pull request: `https://github.com/RNG2018-mlxg/CodexMobile/pull/4`
- Space URL: not available
- Mac local URL: `http://127.0.0.1:3321`
- Secret rotation: no

## 预检

- `npm run smoke:relay`: passed
- `npm run build`: passed
- `CODEXMOBILE_URL=http://127.0.0.1:3321/api/status npm run smoke`: passed
- `git diff --check`: passed
- Real browser local relay check: passed
  - Fixture URL: `http://127.0.0.1:9792`
  - Ready state rendered `已连接`, project list, and the composer.
  - `mac_offline` rendered `Mac 未连接` and disabled composer actions while preserving the draft.
  - `429 relay_rate_limited` disabled only the send action and rendered `请求过快，请 18 秒后再试`.
  - Screenshot captured at `.codexmobile/relay-browser-offline.png`.

## HuggingFace Space 部署包

本地已补齐无密钥 Space 工作目录生成脚本，便于拿到 HuggingFace 凭据后直接推送到目标 Docker Space 仓库。

Commands:

- `npm run space:prepare`: passed
  - Output directory: `dist/hf-space`
  - Generated files: 44
- `npm run space:deploy -- --remote .codexmobile/hf-space-bare.git`: passed
  - Local bare remote received `refs/heads/main`.
  - Temporary deploy git metadata was removed from `dist/hf-space` after push.
- `npm --prefix dist/hf-space ci`: passed
  - `postinstall` patched Codex SDK spawn options.
  - `found 0 vulnerabilities`
- `npm --prefix dist/hf-space run build`: passed
  - Vite production build completed.
- `PORT=9791 HOST=127.0.0.1 CODEXMOBILE_RELAY_SECRET=<redacted> npm --prefix dist/hf-space run start:relay`: passed
  - `GET http://127.0.0.1:9791/api/status` returned `mode: relay`.
  - `macConnected` was `false`, as expected without a Mac connector.
- `npm run smoke:relay:browser-fixture`: passed
  - Output URL: `http://127.0.0.1:9792`
  - Browser token: `valid-token`
  - Chat rate limit fixture: enabled
  - `SIGUSR2` disconnect path for the fake Mac connector was verified in-browser.
- `find dist/hf-space ...`: passed
  - No `.env`, `.codexmobile`, `node_modules`, `.git`, `*.log`, or `status.json` remained after regeneration.

Deployment package constraints:

- Space README YAML is generated with `sdk: docker` and `app_port: 7860`.
- `CODEXMOBILE_RELAY_SECRET` is documented only as a Space secret placeholder.
- The generated package includes `Dockerfile`, `package*.json`, `client/`, `server/`, and relay-required scripts.
- The generated package excludes local state, dependencies, logs, runtime output, and credentials.

## Phase 1 门禁矩阵

| Gate | Evidence | Status |
| --- | --- | --- |
| Phase 1A build | `npm run build` | Passed |
| Phase 1A local direct smoke | `CODEXMOBILE_URL=http://127.0.0.1:3321/api/status npm run smoke` | Passed |
| Phase 1A relay protocol smoke | `npm run smoke:relay` | Passed |
| Frontend relay UX | in-app Browser fixture: ready, `mac_offline`, `relay_rate_limited` | Passed |
| Connector reconnect policy | `npm run smoke:relay` covers active/idle cap, stable reset, reconnect epoch failure | Passed |
| Docker Space package | `npm run space:prepare`; `dist/hf-space` generated without secrets | Passed |
| Space git deploy path | `npm run space:deploy -- --remote .codexmobile/hf-space-bare.git` | Passed with local bare remote |
| Phase 1B real Space deploy | Create/update HuggingFace Docker Space | Blocked: no HuggingFace credentials or target Space |
| Phase 1B public mobile flow | Space URL PWA load, pair, `/api/projects`, `/api/chat/send`, `/ws` | Blocked: no public Space URL or relay secret |
| Phase 1B recovery checks | stop connector, stop local server, restart Space | Blocked: requires real Space runtime |
| Phase 1B log inspection | Space and Mac logs contain no secret/token/body/path leakage | Blocked: requires real Space runtime |

## HuggingFace Space 试运行状态

真实 HuggingFace Space 试运行未执行。当前阻塞是外部凭据与目标环境缺失，而不是代码或本地验证失败。

Observed blockers:

- `CODEXMOBILE_RELAY_URL` is not set.
- `CODEXMOBILE_RELAY_SECRET` is not set.
- `HF_TOKEN` and `HUGGINGFACE_HUB_TOKEN` are not set.
- `hf` and `huggingface-cli` are not installed in the shell environment.
- `huggingface_hub` Python package is not installed in the shell environment.
- HuggingFace browser API `GET /api/whoami-v2` returned `401`.
- No HuggingFace git remote is configured.
- No target Space URL or Space secret was available for deployment.

## 未执行项

- Create or update HuggingFace Docker Space.
- Configure Space variables and `CODEXMOBILE_RELAY_SECRET`.
- Start Mac local server and connector against the real Space URL.
- Pair through the Space URL.
- Verify `/api/projects`, `/api/chat/send`, `/ws`, `mac_offline`, `mac_local_offline`, and Space restart recovery through the public Space URL.
- Inspect Space and Mac logs for sensitive data.

## 恢复条件

To complete Phase 1B, provide one of the following:

- A valid HuggingFace token with permission to create or update the target Space.
- An already configured Space URL plus the matching relay secret.
- An interactive HuggingFace login session usable by CLI or browser with permission to manage the target Space.

After credentials are available, push `dist/hf-space` to the target HuggingFace Docker Space repository, configure the Space variables and secret from `docs/relay-deployment-runbook.md`, then update this report with the real Space URL, command results, log review, and pass or fail conclusion.

## 结论

Phase 1A, local browser validation, and the no-secret Docker Space deployment package are complete. Phase 1B real HuggingFace Space validation remains blocked until HuggingFace credentials and target Space details are available.
