# CR-RELAY-VERIFICATION-2026-05-18

## 范围

本记录覆盖 CodexMobile Relay Phase 1 的代码级、浏览器级和真实 HuggingFace Space 验证。

## 本地验证

| Command | Exit | Result |
| --- | --- | --- |
| `npm run smoke:relay` | 0 | Passed; output included `Relay smoke ok`. |
| `npm run test:space-verify` | 0 | Passed; 4 tests passed. |
| `node --test tests/space-verify.test.mjs` | 0 | Passed; 4 tests passed. |
| `npm run build` | 0 | Passed. |
| `npm run space:prepare` | 0 | Passed; generated 47 files. |
| `npm audit --audit-level=high` | 0 | Passed; `found 0 vulnerabilities`. |
| `git diff --check` | 0 | Passed. |

## 真实浏览器验证

Local relay fixture:

- Chrome loaded the local relay fixture.
- `valid-token` reached the ready state and displayed `已连接`.
- `SIGUSR2` disconnected the fake Mac connector.
- UI switched to `Mac 未连接`.
- Composer send, upload, and voice actions were disabled.

Real HuggingFace Space:

- Chrome loaded `https://misonl-codexmobile-relay.hf.space`.
- Pairing screen appeared.
- Test pairing code `123456` paired through the Space.
- UI switched to `已连接`.
- Project list and sessions loaded from the Mac local runtime through the Space relay.

## 真实 HuggingFace Space 验证

Space:

- Repo: `misonL/codexmobile-relay`
- URL: `https://misonl-codexmobile-relay.hf.space`
- SDK: Docker
- Commit: `15ffca389731c50eb305d95fe6b7c2167cad1838`
- Runtime: `RUNNING`

Public verifier:

- Command: `npm run space:verify -- --url https://misonl-codexmobile-relay.hf.space --json`
- Result: passed 4 checks.

Authenticated verifier:

- Command: `npm run space:verify -- --url https://misonl-codexmobile-relay.hf.space --pair-code 123456 --chat-message "CodexMobile relay verification" --require-mac --json`
- Result: passed 8 checks.
- Verified PWA load, status, unsupported realtime route, unauthenticated pairing requirement, pairing, projects, browser WebSocket, and chat send plus WebSocket event.

Recovery checks:

- Stopped Mac connector: authenticated request returned `503 mac_offline`.
- Stopped Mac local service while connector stayed online: authenticated request returned `503 mac_local_offline`.
- Restarted Space: connector reconnected automatically after reconnect timer fix; existing browser token revalidated and authenticated project listing passed.

Sensitive data checks:

- Space logs checked: 36 lines.
- No relay secret, browser token, pairing code, Authorization header, chat body, or local absolute repo path was found.
- Repository text scan found no generated relay secret or browser token.

## 结论

Relay Phase 1 implemented scope is verified. Remaining work belongs to later phases: realtime voice relay, streaming binary transfer, generated asset streaming, and multi-Mac routing.
