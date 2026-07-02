# Load-test harness (`loadtest/`)

Tooling for the **scale-to-1000-concurrent-users** plan
(`docs/plans/2026-06-27-001-feat-scale-to-1000-concurrent-users-plan.md`).

Two jobs:
1. **U1 — baseline.** Find the current per-instance ceiling and the *first*
   bottleneck before any scaling change.
2. **U6 — validate.** Re-run at 1000 concurrent (mixed HTTP + voice) after the
   scaling work and record the per-instance ceiling → replica math.

The harness is **dependency-free** (Node built-ins + `tsx`, no k6 install) so it
runs in CI and locally. The **voice** side reuses the existing harness
(`packages/api/scripts/voice-load-test.ts`); this directory adds the **HTTP**
side, the **mixed dashboard-user** harness, and the local topology.

## Components

| File | What it does |
|------|--------------|
| `http-load.ts` | Concurrency load driver: ramp → hold → ramp-down, p50/p95/p99, error rate, RPS, per-endpoint breakdown, JSON report. |
| `http-load-selfcheck.ts` | Runs the driver against an in-process mock server to prove the harness works (no app boot). Mirrors `voice-load:selfcheck`. |
| `mixed-1000.ts` | U6 mixed harness — simulates N *dashboard users* (proposals poll + held WS + dispatch/escalations SSE + presence), not a raw request firehose. See "Mixed 1000-user harness" below. |
| `mixed-1000-selfcheck.ts` | Runs the mixed harness at tiny scale (5 users, ~10 s) against an in-process stub HTTP/WS/SSE server. CI-safe: no docker, no network. |
| `docker-compose.loadtest.yml` | Local topology — single API + real Postgres (baseline). Later phases flip on PgBouncer / Redis / replicas in place. |

## Quick start

### 0. Self-check (no app needed — proves the tooling)
```bash
npm run loadtest:http:selfcheck
npm run loadtest:mixed:selfcheck
```

### 1. Stand up the local topology
```bash
docker compose -f loadtest/docker-compose.loadtest.yml up --build -d
# wait for the API to be healthy:
curl -fsS http://localhost:3000/health && echo OK
```

### 2. Mint a load-test bearer token
The API runs with `DEV_AUTH_BYPASS=true`, which accepts an **unsigned** JWT whose
body carries a `sub` claim (signature is not verified; dev-only — see
`packages/api/src/auth/dev-auth-bypass.ts`). Generate one:
```bash
TOKEN=$(node -e '
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const body = { sub: "loadtest-user", exp: Math.floor(Date.now()/1000)+3600 };
  console.log([b64({alg:"none",typ:"JWT"}), b64(body), "sig"].join("."));
')
echo "$TOKEN"
```
Each distinct `sub` bootstraps its own tenant, so vary it to spread load across
tenants (or keep one to stress a single tenant's quotas).

### 3. Drive load
```bash
npx tsx loadtest/http-load.ts \
  --url http://localhost:3000 --token "$TOKEN" \
  --max 200 --ramp 60 --hold 300 --rampdown 30 \
  --out loadtest/report.json --assert
```
`--assert` exits non-zero if p95 ≥ 2000 ms or error rate ≥ 1%.

### 4. Voice side (existing harness)
```bash
cd packages/api
npm run voice-load:selfcheck            # proves the voice harness
STAGING_WS_URL=wss://api.staging.serviceos.com/api/telephony/stream \
  npm run voice-load:staging            # real concurrency vs staging
```

## Mixed 1000-user harness (`mixed-1000.ts`, U6)

Models the measured frontend footprint instead of raw request pressure. Each
virtual user is one dashboard tab:

- `GET /api/proposals?status=ready_for_review&limit=100` every 30 s
  (the `usePendingProposals` poll);
- one **client-gateway WebSocket** held open — same handshake as
  `packages/web/src/hooks/useResilientStream.ts`: upgrade on `/api/ws` with the
  bearer token in `?token=`. A connection only counts as "connected" once the
  gateway's `hello` frame arrives (auth + registry lease succeeded);
- **20% are dispatch-board users** (`--dispatch-frac`): + one SSE stream on
  `/api/dispatch/board/events?date=…` and one `PUT /api/dispatch/presence`
  every 5 s (`--presence-interval`; set `0` to model the post-UC-3 topology
  where presence rides the WS instead of HTTP);
- **10% also hold an escalations SSE stream** (`--escalations-frac`,
  `/api/escalations/events`).

SSE auth matches the web hooks (fetch + `Authorization: Bearer …`). Dropped
WS/SSE connections reconnect after 1 s and are reported as `unexpectedCloses`.

### The 1000-user run (pooled docker-compose topology)

```bash
# 1. Pooled topology: route the API through PgBouncer (see the comments in
#    docker-compose.loadtest.yml) — override the api service env with
#      DATABASE_URL: postgres://serviceos:serviceos@pgbouncer:6432/serviceos_load
#      DATABASE_DIRECT_URL: postgres://serviceos:serviceos@postgres:5432/serviceos_load
#    and (U3/U5) enable the redis service + REDIS_URL for >1 replica.
docker compose -f loadtest/docker-compose.loadtest.yml up --build -d
curl -fsS http://localhost:3000/health && echo OK

# 2. Mint a DEV_AUTH_BYPASS token (step 2 above) → $TOKEN

# 3. Raise the fd limit — 1000 users hold ~1300 sockets + transient polls.
ulimit -n 8192

# 4. The 1000-user certification run:
npx tsx loadtest/mixed-1000.ts \
  --url http://localhost:3000 --token "$TOKEN" \
  --users 1000 --ramp 120 --hold 300 --rampdown 30 \
  --out loadtest/mixed-report.json
```

Against **staging**: same command with `--url https://api.staging.serviceos.com`
and a real Clerk test token (`--token`). Add `--presence-interval 0` to model
the post-UC-3 WS-presence topology.

### Voice slice

Two options for adding N concurrent synthetic calls to a mixed run:

1. **Integrated:** `--voice 50 --voice-url wss://…/api/telephony/stream`
   shells out to the existing `packages/api/scripts/voice-load-test.ts`
   (same ramp/hold; output prefixed `[voice]`; JSON report in
   `packages/api/voice-load-report.json`). A non-zero voice exit fails the run.
2. **Two-terminal:** run the mixed harness in one terminal and, in another,
   `cd packages/api && STAGING_WS_URL=wss://…/api/telephony/stream npx tsx
   scripts/voice-load-test.ts --max 50 --ramp 120 --hold 300` — useful when the
   voice target differs from the HTTP target (e.g. staging voice + local HTTP).

### Report & exit code

Reports per-endpoint p50/p95/p99 + error counts, WS/SSE connect success rate
and connect-latency percentiles, unexpected disconnects, and steady-state RPS
(requests completed during the hold window). The CLI **exits non-zero when the
HTTP error rate is ≥ 1% or any connection class (WS / dispatch SSE /
escalations SSE) fails > 5% of attempts** (or the voice slice exits non-zero).
Disable with `--no-assert` for exploratory runs.

**Record results** in the TBD rows of `docs/runbooks/voice-capacity.md` — the
HTTP baseline table (U1), the voice per-instance ceiling table, and the mixed
1000-user validation table (U6) — including the first bottleneck observed.

### CLI flags (`mixed-1000.ts`)

| Flag | Default | Meaning |
|------|---------|---------|
| `--url` | `http://localhost:3000` | Target API base URL (WS derives ws/wss) |
| `--token` | — | Bearer token (dev-bypass locally; real Clerk token on staging) |
| `--users` | `1000` | Peak concurrent simulated dashboard users |
| `--ramp` | `120` | Ramp-up seconds (0 → users) |
| `--hold` | `300` | Hold-at-peak seconds |
| `--rampdown` | `30` | Ramp-down seconds (users → 0) |
| `--dispatch-frac` | `0.2` | Fraction that are dispatch-board users (SSE + presence) |
| `--escalations-frac` | `0.1` | Fraction also holding an escalations SSE stream |
| `--presence-interval` | `5` | Presence PUT interval (s); `0` disables (post-UC-3 WS-presence model) |
| `--proposal-interval` | `30` | Proposals poll interval (s) |
| `--date` | today (UTC) | Dispatch-board date for SSE query + presence body |
| `--voice` | `0` | Concurrent synthetic voice calls (delegated to voice-load-test.ts) |
| `--voice-url` | env `STAGING_WS_URL` | Twilio media-stream WS URL for the voice slice |
| `--timeout` | `10000` | Per-request / per-connect timeout (ms) |
| `--out` | — | Write JSON report to this path |
| `--no-assert` | off | Don't exit non-zero on threshold failure |

## CLI flags (`http-load.ts`)

| Flag | Default | Meaning |
|------|---------|---------|
| `--url` | `http://localhost:3000` | Target API base URL |
| `--token` | — | Bearer token (see step 2; real Clerk token on staging) |
| `--max` | `100` | Peak concurrent VUs |
| `--ramp` | `60` | Ramp-up seconds (0 → max) |
| `--hold` | `300` | Hold-at-peak seconds |
| `--rampdown` | `30` | Ramp-down seconds |
| `--endpoints` | mixed reads | Comma list, e.g. `/api/jobs,/api/invoices` |
| `--allow-status` | — | Status codes that don't count as errors, e.g. `401` |
| `--timeout` | `10000` | Per-request timeout (ms) |
| `--out` | — | Write JSON report to this path |
| `--assert` | off | Exit non-zero on threshold failure |

Default endpoint mix mirrors `docs/operations/load-test-staging.md`:
`GET /api/jobs, /api/invoices, /api/customers, /api/estimates, /api/leads, /health`.

## Pass/fail thresholds (what "working" means)

| Signal | Pass |
|--------|------|
| HTTP p95 latency | < 2 s |
| Error rate | < 1% |
| DB pool waiters (API metric) | ≈ 0 (no stalls) |
| Queue backlog | flat, not growing |
| Voice calls | complete; cluster-wide caps correct |
| Memory per instance | stable |

## Capturing the baseline (U1)

Run the local topology at increasing `--max` until p95 crosses 2 s or errors
climb; that knee is the **single-instance ceiling**. Record the number and the
observed first bottleneck (expected: DB pool exhaustion — visible as
`connectionTimeout` errors in API logs / the pool saturation metric added in
U2) into `docs/runbooks/voice-capacity.md`.

> Note: the literal "1000 concurrent" certification needs the provisioned
> staging env (N replicas + Redis + PgBouncer). This harness is the artifact you
> run there; locally it establishes the per-instance curve the replica math
> builds on.
