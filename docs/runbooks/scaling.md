# Scaling runbook (DB pooling + replicas)

How to scale the API past the single-instance ceiling. Companion to the
scale-to-1000 plan
(`docs/plans/2026-06-27-001-feat-scale-to-1000-concurrent-users-plan.md`) and the
capacity baseline in `docs/runbooks/voice-capacity.md`.

## The connection-pool ceiling

The RLS middleware holds one Postgres connection for the whole request, so a
single replica saturates its pool (`DB_MAX_CONNECTIONS`, default 20) at roughly
that many concurrent in-flight requests. Two levers remove the ceiling:

1. **PgBouncer (transaction mode)** in front of Postgres, so N replica pools
   multiplex onto a bounded Postgres `max_connections`.
2. **More replicas**, once shared state is externalized (plan Phase 2/U3+).

## Two-DSN setup (required when using PgBouncer)

PgBouncer transaction mode reuses a server backend between transactions, which
**breaks session-scoped Postgres state**. The app therefore uses two DSNs:

| Env var | Points at | Used by |
|---------|-----------|---------|
| `DATABASE_URL` | **PgBouncer** (transaction mode) | request hot path, repositories, queue — all transaction-scoped (`SET LOCAL`), pooling-safe |
| `DATABASE_DIRECT_URL` | **Postgres directly** (session) | leader-election advisory locks (`app.ts` `runAsLeader`), the proposal idempotency lock, LISTEN/NOTIFY — session-scoped, must keep a stable backend |

`DATABASE_DIRECT_URL` is **optional**: when unset the app reuses `DATABASE_URL`
for those users (correct for single-instance / no-PgBouncer). Wiring:
`createDirectPool()` in `packages/api/src/db/pool.ts`.

PgBouncer config: `pool_mode = transaction`, `max_client_conn` high (e.g. 1000),
`default_pool_size` = the real Postgres server-connection budget (e.g. 25).

> ⚠️ Before enabling **`RLS_RUNTIME_ROLE=true`** with PgBouncer, land **U2b-2**
> (convert `PgBaseRepository.withTenant` / `withCrossTenantSweep` to `SET LOCAL`
> transactions — see the `FOLLOW-UP` comments in `packages/api/src/db/pg-base.ts`).
> Until then the standalone repo-read path uses a plain session `SET`, which is
> not transaction-pooling-safe under RLS enforcement. With RLS off (the default)
> there is no exposure — in-request reads reuse the request transaction.

## Pool sizing

- Per-replica app pool: `DB_MAX_CONNECTIONS ≈ vCPU × 4`, bounded by expected
  concurrent **open transactions** per replica. Keep request transactions short
  (don't `await` long LLM/HTTP calls inside the RLS transaction) so PgBouncer
  actually multiplexes — a request with an open transaction pins a server
  backend for its whole life.
- Direct pool: `DB_DIRECT_MAX_CONNECTIONS` small (default 10) — only lock holders
  + the LISTEN client use it.
- Postgres ceiling = PgBouncer `default_pool_size` (server side), independent of
  how many app-side client connections N replicas open.

## What to watch

`/metrics` exposes `db_pool_connections{pool,state}` (`state` = total | idle |
waiting). **Saturation signal:** `state="waiting"` persistently > 0 while
`state="total"` is pinned at `DB_MAX_CONNECTIONS`. Alert on that.

## Scaling replicas (Railway)

- Set replica count + autoscaling triggers (CPU / memory / request rate) in the
  Railway **service settings** for the `api` service.
- The app drains the pg pool(s) on `SIGTERM` (`app.ts` shutdown handler);
  tenant sweeps are leader-locked (advisory lock via the direct DSN) so only one
  replica runs them; the Postgres queue is multi-instance-safe (`FOR UPDATE SKIP
  LOCKED`).
- Shared in-process state (WS connection caps, LLM quotas, voice fan-out) must be
  externalized to Redis (plan Phase 2/U3) **before** running > 1 replica in
  production.

## Shared state across replicas (Redis)

In-process state must be externalized to Redis before running > 1 replica.
Foundation: `createRedisClient()` / `shutdownRedisClients()`
(`packages/api/src/redis/redis-client.ts`) — every shared store reuses it and
returns its InMemory implementation when `REDIS_URL` is unset (byte-identical to
single-instance).

- **Gateway response cache** (already Redis-capable): set `REDIS_URL` **and**
  `AI_CACHE_ENABLED=true` so the LLM cache is shared cluster-wide instead of each
  replica keeping its own `InMemoryCacheStore` (which is now FIFO size-bounded as
  a memory safety net, default 5000 entries). Zero call-site change — the wrapper
  swaps in Redis asynchronously.
- **WS connection caps** (U3b): per-tenant connection counters move to Redis when
  `REDIS_URL` is set, so the cap is cluster-wide instead of per-replica. Leases
  carry a TTL so a crashed replica's slots are reclaimed; the path fails open to a
  local count if Redis is unreachable. Zero call-site change.
- **Voice event fan-out** (U3d): a live `VoiceSession` stays in-process on the
  replica Twilio pinned the media-stream to; only the small `VoiceSessionEvent`
  stream is mirrored over Redis pub/sub so the escalation/supervisor wall and the
  client WS gateway on OTHER replicas can observe a call they don't own.
  Double-gated — set `REDIS_URL` **and** `VOICE_FANOUT_ENABLED=true`. Best-effort
  and additive: the in-process EventEmitter remains the synchronous same-replica
  path, self-originated echoes are dropped (no double-fire), and an unset/failed
  Redis is byte-identical to single-replica behavior.
- **LLM quotas** follow in U3c, behind the same `REDIS_URL` gate.

## Measuring

Stand up the local pooled topology and drive load:

```bash
# enable pooled mode: set api DATABASE_URL→pgbouncer, DATABASE_DIRECT_URL→postgres
docker compose -f loadtest/docker-compose.loadtest.yml up --build -d
npx tsx loadtest/http-load.ts --url http://localhost:3000 --token "$TOKEN" \
  --max 400 --ramp 60 --hold 300
```

Compare `db_pool_connections{state="waiting"}` before/after PgBouncer; record the
new per-instance ceiling in `docs/runbooks/voice-capacity.md`.
