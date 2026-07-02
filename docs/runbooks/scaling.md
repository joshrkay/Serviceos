# Scaling runbook (DB pooling + replicas)

How to scale the API past the single-instance ceiling. Companion to the
scale-to-1000 plan
(`docs/plans/2026-06-27-001-feat-scale-to-1000-concurrent-users-plan.md`) and the
capacity baseline in `docs/runbooks/voice-capacity.md`.

## Go-live checklist: ≥1000 concurrent users

Current production state (verified 2026-07-02): **one process, one replica, no
Redis, no PgBouncer, capacity tables `TBD`.** The order below matters — doing
step 3 before steps 1–2 silently multiplies every rate limit/quota by N and
exhausts Postgres connections.

1. **Provision Redis first** (Phase 4 §1 below): set `REDIS_URL` **and**
   `VOICE_FANOUT_ENABLED=true` (and `AI_CACHE_ENABLED=true` for a shared LLM
   cache). Until this is set, WS caps, LLM quotas, rate limits, and voice
   fan-out are all per-replica.
2. **Provision PgBouncer** (Phase 4 §2): `DATABASE_URL`→bouncer,
   `DATABASE_DIRECT_URL`→Postgres direct. Before enabling, confirm the known
   transaction-pinning offender is fixed: `/api/assistant/chat` must not hold
   the request transaction across the LLM call (UC-2 in
   `docs/plans/2026-07-02-001-feat-rivet-jobber-agent-wave-plan.md`).
3. **Raise replicas** (Phase 4 §3) with stop grace ≥ 35s (Phase 4 §4).
   Multi-replica correctness prerequisites, tracked in the same plan:
   dispatch-board event bus/presence/revision externalized (UC-3/UC-4) and
   telephony timers made durable (UC-5 — the in-memory emergency page retry
   ladder is the highest-risk item: a deploy can drop an emergency escalation).
4. **Measure before claiming the number** (Phase 5 / "Measuring" below): run
   the mixed 1000-user harness (`loadtest/mixed-1000.js`, UC-6) against the
   pooled topology and replace the `TBD` rows in
   `docs/runbooks/voice-capacity.md` with real ceilings. Frontend load model
   for the harness: each dashboard user ≈ 2 req/min baseline
   (`usePendingProposals` 30s) + 1 WS + up to 2 SSE; dispatch-board users add a
   presence heartbeat (12 req/min until UC-3 moves it onto the WS).

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
  > ⚠️ **Known offender — `/api/assistant/chat`.** `withTenantTransaction` is
  > mounted before the protected `/api` routes, and the assistant handler
  > `await`s `generateAssistantReply()` (the LLM call) *inside* that request
  > transaction, so each concurrent chat pins a PgBouncer server backend for the
  > whole call. At `default_pool_size=25`, ~25 slow chats can stall unrelated
  > API traffic. Move the LLM call outside the request transaction (or bracket
  > only its DB sections) before enabling the PgBouncer topology. Tracked in
  > `docs/runbooks/scale-review-followups.md`. (Codex P2.)
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
- **Dispatch presence** (UC-3): the dispatch-board presence store moves to Redis
  when `REDIS_URL` is set (one hash per tenant+board-date, per-entry expiry
  lease), so "who's viewing/dragging" is consistent across replicas. Fails open
  to a per-replica in-memory store on a Redis error; byte-identical in-memory
  behavior when `REDIS_URL` is unset. The heartbeat itself rides the client WS
  gateway (`presence.update` frames) with a ≥30s HTTP PUT fallback — not the
  old 5s PUT-per-user amplifier.
- **Dispatch board fan-out** (UC-4): `board_updated`/`presence_updated` events
  and board revision tokens mirror across replicas over Redis pub/sub
  (mirroring the U3d voice fan-out: additive, best-effort, self-echo dropped).
  Double-gated — set `REDIS_URL` **and** `DISPATCH_FANOUT_ENABLED=true`.
  Revision tokens become totally ordered (`ts.seq.replicaId`) and merge
  max-wins so concurrent bumps on two replicas converge with no refetch
  flapping; unset/failed Redis keeps today's process-local bus + UUID tokens.
- **LLM per-tenant quotas** (U3c): the concurrency semaphore + token bucket move
  to Redis when `REDIS_URL` is set, so per-tenant fairness caps hold cluster-wide
  instead of per-replica. A single atomic Lua (purge → concurrency → refill →
  token-budget → hard-bound → reserve) prevents the lost-update race; the clock is
  Redis `TIME`. Concurrency slots carry a lease-TTL so a crashed replica's
  in-flight slots self-expire; the token bucket self-heals via refill (no reclaim
  needed). Same fail-open-to-local stance as the WS cap. No call-site change — the
  gateway factory swaps the store in asynchronously.

## Throughput (Phase 3)

- **Hot query** (U-P3a): the supervisor-review sweep now reads a 24h window
  (`findByStatusSince`) backed by `idx_proposals_status_created`
  `(tenant_id, status, created_at DESC)` instead of loading every
  `ready_for_review` proposal and filtering by time in memory.
- **Queue concurrency** (U-P3b): the poll loop claims `QUEUE_POLL_BATCH_SIZE`
  (default 10) messages per 250ms tick and processes them concurrently, lifting
  the per-process ceiling from ~4 msg/s to ~batch×4/s. `FOR UPDATE SKIP LOCKED`
  keeps concurrent ticks/replicas on disjoint sets, so total throughput also
  scales with replica count.
- **Rate limiting** (U-P3c): the per-IP `/api`, `/webhooks`, `/public` limiters
  and a per-tenant `/api` limiter (`API_TENANT_RATE_LIMIT_MAX`/min, keyed by
  `tenantId`) share counters via Redis when `REDIS_URL` is set, so a limit is
  cluster-wide rather than per-replica (else N replicas = N× the limit). Atomic
  INCR + first-hit PEXPIRE; fail-open-to-local (per-replica MemoryStore) on a
  Redis error; byte-identical to the prior in-memory limiters when `REDIS_URL`
  is unset.

## Provisioning & rollout (Phase 4)

Code/config are in the repo; these steps are applied in the Railway account.

1. **Redis** — add a Railway Redis plugin and set `REDIS_URL` on the API service.
   This is the switch that makes the WS caps, LLM quotas, voice fan-out, dispatch
   presence, and rate limits cluster-wide. Also set `VOICE_FANOUT_ENABLED=true`
   for multi-replica voice and `DISPATCH_FANOUT_ENABLED=true` for multi-replica
   dispatch boards (UC-4). Without `REDIS_URL`, every shared store stays
   per-replica — so set it **before** raising `numReplicas`.
2. **PgBouncer** — add a PgBouncer service (`pool_mode=transaction`) in front of
   the Postgres plugin. Point the API's `DATABASE_URL` at PgBouncer and
   `DATABASE_DIRECT_URL` at the Postgres plugin's direct URL (session-scoped
   advisory locks + LISTEN/NOTIFY bypass PgBouncer — see U2a). Size
   `DB_MAX_CONNECTIONS` per replica and PgBouncer's `DEFAULT_POOL_SIZE` against
   Postgres `max_connections`.
3. **Replicas + autoscale** — raise `numReplicas` in `railway.toml` (or the
   service settings). Configure metric-based autoscaling (CPU/memory/request
   triggers, min/max replicas) in the Railway service settings — there is no
   `railway.toml` key for it. Set the **min** from the steady load and the
   **max** from the Phase 5 per-instance ceiling.
4. **Graceful drain** — ensure Railway's stop grace period exceeds
   `SHUTDOWN_FORCE_EXIT_MS` (default 30s) so a draining replica can finish live
   calls. The app flips `/ready` → 503 and rejects new WS upgrades on SIGTERM,
   waits `DRAIN_TIMEOUT_MS` (25s) for active voice sessions, then tears down. The
   `overlapSeconds = 35` in `railway.toml` keeps the old replica serving during a
   rolling deploy until the new one is healthy.

### CDN (static assets)

The web image (`packages/web/nginx.conf`) already emits CDN-correct cache
headers: content-hashed `/assets/*` are `public, max-age=31536000, immutable`
(safe to cache forever — a redeploy emits new filenames), while `index.html` and
`env.js` are `no-cache` (revalidate so a deploy's new asset hashes load at once).
To put Cloudflare (or any CDN) in front of the Railway web edge:

- Proxy the web hostname through the CDN; origin = the Railway web service.
- Respect origin `Cache-Control` (don't override) so `/assets/*` cache at the
  edge and `index.html`/`env.js` revalidate.
- **Bypass the cache for `/api/*` and WebSocket upgrades** (the gateway +
  `/voice/twilio` media streams) — dynamic + per-tenant, never cacheable.
- Keep `X-Forwarded-For` intact (the API has `trust proxy` set) so per-IP rate
  limits and `req.ip` resolve to the real client.

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
