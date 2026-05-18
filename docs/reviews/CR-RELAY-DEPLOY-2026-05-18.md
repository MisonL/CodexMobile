# CR-RELAY-DEPLOY-2026-05-18

## 环境

- Date: 2026-05-18
- Branch: `main`
- Pull request: `https://github.com/RNG2018-mlxg/CodexMobile/pull/4`
- Space repo: `misonL/codexmobile-relay`
- Space URL: `https://misonl-codexmobile-relay.hf.space`
- Space SDK: Docker
- Space visibility: public
- Deployed Space commit: `15ffca389731c50eb305d95fe6b7c2167cad1838`
- Mac local URL: `http://127.0.0.1:3321`
- Relay secret: configured in HuggingFace Space Secrets; value not recorded

## 预检

| Check | Result |
| --- | --- |
| `npm run build` | Passed |
| `npm run smoke:relay` | Passed |
| `npm run test:space-verify` | Passed |
| `npm run space:prepare` | Passed; generated 47 files |
| `npm audit --audit-level=high` | Passed; `found 0 vulnerabilities` |
| `git diff --check` | Passed |
| Chrome local relay fixture | Passed; ready, `mac_offline`, and rate-limit states verified |

## HuggingFace Space 部署

- Created Space `misonL/codexmobile-relay` with `space_sdk=docker`.
- Configured Space variables:
  - `CODEXMOBILE_MODE=relay`
  - `HOST=0.0.0.0`
  - `PORT=7860`
  - `CODEXMOBILE_RELAY_REQUEST_TIMEOUT_MS=120000`
  - `CODEXMOBILE_RELAY_HEARTBEAT_MS=15000`
  - `CODEXMOBILE_RELAY_IDLE_HEARTBEAT_MS=300000`
  - `CODEXMOBILE_RELAY_PENDING_REQUESTS_MAX=64`
  - `CODEXMOBILE_RELAY_BROWSER_PENDING_REQUESTS_MAX=6`
- Configured Space secret `CODEXMOBILE_RELAY_SECRET`.
- `npm run space:deploy -- --remote https://huggingface.co/spaces/misonL/codexmobile-relay` was rejected by HuggingFace git pre-receive because PNG icons require Xet-backed binary upload.
- Deployed with `huggingface_hub.HfApi.upload_folder`, excluding `.git/**`.
- Final uploaded commit: `15ffca389731c50eb305d95fe6b7c2167cad1838`.
- Runtime status after deploy: `RUNNING`.

## 真实链路验收

Public read-only verifier:

```bash
npm run space:verify -- --url https://misonl-codexmobile-relay.hf.space --json
```

Result:

- Passed 4 checks.
- `/` returned built PWA HTML.
- `/api/status` returned relay mode.
- `/ws/realtime` returned `501 relay_realtime_unsupported`.
- Unauthenticated `/api/projects` returned `401 pairing_required`.

Full verifier with Mac connector:

```bash
npm run space:verify -- --url https://misonl-codexmobile-relay.hf.space --pair-code 123456 --chat-message "CodexMobile relay verification" --require-mac --json
```

Final result:

- Passed 8 checks, failed 0, skipped 0.
- PWA load: passed.
- `/api/status`: passed.
- `/ws/realtime`: passed.
- Unauthenticated `/api/projects`: passed.
- Pair through Space: passed.
- Authenticated `/api/projects`: passed, `projects=8`.
- Browser `/ws`: passed, `relayState=ready`.
- `/api/chat/send`: passed, returned `202` and a browser WebSocket event was received.

Chrome browser verification:

- Opened `https://misonl-codexmobile-relay.hf.space`.
- Pairing screen loaded.
- Entered test pairing code `123456`.
- UI switched to `已连接`.
- Project list and sessions loaded from the Mac side.

## 恢复验证

Mac connector stopped:

- Space `/api/status` switched to `macConnected=false`.
- Authenticated `/api/projects` returned:

```json
{ "status": 503, "error": "mac_offline" }
```

Mac local service stopped while connector remained online:

- Space observed `macConnected=true` and `localStatus.reachable=false`.
- Authenticated `/api/projects` returned:

```json
{ "status": 503, "error": "mac_local_offline" }
```

Space restart:

- `huggingface_hub.HfApi.restart_space(repo_id="misonL/codexmobile-relay")` requested a Space restart.
- Runtime returned to `RUNNING` on commit `15ffca389731c50eb305d95fe6b7c2167cad1838`.
- First run exposed a connector bug: reconnect timer used `.unref()` and the connector process exited after Space restart.
- Fixed `scripts/relay-mac-client.mjs` so the reconnect timer keeps the process alive.
- After the fix, connector logs showed:
  - `state=reconnecting`
  - `state=connecting`
  - `state=authenticating`
  - `state=online`
- Existing browser token was revalidated after Space restart:
  - Passed 6 checks with `CODEXMOBILE_DEVICE_TOKEN`.
  - Authenticated `/api/projects`: passed, `projects=8`.
  - Browser `/ws`: passed, `relayState=ready`.

## 日志与敏感信息

Space log scan:

- Checked latest 36 Space log lines.
- No matches for:
  - relay secret
  - browser token
  - pairing code
  - `Authorization` / `Bearer`
  - chat body
  - local absolute repo path

Repository scan:

- Scanned tracked and untracked text files outside `dist/`, `.git/`, and `node_modules/`.
- No matches for the generated relay secret or browser token.

Local secret handling:

- Relay secret is stored locally in ignored runtime state: `.codexmobile/state/hf-space-relay-secret.txt`.
- Browser token was used only for verification and must not be committed.

## Phase 1 门禁矩阵

| Gate | Evidence | Status |
| --- | --- | --- |
| Phase 1A build | `npm run build` | Passed |
| Phase 1A local direct smoke | `CODEXMOBILE_URL=http://127.0.0.1:3321/api/status npm run smoke` | Passed in earlier gate |
| Phase 1A relay protocol smoke | `npm run smoke:relay` | Passed |
| Frontend relay UX | Chrome local fixture and real Space browser pairing | Passed |
| Connector reconnect policy | `npm run smoke:relay`; real Space restart recovery | Passed after reconnect timer fix |
| Docker Space package | `npm run space:prepare`; `dist/hf-space` generated without secrets | Passed |
| Space deployment | `HfApi.upload_folder` to `misonL/codexmobile-relay` | Passed |
| Public Space flow | `space:verify` public checks | Passed |
| Authenticated Space flow | pair, `/api/projects`, `/ws`, `/api/chat/send` | Passed |
| Mac connector stop recovery | `503 mac_offline` | Passed |
| Mac local service stop recovery | `503 mac_local_offline` | Passed |
| Space restart recovery | connector reconnect and token revalidation | Passed |
| Log sensitive data inspection | Space log scan and repo scan | Passed |

## 结论

Phase 1A and Phase 1B are complete for the implemented Phase 1 scope. The HuggingFace Space relay is deployed, the Mac connector can bridge real browser traffic to the Mac local CodexMobile runtime, and the recovery paths for connector stop, local service stop, and Space restart have been verified.

Out of scope for Phase 1:

- `/ws/realtime` voice relay.
- Streaming upload, speech, generated images, and large binary transfer.
- Multi-Mac routing.
- Long-term secret rotation with a dual-secret grace window.
