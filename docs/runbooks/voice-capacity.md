# Capacity

Per-instance ceilings for the two load paths — HTTP/API and concurrent Twilio
Media Streams voice — feeding the replica math in the scale-to-1000 plan
(`docs/plans/2026-06-27-001-feat-scale-to-1000-concurrent-users-plan.md`).

## HTTP / API capacity baseline (scale-to-1000 U1)

Driven by the dependency-free harness in `loadtest/` (see `loadtest/README.md`).
"Max concurrent" is the highest VU count at which HTTP **p95 < 2000 ms** AND
**error rate < 1%** over a 5-minute hold.

| Run date | Target | DB pool (`DB_MAX_CONNECTIONS`) | Max concurrent VUs | p95 (ms) | First bottleneck | Notes |
|----------|--------|-------------------------------|--------------------|----------|------------------|-------|
| TBD      | local compose | 20 (shipping default) |        |          | expected: DB pool exhaustion | baseline before any change |

Fill this row by running the local topology and ramping `--max` until the knee:

```bash
docker compose -f loadtest/docker-compose.loadtest.yml up --build -d
# mint a DEV_AUTH_BYPASS token (loadtest/README.md step 2) → $TOKEN
npx tsx loadtest/http-load.ts --url http://localhost:3000 --token "$TOKEN" \
  --max 200 --ramp 60 --hold 300 --rampdown 30 --out loadtest/report.json
```

The expected first bottleneck is the DB connection pool (default `max:20`,
held per-request by the RLS middleware) — visible as `connectionTimeout`
errors in API logs and, after U2, the pool-saturation metric. Re-run after each
scaling phase and add a row; the multi-replica curve (U5) multiplies this
per-instance number.

Harness health (no app boot, proves the tooling): `npm run loadtest:http:selfcheck`.

## Voice capacity

Per-instance ceiling for concurrent Twilio Media Streams calls, derived from
running the §11 H5 voice load test against staging.

## Per-instance ceiling

| Run date | Voice provider | Instance size | Max concurrent | p95 first-STT (ms) | Notes |
|----------|----------------|---------------|----------------|--------------------|-------|
| TBD      |                |               |                |                    |       |

Fill this row after running `packages/api/scripts/voice-load-test.ts` against
staging (see "How to run" below). "Max concurrent" is the highest connection
count at which p95 first-STT latency stayed under 2000 ms AND zero connections
dropped during the 5-minute hold.

## How to run

### Production capacity measurement (required before customer cutover)

```bash
cd packages/api
STAGING_WS_URL=wss://api.staging.serviceos.com/api/telephony/stream \
  npm run voice-load:staging
```

Inspect `voice-load-report.json` in the working directory. If p95 first-STT
> 2000 ms before reaching `--max`, lower `--max` until it stays under and
record that as the ceiling.

After a clean run, update `packages/api/.launch-quality-acks.json`:

```json
{ "voice_capacity_run": "<ISO timestamp>" }
```

### Harness self-check (closes H5 quality gate without staging)

```bash
cd packages/api
npm run voice-load:selfcheck
```

Spins up a local mock WebSocket server, runs `voice-load-test.ts` against
it with small parameters (3 conns, 5s hold), and auto-stamps
`.launch-quality-acks.json` with `voice_capacity_provenance: "harness-self-check"`.
Confirms the harness, report-generation, and acks pipeline are operational
but does NOT measure production capacity — re-run the staging command
above before opening self-serve.

## Scaling guidance

- A single Railway instance handles up to the ceiling above.
- Scale horizontally via `railway scale --service api --replicas N`.
- Each instance is independent; Twilio's WebSocket load balancer distributes
  new connections across replicas.
- Concurrent-call count per instance can be monitored via Sentry tag
  `path=voice` event counts (climbing tag volume signals approach to ceiling).

## When to re-run

- Voice provider changes (LLM, STT, TTS).
- Railway instance size changes (CPU/RAM tier).
- After any change in `packages/api/src/telephony/media-streams/`.
- Every 90 days as a freshness check.
- When customer traffic approaches the documented ceiling (read in Sentry).

## Tier-2 escalation

If sustained traffic exceeds the per-instance ceiling, the launch-quality bar
auto-rolls into tier 2: voice load test moves into CI to track regressions on
every PR. See `launch-quality-bar.md` for the promotion criteria.
