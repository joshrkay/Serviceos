# Runbook — silent-failure monitor (FAIL-VIS)

`packages/api/src/workers/failure-rate-monitor.ts`

## Why it exists

Every defect found in the July 2026 investigation was **silent**, and the data
to catch all of them already existed:

| What happened | What was recorded | What alerted |
| --- | --- | --- |
| `supervisor_annotate` ran 26,894 times over two days (13,808 on 23 Jul, 13,682 on 24 Jul) and completed **zero** times | every call, in `ai_runs` | nothing |
| The storm exhausted the per-tenant token budget, tripped the OpenAI circuit breaker, and took `classify_intent` down as collateral — 1,325 of 1,563 classifications failed on 23 Jul | every call, in `ai_runs` | nothing |
| Estimate executions failed for weeks with `execution_error` NULL and no audit event | the row, in `proposals` | nothing |

Nothing watched `ai_runs`. This worker does.

## What it checks

Every 10 minutes, in `PROCESS_ROLE=worker` / `all`, under the leader advisory
lock `SWEEP_LOCK.failureMonitor = 590025`.

### 1. `ai_task_failure_rate:<task_type>` — critical

Non-completion rate per `task_type` over the trailing `FAILURE_MONITOR_WINDOW_MIN`
minutes, offset back by `FAILURE_MONITOR_SETTLE_MIN`:

```
rate = (total - completed) / total
```

**Not** `failed / total`. The supervisor_annotate storm would have been invisible
to a failed/total ratio — those runs never reached a terminal state at all, they
just never completed. Measuring non-completion catches both shapes, and the
alert details carry the `failed` / `unresolved` breakdown so you know which one
you have.

The settle offset is what makes that safe: runs newer than
`FAILURE_MONITOR_SETTLE_MIN` are outside the window entirely, so a run that is
legitimately still in flight can never be counted as stuck. Gateway deadlines
are seconds; 5 minutes is a wide margin.

Breaches above `FAILURE_MONITOR_RATE_MAX`, and **only** when the window holds at
least `FAILURE_MONITOR_MIN_RUNS` runs for that task type. The volume floor is
checked before the rate, so a 1-of-1 failure can never reach the alert path.

### 2. `proposal_execution_stalled` — critical

Proposals in `executing` with `updated_at` older than
`FAILURE_MONITOR_PROPOSAL_STALE_MIN`. Execution is a queued job that finishes in
seconds; a stuck row means the handler died mid-flight and nothing will ever
move it. Any stale row breaches.

### 3. `proposal_execution_failed_silently` — warning

Proposals at `execution_failed` with `execution_error IS NULL`, updated within
`FAILURE_MONITOR_PROPOSAL_LOOKBACK_HOURS`. This is the exact signature that hid
the estimate bug: a terminal failure state carrying no reason. There is no
benign version, so one row breaches. Severity is `warning` rather than
`critical` because the work has already failed — what this page buys is the
diagnosability that was missing, not a live outage response.

## How it reaches a human

The **same `alertOperator` seam the SLO monitor uses**
(`packages/api/src/monitoring/alert-operator.ts`) — nothing new was invented:

- **Sentry** — always, `captureMessage(..., 'error')`. With the Sentry→Slack/DM
  rules in [`alerting.md`](./alerting.md) this is the durable, always-on channel.
  No-op when `SENTRY_DSN` is unset, so it is silent in dev.
- **Operator SMS** — when `ALERT_SMS_TO` is set and a delivery provider is
  wired, `recipientClass: 'owner'` so it bypasses the consent/DNC gate.

Both monitors share one `alertOperator` instance, so they also share its
per-rule cooldown (`SLO_ALERT_COOLDOWN_MIN`, default 60 min). The task-failure
rule keys its cooldown **per task type**
(`ai_task_failure_rate:supervisor_annotate`), so one noisy task cannot mask
another.

## Why it cannot become the incident

1. **It never calls the LLM gateway.** Its dependency surface is three data
   functions and an alert function; the module imports only
   `logging/logger`, `monitoring/metrics`, `monitoring/alert-operator`. A test
   asserts that import list exactly and that there is no dynamic `import(` /
   `require(` escape hatch.
2. **Cheap and bounded.** Aggregates only, over a bounded window, on indexes
   added specifically for these predicates (migration
   `263_failure_monitor_indexes`): an `INCLUDE` index makes the `ai_runs`
   aggregate an index-only scan, and both proposal probes hit partial indexes
   whose `WHERE` matches the query exactly (~0 rows on a healthy system). The
   only non-aggregate reads are id samples with `LIMIT 5`, issued **only** when
   a count is non-zero.
3. **It does not repeat-page.** Cooldown above, plus a hard cap of
   `FAILURE_MONITOR_MAX_TASK_ALERTS` task pages per tick (worst rate first) so a
   platform-wide outage that breaches every task type at once cannot turn the
   monitor into its own storm. Everything breached is still logged — the cap
   limits paging, never visibility.
4. **Failures are contained.** Each rule is individually failure-soft, and
   `runFailureRateMonitor` never rejects: reads, the alert channel, the metrics
   registry, and even a throwing logger are all caught. app.ts additionally
   `.catch()`es and holds an in-flight guard so ticks cannot stack.

## When you get paged

**`ai_task_failure_rate:<task>` with `completed=0` and a large `unresolved`** —
the supervisor_annotate shape. Something creates `ai_runs` rows and never
resolves them. Look for a caller that writes a run and then returns/throws
before `updateStatus`. Check whether the volume is also burning token budget:

```sql
SELECT task_type, status, COUNT(*)
FROM ai_runs
WHERE created_at > NOW() - INTERVAL '1 hour'
GROUP BY 1, 2 ORDER BY 3 DESC;
```

**`ai_task_failure_rate:classify_intent` (or another product path) with a large
`failed`** — check `error_message` for circuit-breaker / budget-exhaustion
strings. If another task type is also breaching at higher volume, that one is
probably the cause and this one is collateral; fix the noisy one first.

**`proposal_execution_stalled`** — the sample ids are in the alert details.
Check the execution worker is alive and the queue is draining
(`queue_staleness` in [`slo-alerts.md`](./slo-alerts.md) covers the queue side).

**`proposal_execution_failed_silently`** — the bug is *also* that the code path
set a terminal failure without recording a reason. Fix the missing
`execution_error` write, not just the underlying failure.

## Tuning

All knobs are env vars with defaults (`packages/api/src/shared/config.ts`,
documented in `.env.production.example`). Raise `FAILURE_MONITOR_MIN_RUNS` if a
low-traffic task pages on small denominators; raise `FAILURE_MONITOR_RATE_MAX`
only with a recorded reason — healthy task types sit near 0, and the incidents
this exists for were 0.85 and 1.00.
