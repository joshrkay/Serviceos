# Phase 5 — validate at 1000 concurrent (handoff)

A self-contained runbook so a fresh Cowork session — or a teammate — can execute
the final scale-to-1000 validation **without re-deriving anything**. The code and
config (Phases 0–4) are merged-ready on PR #628 (branch
`claude/cleanup-reorganize-files-pszl4f`); only this validation run remains, and
it must run against **provisioned infrastructure** (not the dev sandbox, which
has no Docker / Redis / PgBouncer).

## What's already done (don't redo)

| Phase | Delivered |
|------|-----------|
| 0 | Load harness (`loadtest/`) + baseline rows in `voice-capacity.md` |
| 1 | DB capacity: PgBouncer two-DSN routing, RLS-safe `SET LOCAL` (U2a/U2b/U2b-2/U2c) |
| 2 | Shared state on Redis: WS caps, voice fan-out, LLM quotas, bounded caches (U3a–U3e-2) |
| 3 | Throughput: queue batch concurrency, hot-query+index, cluster-wide rate limiting (U-P3a/b/c) |
| 4 | Deploy config + graceful drain on SIGTERM (U-P4a/b/c) |

Phase 5 is **measurement only** — no app changes expected. If the run surfaces a
bottleneck, file it; don't fix it inside this validation step.

## Prerequisites (the provisioning is yours)

Stand up the target per `docs/runbooks/scaling.md` → "Provisioning & rollout":

1. `REDIS_URL` set on the API (+ `VOICE_FANOUT_ENABLED=true`).
2. PgBouncer (`pool_mode=transaction`) fronting Postgres; `DATABASE_URL` → PgBouncer,
   `DATABASE_DIRECT_URL` → direct Postgres.
3. Replicas per step 3 there: every call-answering process (every
   `PROCESS_ROLE` except `worker`) stays at **one replica** until session state
   is externalized (LCR-05), so the web service runs one replica, sized up for
   capacity, and only the worker runs `numReplicas` ≥ 2 (`railway.worker.toml`
   or its service settings; autoscale min/max set). Set `NUM_REPLICAS` to the
   real replica count on every service: the boot guard
   (`validateFeatureRequiredConfig`) refuses `NUM_REPLICAS > 1` on any role but
   `worker`, and only sees that variable.
4. Railway stop grace ≥ 35s (so `SHUTDOWN_FORCE_EXIT_MS`/drain isn't SIGKILLed).

Either run against **staging** (one web replica, N worker replicas), or stand
up the local pooled topology on a Docker host:
`loadtest/docker-compose.loadtest.yml` (flip on PgBouncer + Redis; keep one API
replica, since a live call needs the replica that answered it).

## The run

Set the target + a load-test bearer token (see `loadtest/README.md` step 2 for
minting a `DEV_AUTH_BYPASS` token on a non-prod target):

```bash
export TARGET_URL="https://<staging-or-local>"
export TOKEN="<load-test bearer>"
```

**Mixed scenario — run both drivers concurrently** (this is the point: HTTP
dashboard/API load *and* live voice/WS at the same time):

```bash
# Terminal A — HTTP/API at 1000 concurrent: ramp 120s, hold 600s
npm run loadtest:http -- --url "$TARGET_URL" --token "$TOKEN" \
  --max 1000 --ramp 120 --hold 600 --out loadtest-http-1000.json

# Terminal B — concurrent voice/WS (raise --max toward the per-instance ceiling
# of the one call-answering replica; start where the baseline left off)
cd packages/api && npx tsx scripts/voice-load-test.ts \
  --max 200 --ramp 120 --hold 600
```

Prove the tooling first if unsure: `npm run loadtest:http:selfcheck` and
`cd packages/api && npm run voice-load:selfcheck` (no app boot needed).

## Success criteria (plan R1)

- **1000 concurrent mixed users** sustained through the hold window.
- HTTP **p95 < 2s** and **error rate < 1%** (from the `http-load` JSON report).
- **Live voice calls complete normally** (voice driver reports no abnormal
  terminations; no climbing `path=voice` error tags in Sentry).
- **No saturation**: `db_pool_connections{state="waiting"}` stays ~0 and the
  queue doesn't back up (`/metrics`).

## Record the results

1. Fill the **HTTP** baseline/ceiling table in `docs/runbooks/voice-capacity.md`
   (replace the `TBD` rows): date, topology, replicas, p95, error rate, RPS,
   limiting factor.
2. Fill the **Voice** per-instance ceiling table likewise.
3. State the **sizing**: call-answering capacity grows with instance size, not
   replicas, until session state is externalized (LCR-05). Record whether one
   web replica at the measured size holds 1000 with headroom (and the size it
   needs if not), plus the worker replica count, in `voice-capacity.md`
   "Scaling guidance".
4. Attach the JSON reports to the PR / capacity report.

A documented pass against R1 + the filled tables **closes Phase 5** and the
scale-to-1000 plan.

## Kickoff prompt (paste into a fresh Cowork session)

> Resume the scale-to-1000 effort on branch
> `claude/cleanup-reorganize-files-pszl4f` (PR #628). Phases 0–4 are shipped.
> Execute **Phase 5** per `docs/runbooks/phase5-validation-handoff.md`: against
> the provisioned staging topology (Redis + PgBouncer + one web replica + N
> worker replicas), run the mixed HTTP + voice/WS load at 1000 concurrent,
> verify p95 < 2s / error < 1% / voice calls complete / no pool or queue
> saturation, then fill the `docs/runbooks/voice-capacity.md` tables and the
> sizing, and report the pass/fail against R1. Don't change app code unless the
> run surfaces a bug — if it does, file it separately. I will provide
> TARGET_URL + a load-test TOKEN.
