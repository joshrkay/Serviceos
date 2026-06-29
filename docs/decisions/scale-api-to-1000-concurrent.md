# ADR — Scale the API to 1,000 concurrent web sessions (horizontal replicas + CPU autoscale)

## Status

Proposed — 2026-06-28. Deciders: platform/eng lead + the Railway/ops owner.

Scope: the **web/API track**. The voice track (Vapi/ElevenLabs/Claude) is gated
first by vendor concurrency caps and cost and is a separate decision.

Target SLO (assumed — confirm): request **p95 < 300 ms**, error rate < 1%, at
1,000 concurrent web sessions. No hard monthly cost cap, but cost-aware (no
unbounded autoscale).

## Context

The scale-to-1000 program (Phases 0–4) landed the data-tier and shared-state
primitives: PgBouncer two-DSN routing (transaction-mode pool on `:6432`, a
direct DSN for session-scoped work), Redis-backed shared state (WS caps, voice
fan-out, LLM quotas, per-tenant rate limits), queue batch concurrency, graceful
SIGTERM drain, and leader-locked in-process schedulers (`runAsLeader`). Open
question: with those in place, how do we actually carry 1,000 concurrent web
sessions, and what is the binding constraint?

### What we measured (2026-06-28, live Docker stack)

A ramp against the full pooled topology (nginx LB → api → PgBouncer `:6432` →
Postgres, + Redis), single api replica on a 4-vCPU / 3.8 GiB VM:

| VUs | req/s | p50 | p95 | p99 | errors | api CPU | nginx CPU | PgBouncer |
|----:|------:|----:|----:|----:|:------:|:-------:|:---------:|:----------|
| 50  | 917   | 32  | 56  | 107 | 0 | 95% | 90% | 0 waiting, 4/25 server |
| 100 | 815   | 76  | 134 | 178 | 0 | 88% | 97% | 0 waiting, 3/25 server |
| 200 | 956   | 139 | 213 | 283 | 0 | 89% | 96% | 0 waiting, 4/25 server |

- **Binding bottleneck = per-replica CPU.** Throughput plateaus ~900–960 req/s; adding VUs only raises latency. The api is a single-threaded Node event loop (~1 core/process). These are a **conservative lower bound** — in the test, nginx and the load generator shared the same 4 vCPUs as the api; on Railway, web and api are separate services on separate instances.
- **The database is not the constraint.** PgBouncer transaction pooling multiplexed the 20 client connections per replica onto 3–4 Postgres backends with **0 waiting** at every step; Postgres stayed ≤ 25 connections (`default_pool_size`). Redis was idle.
- **0 errors throughout**, and a separate concurrent multi-tenant run showed **9/9 cross-tenant isolation** holding under load.

### Forces

- Node is single-core per process → vertical CPU gives diminishing returns; the natural lever is more processes/replicas.
- PgBouncer caps Postgres connections regardless of replica count: each replica opens `DB_MAX_CONNECTIONS` (20) client conns; `max_client_conn=1000` ⇒ up to ~50 replicas, while the server side stays bounded at `default_pool_size=25`. Large headroom.
- Railway already supports `numReplicas` (`railway.toml`) and metric autoscaling (service-settings UI), with graceful drain wired (`overlapSeconds=35`, `DRAIN_TIMEOUT_MS=25s`, `SHUTDOWN_FORCE_EXIT_MS=30s`).
- "1,000 concurrent sessions" ≠ 1,000 req/s — real sessions have think time. The 200-VU flat flood (~956 rps) is already a heavier arrival rate than 1,000 typical sessions, so a small replica count should suffice.

## Decision

Scale the API **horizontally** behind the existing nginx/Railway load balancer,
governed by **metric-based autoscaling with a fixed floor**: a minimum replica
count sized to steady load, bursting to a bounded maximum on CPU. Keep PgBouncer
transaction mode and `DB_MAX_CONNECTIONS` as-is — they have headroom across the
target replica range. Do **not** make vertical scaling the primary lever (it
can't help a single-threaded event loop past ~1 core), and do **not** run
unbounded autoscale (cost guardrail).

Provisional sizing (confirm in Phase 5): **floor = 2, max = 6**, scale-up at
CPU > 65%, scale-down < 35% with a cool-down. From the measured ~900 rps/replica
lower bound, 2–3 replicas cover 1,000 concurrent web sessions at p95 < 300 ms
with headroom; max = 6 absorbs spikes (~5,400 rps ceiling) before revisiting.

## Options considered

### Option A — Vertical scaling (bigger instances)
| Dimension | Assessment |
|---|---|
| Complexity | Low |
| Cost | Med–High (large instances bill continuously) |
| Scalability | Poor — Node uses ~1 core/process; extra cores idle |
| Team familiarity | High |

**Pros:** one instance, simplest mental model, no LB fan-out.
**Cons:** doesn't address the actual bottleneck (single-threaded CPU); pays for cores the event loop can't use; single point of failure; no burst elasticity.

### Option B — Fixed horizontal replicas (`numReplicas = N`)
| Dimension | Assessment |
|---|---|
| Complexity | Low |
| Cost | Med — pay for N continuously |
| Scalability | Good up to N; manual to change |
| Team familiarity | High (`railway.toml` key) |

**Pros:** dead simple, deterministic, already a `railway.toml` field; correct now that leader-lock + drain + Redis shared state make >1 replica safe.
**Cons:** static — over-provisions at trough, can under-provision at peak; capacity changes are manual redeploys.

### Option C — Metric autoscale with a floor (recommended)
| Dimension | Assessment |
|---|---|
| Complexity | Med (configure triggers + test scale events) |
| Cost | Best — pay for the floor, burst only when needed |
| Scalability | Best — elastic to the bounded max |
| Team familiarity | Med (Railway service-settings UI, not `railway.toml`) |

**Pros:** capacity matches load; floor guarantees a baseline and avoids cold-start on first traffic; bounded max is the cost guardrail; rides on primitives already in place (graceful drain, leader-lock, Redis-backed caps make replicas safe).
**Cons:** must validate scale-up reaction time vs. spike steepness; the autoscale config lives in the Railway UI (not in code), so it's an operator action to document and guard against drift.

### Option D — App-level CPU reduction (complementary, not exclusive)
Profile and cut per-request CPU: gate the per-request verbose JSON logging (it
filled a disk under load in testing), shape responses, cache hot tenant-scoped
reads. Raises per-replica throughput, lowering the replica count A–C need.
Pursue **alongside** C, not instead of it.

## Trade-off analysis

The real choice is **B vs. C** — A doesn't address the bottleneck. Both B and C
are *correct today*: the merged work (leader-locked sweeps so replicas don't
double-run schedulers, SIGTERM drain so rolling deploys don't drop live calls,
Redis-backed caps/quotas so limits are cluster-wide) is exactly what makes >1
replica safe. C wins on cost-efficiency and spike resilience, at the price of
one-time autoscale tuning and config that lives in the Railway UI rather than
`railway.toml`. Given a cost-aware mandate (no hard cap) and bursty web traffic,
floor+autoscale is the best fit; **B is a clean fallback** if autoscale tuning
slips — ship `numReplicas=3` and iterate. D is orthogonal upside that lowers the
replica count for whichever of B/C is chosen.

## Consequences

### Positive
- Capacity tracks load; the floor + bounded max bound both spend and blast radius.
- DB stays protected: PgBouncer keeps Postgres ≤ `default_pool_size` regardless of replica count — the scale lever never touches the data tier.
- Reuses already-merged safety primitives; no new mechanism to build.
- Headroom: ~900 rps/replica (conservative) × up to 6 ≫ the ~1,000-session arrival rate.

### Negative / costs
- Autoscale config is operator-set in the Railway UI (no PR trail) → must be documented and reviewed so it doesn't silently drift.
- More replicas → more PgBouncer client conns (N×20); stay under `max_client_conn=1000` (≤ ~50 replicas). Fine for this range, but a ceiling to remember.
- Per-replica log volume multiplies; the verbose per-request JSON logging is a real cost under load — gate it (Option D) before sustained high traffic.
- Scale events exercise the drain path on every scale-down; keep stop-grace ≥ 35 s.

### What we'll need to revisit
- Replace the provisional floor/max/triggers with Phase 5 numbers from a real ramp on Railway-sized instances (the measured per-replica figure is a co-located lower bound).
- The voice-track ceiling + cost (separate ADR) — likely the true 1,000-concurrent constraint for the business.

## Implementation

1. [ ] Provision Redis + PgBouncer on Railway and wire the two DSNs (`DATABASE_URL`→PgBouncer:6432, `DATABASE_DIRECT_URL`→Postgres:5432); set `REDIS_URL` + `VOICE_FANOUT_ENABLED=true` **before** raising replicas (see `docs/deployment.md`).
2. [ ] Set autoscale in Railway service settings: floor = 2, max = 6, scale-up CPU > 65%, scale-down < 35%, cool-down ≥ 60 s; confirm stop-grace ≥ 35 s.
3. [ ] Run the Phase 5 ramp (`loadtest/http-load.ts` / `docs/runbooks/phase5-validation-handoff.md`) to 1,000 concurrent against the autoscaled stack; record p50/p95/p99, the replica count it settles at, and cost.
4. [ ] Gate per-request logging (sample, or level by `NODE_ENV`) to cut per-replica CPU + log volume (Option D).
5. [ ] Document the autoscale settings in `docs/deployment.md` (operator-only, UI-set) so they don't drift.
6. [ ] Re-run cross-tenant isolation probes at target concurrency — isolation that holds at 1 user can break once caching/pooling scale.

## Alternatives considered

See Options A / B / D above. **A rejected** (doesn't address the single-threaded
CPU bottleneck). **B retained as the fallback** if autoscale tuning is deferred.
**D adopted as complementary** to whichever of B/C ships.

## Revisit triggers

- Phase 5 shows per-replica throughput materially different from the ~900 rps lower bound.
- Replica count approaches ~40–50 (PgBouncer `max_client_conn` pressure) → raise it or shard the pool.
- p95 breaches 300 ms at target → profile and cut per-request CPU (Option D) before adding replicas.
- Sustained floor cost exceeds budget → lower the floor or pursue Option D.

## References

- `docs/runbooks/scaling.md` — two-DSN setup, pool sizing, provisioning & rollout
- `docs/runbooks/phase5-validation-handoff.md` — the 1,000-concurrent run
- `docs/deployment.md` → Production readiness — deploy artifacts + operator actions
- `deploy/docker-compose.prod.yml`, `deploy/pgbouncer/pgbouncer.ini`, `deploy/nginx/api-lb.conf`
- Measured load run: this session, 2026-06-28 (50/100/200-VU ramp; bottleneck = api/nginx CPU, DB pool idle)
