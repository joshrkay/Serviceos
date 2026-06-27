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
side and the local topology.

## Components

| File | What it does |
|------|--------------|
| `http-load.ts` | Concurrency load driver: ramp → hold → ramp-down, p50/p95/p99, error rate, RPS, per-endpoint breakdown, JSON report. |
| `http-load-selfcheck.ts` | Runs the driver against an in-process mock server to prove the harness works (no app boot). Mirrors `voice-load:selfcheck`. |
| `docker-compose.loadtest.yml` | Local topology — single API + real Postgres (baseline). Later phases flip on PgBouncer / Redis / replicas in place. |

## Quick start

### 0. Self-check (no app needed — proves the tooling)
```bash
npm run loadtest:http:selfcheck
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
