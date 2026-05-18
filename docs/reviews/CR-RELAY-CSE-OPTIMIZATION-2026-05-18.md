# CR-RELAY-CSE-OPTIMIZATION-2026-05-18

## Control Contract

- Primary setpoint: close the main draft-PR gaps without expanding product scope or changing PR state.
- Boundary: relay auth/rate-limit control plane, Space verifier observability, smoke coverage, and docs. GitHub PR state, remote branches, Space secrets, local business API contracts, and explicit multi-Mac routing UI/API remain frozen.
- Guardrails: Mac remains browser token authority; cached valid browser tokens must not be rate-limited as validation misses; realtime verifier must distinguish tunnel reachability from provider readiness.
- Rollback trigger: any regression in relay smoke, local smoke, build, public Space verifier, or diff hygiene.

## Changes

- Token validation cache miss limiting now bypasses cached valid browser tokens. Repeated normal traffic with a valid cached token no longer consumes the token validation bucket.
- `npm run space:verify` now supports an authenticated `/ws/realtime` WebSocket tunnel check via explicit `--check-realtime`.
- Added strict realtime readiness gate via `--require-realtime-ready`; `--check-realtime` accepts `voice.realtime.ready` or non-availability `voice.realtime.error` as evidence that the tunnel reached Mac, while `mac_offline` and `mac_local_offline` still fail.
- Realtime verifier WebSocket waits now fail on pre-event close and include close code/reason instead of masking the condition as a timeout; close rejection is deferred one tick so a final matching message can settle first.
- Updated relay smoke coverage to assert cached valid tokens are not throttled by token validation miss limits.
- Updated runbook and hardening wording to distinguish token validation cache miss limits and realtime tunnel evidence from full provider readiness.

## Verification

| Command | Exit | Result |
| --- | --- | --- |
| `node --check server/relay-runtime.js && node --check server/relay-http.js && node --check scripts/relay-smoke.mjs && node --check scripts/verify-hf-space-core.mjs && node --check tests/space-verify.test.mjs && npm run test:space-verify` | 0 | Passed; space verifier tests 11/11. |
| `npm run smoke:relay` | 0 | Passed; includes cached-token rate-limit regression, multi-Mac guard, streaming, realtime tunnel, and connector smoke. |
| `node --check scripts/verify-hf-space-core.mjs && npm run smoke && npm run build && npm run space:verify -- --url https://misonl-codexmobile-relay.hf.space --json && git diff --check` | 0 | Passed; public Space checks passed 4, authenticated checks skipped without token or pair code. |

## Residual Gate Boundary

- Public Space verifier without token remains read-only and cannot prove authenticated projects, `/ws`, `/ws/realtime`, or chat send.
- Realtime WebSocket verification is opt-in because opening `/ws/realtime` can touch the Mac local realtime provider path.
- `--check-realtime` proves tunnel reachability only when Mac availability errors are absent; `--require-realtime-ready` is the gate for true provider-ready realtime verification. A non-availability `voice.realtime.error` only proves the tunnel reached Mac and provider configuration returned an error.
- Cached valid browser tokens bypass only the token validation cache-miss limiter; a separate per-token request-rate cap remains future hardening for multi-user or hostile network environments.
- Explicit multi-Mac route selection UI/API remains outside this patch; current behavior remains safety rejection of ambiguous routes.
