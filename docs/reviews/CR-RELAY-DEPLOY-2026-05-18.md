# CR-RELAY-DEPLOY-2026-05-18

## 环境

- Date: 2026-05-18
- Branch: `main`
- Local commits:
  - `4dbf061 feat: add relay transport and connector`
  - `09166ea docs: document relay phase one rollout`
  - `6ab8450 fix: broadcast initial sync after startup`
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
  - `mac_offline` rendered `Mac 未连接` and disabled composer actions.
  - `429 relay_rate_limited` with `retryAfter=20` disabled send with countdown text.

## HuggingFace Space 试运行状态

真实 HuggingFace Space 试运行未执行。当前阻塞是外部凭据与目标环境缺失，而不是代码或本地验证失败。

Observed blockers:

- `CODEXMOBILE_RELAY_URL` is not set.
- `CODEXMOBILE_RELAY_SECRET` is not set.
- `HF_TOKEN` and `HUGGINGFACE_HUB_TOKEN` are not set.
- `hf` and `huggingface-cli` are not installed in the shell environment.
- HuggingFace browser API `GET /api/whoami-v2` returned `401`.
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

After credentials are available, rerun the checklist in `docs/relay-deployment-runbook.md` and update this report with the real Space URL, command results, log review, and pass or fail conclusion.

## 结论

Phase 1A and local browser validation are complete. Phase 1B real HuggingFace Space validation remains blocked until HuggingFace credentials and target Space details are available.
