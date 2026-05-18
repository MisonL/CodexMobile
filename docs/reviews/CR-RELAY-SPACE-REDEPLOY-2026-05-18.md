# CR-RELAY-SPACE-REDEPLOY-2026-05-18

## 范围

本记录覆盖 relay latest code 重新部署到 HuggingFace Space `https://misonl-codexmobile-relay.hf.space`，以及部署后的公开检查、Mac connector 检查和浏览器 token 复验。

## 部署记录

| Step | Command | Exit | Result |
| --- | --- | --- | --- |
| Prepare package | `npm run space:prepare` | 0 | `dist/hf-space` generated, 47 files. |
| Package hygiene | `find dist/hf-space ...` | 0 | No `.env`, `.codexmobile`, `node_modules`, `.git`, or logs found. |
| Package content | `rg relay_realtime_http_upgrade_required ... dist/hf-space` | 0 | Deploy package contains realtime tunnel and multi-Mac guard code. |
| First deploy attempt | `GIT_TERMINAL_PROMPT=0 npm run space:deploy -- --remote https://huggingface.co/spaces/misonL/codexmobile-relay --skip-prepare` | 1 | HuggingFace rejected raw PNG binary files. |
| Deploy helper fix | `node --check scripts/deploy-hf-space.mjs` | 0 | Deploy helper syntax passed after adding git-lfs tracking. |
| Redeploy | `GIT_TERMINAL_PROMPT=0 npm run space:deploy -- --remote https://huggingface.co/spaces/misonL/codexmobile-relay` | 0 | Uploaded 3 LFS objects and force-updated Space `main` from `15ffca3` to `6b32b04`. |
| Verifier fix | `npm run test:space-verify` | 0 | Passed, 6 tests; safe `secrets.previousConfigured` metadata is allowed while actual secret values are rejected. |
| Final redeploy | `GIT_TERMINAL_PROMPT=0 npm run space:deploy -- --remote https://huggingface.co/spaces/misonL/codexmobile-relay` | 0 | Uploaded 3 LFS objects and force-updated Space `main` from `6b32b04` to `cd2eb3f`. |
| Deploy workspace cleanup | `test ! -d dist/hf-space/.git` | 0 | Temporary deploy git directory removed. |

## 线上验证

| Check | Evidence | Result |
| --- | --- | --- |
| New container active | `/ws/realtime` changed from `relay_realtime_unsupported` to `relay_realtime_http_upgrade_required` after polling. | Passed |
| Public verifier | `npm run space:verify -- --url https://misonl-codexmobile-relay.hf.space --require-mac --json` | Passed, 4 checks, 0 failed, 3 skipped after final redeploy. |
| Mac connector | `npm run relay:mac` with ignored local relay secret reached `state=online` and `epoch=1`. | Passed |
| Authenticated projects | Existing browser token in Chrome called `/api/projects` through Space and received HTTP `200`. | Passed |
| Browser WebSocket | Existing browser token connected to Space `/ws` and received `connected`. | Passed |
| Realtime WebSocket tunnel | Existing browser token opened Space `/ws/realtime` and received `voice.realtime.error` from Mac local realtime service. This proves the relay tunnel reached Mac; provider configuration remains a Mac local runtime concern. | Passed |

## Gaps

- Current Mac local pairing code was not available in this terminal session, so `--pair-code 123456` returned `403` and full pair-code verification was not repeated.
- Existing browser token was used for authenticated browser checks without printing the token.

## Local Validation After Redeploy

| Command | Exit | Result |
| --- | --- | --- |
| `node --check scripts/deploy-hf-space.mjs` | 0 | Passed. |
| `node --check scripts/verify-hf-space-core.mjs` | 0 | Passed. |
| `node --check tests/space-verify.test.mjs` | 0 | Passed. |
| `npm run test:space-verify` | 0 | Passed, 6 tests. |
| `npm run smoke:relay` | 0 | Passed. |
| `npm run smoke` | 0 | Passed. |
| `npm run build` | 0 | Passed. |
| `npm run space:verify -- --url https://misonl-codexmobile-relay.hf.space --json` | 0 | Passed, 4 public checks, 3 authenticated checks skipped. |
| `git diff --check` | 0 | Passed. |
