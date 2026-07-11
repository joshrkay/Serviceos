# SLO Alerts (platform SLO monitor)

This runbook covers the platform SLO monitor (WS15 — operational resilience):
what each rule measures, its threshold env var, what a breach means, and the
first-response steps. Companion to `docs/runbooks/alerting.md` (Sentry→Slack
routing) — that pipeline is how these alerts reach a human.

## How alerting works

The monitor (`packages/api/src/workers/slo-monitor.ts`) runs every 5 minutes
in `worker`/`all` roles under a Postgres advisory leader lock
(`SWEEP_LOCK.sloMonitor`), so exactly one replica evaluates and pages per
tick. On breach it calls `alertOperator`
(`packages/api/src/monitoring/alert-operator.ts`):

1. **Sentry** — always: `captureMessage(..., 'error')` with a
   `[SLO:<severity>] <rule>: <summary>` message. Requires `SENTRY_DSN`; the
   Sentry→Slack/DM rules in `docs/runbooks/alerting.md` are what turn this
   into a page.
2. **SMS** — when `ALERT_SMS_TO` (E.164) is set and a delivery provider is
   wired. Sent with `recipientClass: 'owner'`, which bypasses the consent+DNC
   gate — an operator page can never be suppressed as an unconsented
   customer send.

Per-rule cooldown: a persistent breach re-pages at most once per
`SLO_ALERT_COOLDOWN_MIN` (default 60) minutes, not every 5-minute tick. The
cooldown map is in-process; a leader handoff (deploy/restart) resets it and
can double-page once — expected, not a bug.

Every evaluation also exports to `/metrics`: `slo_rule_value{rule}` (last
value), `slo_breach_total{rule}` (breaches, pre-cooldown), and
`slo_alerts_sent_total{rule,channel}` (pages actually dispatched).

## Rules

### 1. `call_completion_rate` (critical)

| | |
|---|---|
| Measures | Completed-ish terminal outcomes / all ended voice sessions, trailing 60 min, across all tenants (`voice_sessions.outcome`) |
| Threshold | `SLO_CALL_COMPLETION_MIN` (default `0.85`) |
| Sample floor | `SLO_CALL_COMPLETION_MIN_SAMPLE` (default `5`) — below this many ended calls in the window the rule never breaches |

"Completed-ish" = `completed`, `escalated_to_human`, `callback_required` (the
AI got the call to a resolution). Counting **against** the rate:
`dropped`, `failed`, and — deliberately — `no_intent` (caller hung up without
engaging). The denominator is honest by design: callers we lose before intent
are still callers we lost. **Do not read a breach as "infra is down" by
default** — a spike of `no_intent`/`dropped` can be a bad TTS voice, a broken
greeting, or a spam-call wave, not an outage.

A breach means: over the last hour, more than 15% of ended calls did not
reach a resolution.

First response:
1. Check the outcome mix, last hour (read replica / psql):
   `SELECT outcome, COUNT(*) FROM voice_sessions WHERE ended_at > NOW() - interval '1 hour' GROUP BY 1;`
2. `failed` dominant → infra: check Sentry for `tags["path"] = "voice"`
   errors, the realtime health circuit, and Twilio's status page. Consider the
   realtime kill switch (`TWILIO_MEDIA_STREAMS_ENABLED=false` → Gather
   fallback, see `docs/runbooks/voice-realtime-rollout.md`).
3. `dropped`/`no_intent` dominant → experience: listen to 2–3 recent
   recordings; check for a TTS/greeting regression in the latest deploy;
   check for a burst of short spam calls from one number.
4. `escalated_to_human` dominant → the rate is technically "completed-ish";
   if it still breached, volume of `failed`+`dropped` is the real signal.

### 2. `queue_staleness` (critical)

| | |
|---|---|
| Measures | Pending `_queue_messages` rows older than the window (by `created_at`, including rows mid-retry-backoff) |
| Threshold | `SLO_QUEUE_STALE_MIN` (default `15` minutes); ANY stale job is a breach |

The queue poll loop drains every second, so a 15-minute-old pending job means
the queue is **stuck**: the worker service is down/wedged, a handler hangs, or
a poison message is burning retries. Distinct from raw depth
(`pg_queue_depth`, which a healthy burst also raises).

First response:
1. Is the worker service up? (Railway: worker service status / recent deploy;
   single-service deploys: the API service, `PROCESS_ROLE` unset.)
2. What's stuck:
   `SELECT type, COUNT(*), MIN(created_at) FROM _queue_messages GROUP BY 1 ORDER BY 3;`
3. One `type` dominant → check `_queue_dlq` for the same type (poison
   message pattern) and Sentry for that handler's errors.
4. Everything old across types → the poll loop is dead: restart the worker
   service; check its logs for a crash loop.

### 3. `sweep_lag` (warning)

| | |
|---|---|
| Measures | Age of the queue-depth sampler's last recorded success (the sampler ticks every 15s in every role) — the liveness canary for the leader-sweep machinery |
| Threshold | `SLO_SWEEP_LAG_MIN` (default `15` minutes) |

A breach means the leader-locked sweep machinery in THIS process hasn't
completed even its cheapest sweep in 15+ minutes: the DB (or the direct,
non-PgBouncer pool that holds advisory locks) is unreachable, or the event
loop is starved.

**Known false-positive (verify before acting):** the heartbeat registry is
in-process (`packages/api/src/monitoring/sweep-heartbeats.ts`). On a
multi-replica worker deploy, the replica evaluating the monitor may not be the
replica that last won the sampler's leader lock, so its local heartbeat can be
stale while the platform is healthy. Current prod is single-replica, where
the signal is exact.

First response:
1. Verify: is `pg_queue_depth` on `/metrics` still updating (scrape twice,
   30s apart)? Updating → likely the multi-replica false positive above; no
   action beyond noting it.
2. Not updating → check DB health and the `DATABASE_DIRECT_URL` pool
   specifically (advisory locks need the direct/session pool; see
   `db_pool_connections{pool="direct"}`).
3. Check worker logs for repeated sweep failures ("... sweep failed") and
   event-loop lag in the default prom-client metrics.

### Drain abandonment (critical — shutdown path, not an interval rule)

| | |
|---|---|
| Signal | Sentry error `[SLO:critical] drain_abandonment: ...` with the live-call count + Twilio callSids; Prometheus `voice_drain_abandoned_calls_total` (usually unscraped — it increments moments before process exit) |
| Emitted by | `runShutdown` in `packages/api/src/app.ts` when the `DRAIN_TIMEOUT_MS` (default 25s) drain window expires with live voice sessions remaining |

A drain abandonment means a deploy/restart **hung up on real callers**:
teardown proceeded with calls still live and Twilio ended them.

First response:
1. Match the callSids from the Sentry event to Twilio call logs; confirm how
   many real customers were cut off (vs. test calls).
2. One-off during a deploy that landed mid-call → expected cost of a deploy
   during traffic; consider deploying in a quieter window.
3. Recurring on every deploy → calls are outliving the drain window: check
   average call duration vs. `DRAIN_TIMEOUT_MS`, and raise it (it must stay
   below index.ts's 30s force-exit and Railway's stop grace period — raise
   those together, see `docs/deployment.md`).
4. Check `docs/runbooks/voice-capacity.md` if abandonments correlate with
   call-volume spikes.

## Not yet measured: voice turn latency P95

The "turn latency P95" SLO from the scorecard is **not shipped**: turn latency
(caller stops speaking → first audio of the reply) is not currently measured
anywhere in the production path — there is no histogram at the turn-processing
seam (`ai/voice-quality/audio-timings.ts` is the offline eval harness only).
Bolting timing into the live audio path was judged riskier than the gap.
Where it would go: a `voice_turn_latency_ms` prom histogram observed at the
media-streams adapter's turn boundary (STT final → first TTS chunk enqueued),
then a fourth rule in `slo-monitor.ts` reading the in-process histogram's
buckets. Until then, use the offline voice-quality eval harness and Twilio's
per-call diagnostics for latency investigations.

## Verification (staging)

1. Set `SLO_QUEUE_STALE_MIN=0.02` (≈1s) on staging, enqueue any job with the
   worker service paused → within one 5-min tick a `queue_staleness` Sentry
   event should appear and (if `ALERT_SMS_TO` is set) an SMS.
2. Confirm the cooldown: leave it breaching for a second tick — no second
   page within `SLO_ALERT_COOLDOWN_MIN`.
3. Restore the threshold; confirm `slo_rule_value{rule="queue_staleness"}`
   returns to 0 on `/metrics`.
