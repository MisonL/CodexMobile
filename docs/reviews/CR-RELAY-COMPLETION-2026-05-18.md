# CR-RELAY-COMPLETION-2026-05-18

## Scope

This final audit records the current completion boundary for PR #4, based on code state, deployed Space behavior, and fresh verification on 2026-05-18.

## Included In This PR

- HuggingFace Space relay server, Mac connector, browser relay UX, deploy helper, public verifier, runbook, and review records.
- Chunked request streaming for upload and voice transcription.
- Chunked response streaming for generated assets and speech audio.
- `/ws/realtime` WebSocket tunnel from browser to Space to Mac local `/ws/realtime`, including frame sequencing, byte accounting, epoch binding, and backpressure handling.
- Relay secret rotation grace window.
- Multi-Mac safety guard: same `connectorInstanceId` may reconnect, missing IDs are rejected, and different IDs are rejected as `4009 ambiguous_mac_route`.
- Real Space redeploy to `https://misonl-codexmobile-relay.hf.space`, with deploy helper Git LFS tracking for PNG/JPG/WebP/GIF/ICO assets.

## Explicit Boundary

Explicit multi-Mac route selection UI/API is not implemented in this PR. The accepted boundary for this PR is safety hardening: the relay prevents ambiguous Mac replacement until an explicit routing model exists.

The real Space authenticated browser and realtime tunnel checks were completed earlier with an existing browser token. This final audit does not print or persist that token.

## Fresh Verification

| Command | Exit | Result |
| --- | --- | --- |
| `node --check scripts/deploy-hf-space.mjs && node --check scripts/verify-hf-space-core.mjs && node --check tests/space-verify.test.mjs && npm run test:space-verify && npm run smoke:relay && npm run smoke && npm run build` | 0 | Passed; space verifier tests 11/11, relay smoke ok, local smoke ok, Vite build ok. |
| `npm run space:verify -- --url https://misonl-codexmobile-relay.hf.space --json` | 0 | Passed public checks: PWA, safe status, realtime HTTP fallback, unauthenticated pairing requirement; authenticated checks skipped without token or pair code. Realtime WebSocket remains opt-in via `--check-realtime`. |
| `git diff --check` | 0 | Passed. |
| `gh pr view 4 --repo RNG2018-mlxg/CodexMobile --json number,title,state,isDraft,headRefName,headRepositoryOwner,baseRefName,url,reviewDecision,statusCheckRollup` | 0 | PR #4 is open, not draft, base `main`, head `MisonL:codex/relay-phase1`, with no status checks configured. |

## Conclusion

PR #4 is ready for review within the boundary above. The remaining explicit multi-Mac routing UI/API is a separate product feature, not a hidden incomplete path in the current relay.
