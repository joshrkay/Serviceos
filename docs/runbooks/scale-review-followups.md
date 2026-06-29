# Scale-to-1000 — deferred review follow-ups (PR #628)

Automated review (Codex/Gemini) on PR #628 surfaced items beyond the ones already
fixed on the branch. The **contained, confirmed** bugs were fixed inline; the
items below are **deferred deliberately** — they are failure-mode hardening that
only bites under the pooled / multi-replica topology (i.e. at Phase 5), or need a
design decision. None block the current green deploy. Address before running the
PgBouncer + N-replica topology in production.

## Already fixed on PR #628 (for context)
- Migrations run through the direct DSN (`migrate.ts`, `d6e4e7e5`).
- Redis client attaches an `error` listener so a background error can't crash the
  process (`redis-client.ts`, `226c6cc1`).
- Cross-tenant `SET LOCAL ROLE` is SAVEPOINT-guarded so a missing role can't abort
  the sweep transaction (`rls-runtime-role.ts`, `d1879ded`).
- SSE routes bypass the request transaction via an explicit route allowlist
  (`tenant-context.ts`, `c529345a`).
- Graceful-drain ordering: background loops halt before the voice drain wait
  (`app.ts`, `75354350`).

## P1 — needs a design decision
- **Serialize provisioning jobs per tenant.** `app.ts:~2175` — the U-P3b per-tick
  batch concurrency can run two `provision_twilio_subaccount` messages for the
  same tenant concurrently (e.g. signup job + `/phone/retry`), so both can create
  a Twilio subaccount / buy a number before either persists. The worker only skips
  `full_readiness`. Fix: per-tenant FIFO for provisioning messages, or a
  worker-level tenant lock taken before the external Twilio steps. Decision needed
  on which (FIFO key vs. advisory lock).

## P2 — Redis-fallback lease/quota accounting (cap-bypass after a transient blip)
When Redis throws for one acquisition the lease is recorded only in the
per-process fallback registry; once Redis recovers, later acquisitions ignore the
still-open local leases, so a tenant can exceed the cap. Same shape in two places —
fix together (combine local + Redis counts on admission, or keep counting local
leases until they drain):
- WS connection cap — `ws/redis-connection-registry.ts:~95`
- LLM tenant quota — `ai/gateway/redis-tenant-quota.ts:~177`

## P2 — lease lifecycle on aborted / long-lived streams
- **Release on aborted upgrade/acquire.** A client can close the socket while the
  Redis-backed acquire `await` is pending; nothing releases the lease, leaking a
  tenant slot until TTL. `ws/client-gateway.ts:~474` and
  `telephony/media-streams/mediastream-adapter.ts:~584` (the `start()` path that
  fires `handleMessage` without serializing). Check socket/stream state after
  acquire and release on abort.
- **Refresh telephony leases past TTL.** A call longer than the 2-hour lease TTL is
  dropped from the Redis zset while still connected, admitting later calls past the
  cap. `mediastream-adapter.ts:~310` — add a periodic `lease.refresh()` for live
  streams, or cap call duration below the TTL.

## P2 — voice fan-out completeness (U3d)
- **Same-replica WS subscribers miss live frames.** On the replica that owns the
  call, the local event hook only mirrors to Redis (then dropped by the `replicaId`
  check); the supervisor wall subscribes over `/api/ws`, not the per-session SSE.
  `voice-session-store.ts:~335` — publish to the client gateway from the local emit
  path too.
- **Remote-session discovery before targeted publish.** Targeted publishes to
  `env.sessionId` for calls owned by another replica are dropped because
  `/api/voice/sessions/active` only lists this process's sessions.
  `voice-session-store.ts:~373` — mirror remote session presence into discovery, or
  emit a tenant-scoped discovery frame first.

## P2 — readiness
- **Probe the direct pool in `/ready`.** `app.ts:~742` — when `DATABASE_DIRECT_URL`
  is set, `/ready` only checks the main pool, so a bad direct DSN still admits
  traffic while leader election / idempotency lock / LISTEN-NOTIFY fail. Add a
  `SELECT 1` on `directPool` when `directPool !== pool`.

## Low priority / tooling
- `loadtest/http-load.ts:~106` — rotating counter `r` can overflow
  `MAX_SAFE_INTEGER` (~3.4M reqs) and skew the endpoint spread; bound with `% 1e6`.
- `loadtest/http-load.ts:~203` — ramp-down only spawns VUs, never asks excess VUs
  to exit, so a non-zero rampdown holds peak concurrency (skews baseline numbers).
- `packages/web/src/routes.ts` — lazy route wrappers are defined inside the `lazy:`
  loaders (HMR/identity churn). Optional: export them from their page modules.
