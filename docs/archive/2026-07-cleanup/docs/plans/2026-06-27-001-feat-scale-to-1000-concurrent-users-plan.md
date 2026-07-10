# feat: Infrastructure to support 1000 concurrent users (mixed web + voice)

**Created:** 2026-06-27
**Depth:** Deep (multi-phase; several PRs)
**Status:** plan

## Summary
Make the single-process Railway deployment scale to 1000 concurrent users in a
mixed profile (dashboard/API users *and* live voice calls). The work removes the
DB-pool ceiling, externalizes the few in-process state maps so the API can run
across N replicas, raises queue/endpoint throughput, adds the deploy/autoscale
config, and ships a load-test harness that proves 1000 concurrent end-to-end.
It reuses the codebase's existing `ioredis` store pattern rather than inventing
a new abstraction.

## Problem Frame
Today the API, all 34 background sweeps, the queue poller, and both WebSocket
servers run in **one Node process, 1 Railway replica, no autoscaling**
(`railway.toml`). Affected: every tenant once concurrency rises — requests stall
on the DB pool, voice/WS state is process-local so a second replica is unsafe,
and the queue drains at ~4 msg/s. Measured failure order:
1. **DB pool** — `packages/api/src/db/pool.ts` `max:20`; RLS middleware
   (`packages/api/src/middleware/tenant-context.ts`) holds one connection per
   *whole* request. ~50 concurrent requests saturate it.
2. **Queue throughput** — single 250 ms serial poll (`packages/api/src/app.ts`).
3. **LLM gateway per-tenant quota** (`packages/api/src/ai/gateway/tenant-quota.ts`) — process-local, unbounded map.
4. **In-process state blocking >1 replica** — `VoiceSessionStore`, WS
   `ConnectionRegistry`, gateway InMemory cache fallback.
5. **Full-table scan** — `packages/api/src/workers/supervisor-review-worker.ts`.
6. No per-user rate limiting on `/api`; no CDN; no autoscaling.

## Requirements
- R1. Serve **1000 concurrent users (mixed)** at p95 < 2 s, error < 1% on HTTP,
  with live voice calls completing normally — proven by a committed harness.
- R2. API runs across **N replicas** with no in-process state causing
  cross-replica incorrectness (caps, quotas, voice fan-out).
- R3. **RLS, tenant isolation, audit events preserved unchanged** through
  PgBouncer transaction pooling and every Redis-backed path.
- R4. Safe degrade to **single-instance/in-memory when `REDIS_URL` unset**
  (dev/test parity), mirroring the existing cache pattern.
- R5. A **capacity runbook** stating per-instance ceiling and replicas for 1000,
  from real numbers.

## Key Technical Decisions
- **Reuse the existing store-interface + Redis pattern** (`CacheStore` →
  `InMemoryCacheStore` default → `RedisCacheStore` when `REDIS_URL`, tested with
  `ioredis-mock`). Every new shared store mirrors this. (Alternative: a new Redis
  layer — rejected; one idiom already exists, zero behavior change when unset.)
- **Voice scales by sticky ownership + Redis fan-out, NOT serialized sessions.**
  A `VoiceSession` holds a live FSM, `SessionCostTracker`, `EventEmitter`, and a
  promise-chain lock — non-serializable. Twilio pins a media-stream to one
  instance for the call's lifetime, so the live session stays in-process there;
  we externalize only the **voice event bus → Redis pub/sub** and a
  **`callSid/sessionId → instanceId` directory**. (Alternative: full Redis
  session externalization — rejected; serializes un-serializable objects for no
  benefit since a call already lives on one instance.)
- **DB capacity = PgBouncer (transaction mode) + sized app pool**, not just a
  bigger `max`. RLS uses `SET LOCAL` inside a transaction → transaction-pooling
  compatible. (Alternative: only raise `max` — rejected; N replicas × big pool
  exhausts Postgres `max_connections`.)
- **Queue throughput via bounded per-tick concurrency + replicas**, keeping the
  Postgres queue (already `FOR UPDATE SKIP LOCKED`). (Alternative: pg-boss/SQS —
  deferred; larger migration, current queue scales linearly across replicas once
  per-tick concurrency lands.)
- **Shared rate limiting via the same Redis**, per-tenant/user on `/api`,
  tighter on AI endpoints; in-memory when `REDIS_URL` unset.
- **Measure first, measure last** — U1 baselines before any change; U6 re-runs
  at 1000. Every middle unit cites the metric it moves.

## Scope Boundaries
**In scope:** DB pool/PgBouncer config + saturation metrics; Redis-backed
`ConnectionRegistry`, voice event-bus fan-out + directory, tenant-quota
counters; bounded/TTL caches; queue per-tick concurrency; supervisor-review
query fix + index; per-tenant/user rate limiting; Railway replica/autoscale +
Redis/PgBouncer service config; web nginx/CDN caching; graceful drain for live
calls; k6 HTTP + voice/WS concurrency harness; capacity runbook.

**Non-goals:** external-broker queue rewrite; full Redis session
externalization; multi-region; the quarantined `/experiments/infra` CDK;
changing money/audit/proposal-approval semantics.

### Deferred to follow-up work
- pg-boss/SQS migration if per-tick concurrency + replicas prove insufficient.
- Moving in-request LLM calls fully out of the RLS transaction (big refactor; U2
  audits + fixes cheap wins only).

## Repository invariants touched
- **RLS / tenant_id:** PgBouncer transaction mode must preserve `SET LOCAL`
  tenant context — pinned by a real-DB integration test, never mocks
  (`docs/solutions/database-issues/mocked-pool-hides-real-schema-mismatch.md`).
- **Audit events / LLM gateway:** unchanged; Redis-backed quotas stay
  tenant-scoped and keep identical gateway semantics.
- **Integer cents / UTC / proposal human-approval:** untouched.

## High-Level Technical Design
```
                 ┌──────────── Railway edge / CDN ───────────┐
 web (nginx) ────┤ static (immutable cache) + /api proxy     │
                 └───────────────────────────────────────────┘
   Twilio media-stream (sticky per call)         HTTP / WS
            │                                        │
        ┌───▼─────────  API replicas (N, autoscaled) ▼───┐
        │  in-proc: live VoiceSession (FSM/cost/emitter) │
        │  shared via REDIS_URL:                          │
        │   • ConnectionRegistry counters (per-tenant cap)│
        │   • tenant-quota counters (LLM concurrency)     │
        │   • voice event bus pub/sub + callSid→instance  │
        │   • rate-limit + gateway cache                  │
        └───────────────┬───────────────┬───────────────-┘
              PgBouncer (txn mode)     Redis        Postgres queue
                   │                                (SKIP LOCKED, N consumers)
               Postgres (RLS)
```

## Implementation Units

### U1. Load-test harness + baseline (measure first)
- **Goal:** R1/R5 instrumentation; establish the current single-instance ceiling
  and first bottleneck before any change.
- **Requirements:** R1, R5
- **Dependencies:** none
- **Files:** new `loadtest/http-k6.js` (extends `docs/operations/load-test-staging.md`),
  `loadtest/voice-ws-driver.ts` (concurrent WS/voice sessions, mirrors
  `packages/voice-eval` harness style + `docs/runbooks/voice-capacity.md`),
  `loadtest/README.md`, `loadtest/docker-compose.loadtest.yml` (local API×N +
  Postgres + PgBouncer + Redis target); update `docs/runbooks/voice-capacity.md`.
- **Approach:** ramp HTTP VUs + simulated concurrent voice/WS sessions against a
  target (staging or the local compose); record p95, error rate, throughput, and
  the saturation symptom (expected: DB pool waiters). No app changes.
- **Patterns to follow:** k6 stages in `docs/operations/load-test-staging.md`;
  voice harness style in `packages/voice-eval`.
- **Test scenarios:** `Test expectation: none — this unit IS the test harness.`
  Self-check: harness runs locally against the compose and emits a metrics
  summary; baseline numbers written to the runbook.
- **Verification:** a baseline row in `docs/runbooks/voice-capacity.md` with the
  measured single-instance ceiling and the first bottleneck named.

### U2. DB capacity — PgBouncer + pool sizing + saturation metric
- **Goal:** Remove the ~50-request ceiling (R1, R3).
- **Requirements:** R1, R3
- **Dependencies:** U1 (baseline to compare)
- **Files:** `packages/api/src/db/pool.ts`, `packages/api/src/middleware/tenant-context.ts`
  (connection hold-time audit), `packages/api/src/monitoring/metrics.ts`
  (pool waiters/idle/total gauge), `railway.toml` + PgBouncer service notes,
  `.env.production.example`; tests `packages/api/test/db/pool-config.test.ts`,
  `packages/api/test/integration/pgbouncer-rls-isolation.test.ts`.
- **Approach:** front Postgres with PgBouncer (transaction mode); point the app
  DSN at PgBouncer; size app `max` per replica = f(vCPU, target concurrency);
  export pool-saturation gauge + alert; audit RLS middleware so long external
  (LLM) calls don't sit inside the connection-holding transaction where cheaply
  avoidable.
- **Patterns to follow:** existing `createPool()` env handling; metric
  registration in `packages/api/src/monitoring/metrics.ts`.
- **Test scenarios:**
  - Happy: pool config derives `max` from `DB_MAX_CONNECTIONS` (unit).
  - Integration (Docker, real PG **behind PgBouncer**): two interleaved
    tenant-scoped transactions keep `SET LOCAL` isolation — tenant A never reads
    tenant B rows through transaction pooling. (Pins the highest-risk claim.)
  - Edge: pool-exhaustion surfaces as the saturation metric, not a silent hang.
- **Verification:** integration test green against PgBouncer; load re-run shows
  the pool is no longer the first ceiling.

### U3. Shared state for horizontal scale (unblock >1 replica)
- **Goal:** R2/R4 — no in-process state causes cross-replica incorrectness.
- **Requirements:** R2, R4
- **Dependencies:** none (but must land before running >1 replica in prod)
- **Files:** new `packages/api/src/shared/redis-client.ts` (single
  `createRedisClient()` from `REDIS_URL`);
  `packages/api/src/ws/connection-registry.ts` (+ `RedisConnectionRegistry`);
  `packages/api/src/ai/agents/customer-calling/event-bus.ts` + SSE/client-gateway
  subscribers (Redis pub/sub + `callSid→instanceId` directory with TTL/heartbeat);
  `packages/api/src/ai/gateway/tenant-quota.ts` (Redis counter store + TTL, fix
  unbounded growth); bound/TTL the remaining caches (gateway InMemory fallback,
  whisper, filler-audio, feature-flags, JWKS). Tests:
  `packages/api/test/ws/redis-connection-registry.test.ts`,
  `packages/api/test/ai/gateway/redis-tenant-quota.test.ts`,
  `packages/api/test/ai/agents/customer-calling/redis-event-bus.test.ts`,
  `packages/api/test/integration/redis-shared-state-two-instance.test.ts`.
- **Approach:** each store keeps its current public API (call-sites unchanged);
  the Redis impl is selected when `REDIS_URL` is set, InMemory otherwise — exactly
  the `createCacheStore` factory style.
- **Patterns to follow:** `packages/api/src/ai/gateway/cache.ts`,
  `redis-cache-store.ts`, `test/ai/gateway/factory-cache.test.ts` (ioredis-mock).
- **Test scenarios:**
  - Happy: per-tenant cap / quota enforced via Redis counter (ioredis-mock).
  - Edge: TTL eviction; directory entry expires when an instance dies.
  - Integration: two store instances sharing one Redis (real or
    ioredis-mock shared) observe each other's counts and pub/sub events —
    simulates two replicas; cap is cluster-wide, a voice event published on
    instance A reaches a subscriber on instance B.
  - Parity: with `REDIS_URL` unset, behavior is byte-identical to today.
- **Verification:** two-instance integration test proves cluster-wide caps +
  cross-instance voice fan-out; unset-Redis path unchanged.

### U4. Throughput — queue concurrency, hot-query fix, rate limiting
- **Goal:** Lift queue ≫ 4 msg/s, kill the full-table scan, protect `/api` (R1).
- **Requirements:** R1
- **Dependencies:** U3 (rate-limit store reuses the Redis client)
- **Files:** `packages/api/src/app.ts` (poll loop → claim+process batch of N
  concurrently per tick), `packages/api/src/queues/pg-queue.ts` (batch
  `receive`), `packages/api/src/workers/supervisor-review-worker.ts`
  (`WHERE created_at >= now() - interval '24h'`) + a migration in
  `packages/api/src/db/` adding index `(tenant_id, status, created_at)`, new
  `packages/api/src/middleware/api-rate-limit.ts` (Redis store; in-memory
  fallback) wired in `app.ts`. Tests:
  `packages/api/test/queues/pg-queue-concurrency.test.ts`,
  `packages/api/test/workers/supervisor-review-worker.test.ts` (extend),
  `packages/api/test/integration/supervisor-review-24h-window.test.ts`,
  `packages/api/test/middleware/api-rate-limit.test.ts`.
- **Approach:** bounded concurrency per tick (no double-processing — relies on
  `SKIP LOCKED` + per-message claim); 24 h-window query backed by the new index;
  per-tenant/user limits, tighter on AI endpoints.
- **Patterns to follow:** existing `pg-queue.ts` claim/ack; `express-rate-limit`
  usage already on `/public` in `app.ts`; migration style in `packages/api/src/db/`.
- **Test scenarios:**
  - Happy: N messages processed concurrently per tick; each exactly once.
  - Edge: a slow handler doesn't block the next tick beyond the concurrency cap.
  - Integration (Docker): supervisor-review query returns only rows within 24 h
    and uses the index (pins real columns); rate limit is shared across two
    instances via Redis (the N+1th request from the same tenant is 429 on either
    instance).
- **Verification:** queue throughput scales with concurrency × replicas in the
  load run; supervisor sweep no longer scans full table; `/api` flood is throttled.

### U5. Deploy config — replicas, autoscaling, Redis/PgBouncer, CDN, drain
- **Goal:** Provisioning + safe rollout (R2, R3).
- **Requirements:** R2, R3
- **Dependencies:** U2, U3, U4
- **Files:** `railway.toml` (API replica count + autoscale triggers min/max) +
  Redis & PgBouncer service definitions/notes; `packages/web/nginx.conf`
  (confirm immutable long-cache for hashed assets; CDN-friendly headers) +
  `docs/runbooks/` CDN runbook; `packages/api/src/index.ts` (extend SIGTERM so an
  instance owning live calls **drains** — stop new WS upgrades, let active calls
  finish — before exit); `docs/runbooks/scaling.md`.
- **Approach:** config + documented provisioning steps the user applies in their
  Railway account; no app-logic change beyond the drain handler.
- **Patterns to follow:** existing graceful-shutdown block in
  `packages/api/src/index.ts`; existing `packages/web/railway.toml` + nginx cache
  headers.
- **Test scenarios:** `Test expectation: none — config/infra` for the Railway/CDN
  pieces. The **drain handler** gets a unit test in
  `packages/api/test/shutdown/drain.test.ts` (on SIGTERM: rejects new upgrades,
  resolves once active call count hits 0 or the timeout fires).
- **Verification:** validated by U6 under load; drain test green.

### U6. Validate at 1000 concurrent
- **Goal:** Prove R1/R5 end-to-end.
- **Requirements:** R1, R5
- **Dependencies:** U1–U5
- **Files:** `loadtest/mixed-1000.js` (HTTP VUs + concurrent voice/WS sessions),
  `docs/runbooks/voice-capacity.md` + a final capacity report.
- **Approach:** run the mixed harness at 1000 concurrent against staging (or the
  local compose) with N replicas + Redis + PgBouncer; confirm p95/error targets,
  no pool/queue saturation, voice calls complete; record per-instance ceiling →
  required replicas.
- **Test scenarios:** `Test expectation: none — this unit IS the end-to-end
  validation.` Pass condition = R1 thresholds met and recorded.
- **Verification:** runbook documents a passing 1000-concurrent run and the
  scaling math (replicas, pool sizes, Redis/PgBouncer settings).

## Risks & Dependencies
- **PgBouncer + RLS** is the highest-risk item — gated by the U2 real-DB
  integration test before any prod rollout.
- **Voice fan-out correctness** across replicas (event ordering, directory
  staleness on instance death) — directory entries carry TTL + heartbeat (U3).
- **Provisioning** (Railway Redis/PgBouncer/replicas, staging runs) needs the
  user's Railway account; code/config/harness are built and tested here,
  provisioning steps documented for the user to apply.
- Sequence: U1 → U2 → U3 → U4 → U5 → U6. U2–U4 are independently shippable; U3
  must land before running >1 replica in prod.

## Open Questions (deferred to implementation)
- Exact PgBouncer pool sizing + app `max` per replica — derive from U1 numbers
  and the Railway instance tier.
- Staging availability vs. standing up the local multi-instance compose as the
  load target.
- Autoscale trigger thresholds — set from the U1 saturation signal.

## Sources & Research
- Redis idiom to mirror: `packages/api/src/ai/gateway/cache.ts`,
  `redis-cache-store.ts`, `test/ai/gateway/factory-cache.test.ts`.
- Load-test groundwork: `docs/operations/load-test-staging.md`,
  `docs/runbooks/voice-capacity.md`.
- Multi-instance-safe primitives already present: pg advisory-lock leader
  election + `FOR UPDATE SKIP LOCKED` queue (`packages/api/src/app.ts`,
  `packages/api/src/queues/pg-queue.ts`).
