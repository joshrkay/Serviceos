# Voice Capacity

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

```bash
cd packages/api
STAGING_WS_URL=wss://api.staging.serviceos.com/api/telephony/stream \
  npx tsx scripts/voice-load-test.ts --max 50 --ramp 60 --hold 300
```

Inspect `voice-load-report.json` in the working directory. If p95 first-STT
> 2000 ms before reaching `--max`, lower `--max` until it stays under and
record that as the ceiling.

After a clean run, update `packages/api/.launch-quality-acks.json`:

```json
{ "voice_capacity_run": "<ISO timestamp>" }
```

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
