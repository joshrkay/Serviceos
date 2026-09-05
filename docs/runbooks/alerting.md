# Alerting Setup (Sentry → Slack)

This runbook is the source of truth for the four production alert rules backing
the §11 Launch Quality Bar (tier 1 — 10–50 self-serve customers). Rules are
configured in the Sentry UI; this file describes what they should be and how to
verify them end-to-end.

## Sentry initialization

Sentry is initialized in `packages/api/src/app.ts` at startup. Required env vars:

| Var | Notes |
|-----|-------|
| `SENTRY_DSN` | Empty → no-op client; Sentry events are silently dropped. Set in staging + production. |
| `NODE_ENV` | Controls trace sample rate (1.0 in dev/staging, 0.1 in prod). |
| `GIT_SHA` or `RAILWAY_GIT_COMMIT_SHA` | Release tag — surfaces commit context in events, makes rollback diffs visible. Optional. |

The `instrument()` wrapper (`packages/api/src/monitoring/instrumentation.ts`)
adds structured tags (`path`, `tenant_id`, `correlation_id`) to every captured
exception. The four wrapped paths are: Stripe webhook handler, execution-worker
sweep, voice-action-router, Twilio Media Streams connection handler.

## Slack integration (one-time)

1. In Sentry, go to **Settings → Integrations → Slack**. Authorize the
   `serviceos` workspace.
2. Set `#alerts` as the default channel for the Slack action.
3. For P1 rules below, add a secondary action: **Send a DM to @joshrkay**.

## Alert rules

| Rule name | Condition | Severity | Action |
|-----------|-----------|----------|--------|
| Payment webhook failure | `tags["path"] = "stripe-webhook"` AND event count ≥ 1 in 5 min | P1 | `#alerts` + DM operator |
| Proposal execution failure rate | `tags["path"] = "execution-worker"` AND event count ≥ 5 in 15 min | P1 | `#alerts` + DM operator |
| Voice agent error | `tags["path"] = "voice"` AND event count ≥ 1 in 5 min | P1 | `#alerts` + DM operator |
| Queue depth (informational) | Prometheus gauge `pg_queue_depth{queue="pending"}` > 1000 sustained 5 min | P2 | `#alerts` |

The first three are tag-filtered event-count rules — Sentry's most reliable
trigger type. The fourth (queue depth) is now backed by the `pg_queue_depth`
Prometheus gauge (labels `queue=pending|dead_letter`), sampled every 15s by a
leader-elected interval in `app.ts` and exposed on `/metrics`. This makes the
scale-to-1000 C1 SLO ("PgQueue depth < 1,000 sustained") directly observable;
alert on the `pending` series. (Watch `queue="dead_letter"` too — a climbing DLQ
signals a poison message or a broken handler.)

## End-to-end verification

After configuring each rule, fire a synthetic event in staging to confirm the
full pipeline (your code → Sentry → Slack):

1. Open a Node REPL against the staging environment with `SENTRY_DSN` set.
2. Run:
   ```typescript
   import { initSentry, setSentryClient, getSentryClient } from './packages/api/src/monitoring/sentry';
   import { instrument } from './packages/api/src/monitoring/instrumentation';
   setSentryClient(initSentry({ dsn: process.env.SENTRY_DSN!, environment: 'staging' }));
   const wrapped = instrument(async () => { throw new Error('alerting test'); }, { path: 'stripe-webhook' });
   wrapped().catch(() => {});
   ```
3. Confirm Slack `#alerts` receives a message within 60 seconds.
4. Confirm the DM lands for P1 rules.
5. Record success in `packages/api/.launch-quality-acks.json`:
   ```json
   { "alerting_runbook_verified": "<ISO timestamp>" }
   ```

Until this timestamp is set, H3 passes compile-time checks only (`instrument()` on four paths). Operators must complete the Slack verification above before opening self-serve to paying customers.

## Secrets required for `voice-smoke-real.yml`

The daily real-call workflow (Task 16) needs these GitHub Actions secrets:

- `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` — staging Twilio account.
- `TWILIO_TEST_NUMBER_FROM` — Twilio number in the staging account that places the call.
- `TWILIO_TEST_NUMBER_TO` — staging-deployed inbound number for ServiceOS.
- `STAGING_TWIML_URL` — TwiML bin URL serving `<Play>` of a canned utterance.
- `STAGING_DB_URL` — read-only Postgres URL for the staging assertion query.
- `SLACK_ALERTS_WEBHOOK` — Incoming Webhook URL for `#alerts` (on-failure notification).

## Scheduled gates → `gate-red` GitHub issue (no Slack required)

Slack is best-effort (`continue-on-error: true` on every Slack step). The
durable signal that a scheduled gate is red is a GitHub issue, opened and
closed automatically by `.github/scripts/report-gate-failure.ts`, which runs
as the last `if: always()` step of each of these workflows:

| Workflow | Issue title |
|----------|-------------|
| `voice-smoke-real.yml` | `gate-red: Voice smoke (real call, daily)` |
| `qa-matrix-gate.yml` | `gate-red: QA Matrix Gate` |
| `voice-quality-weekly-trend.yml` | `gate-red: Voice Quality Layer 2 (weekly trend)` |

Behaviour, driven by `${{ job.status }}`:

- **Red run** — if an open issue with that title and the `gate-red` label
  exists, a `Still red: <run URL>` comment is added; otherwise the issue is
  created with the label and the run URL. One issue per gate, never
  duplicates.
- **Green run** — an open matching issue gets a `Green again: <run URL>`
  comment and is closed (`state_reason: completed`). No open issue → no
  API write at all.
- **Cancelled run** — nothing is touched.

The `gate-red` label does not need to exist in advance: if issue creation is
rejected with 422 the script creates the label (colour `b60205`) and retries
once. Renaming or deleting the label is safe; it will be recreated.

Failure model: any non-2xx GitHub response, or a missing env var, prints a
`[report-gate-failure] ...` error and exits 1. The step deliberately has no
`continue-on-error`: a red gate is already red, and a green run whose
reporter cannot reach GitHub turns red so the breakage is seen (usual causes:
the workflow lost `permissions: issues: write`, or a fork/PR token). Each
workflow grants `permissions: { contents: read, issues: write }` — keep
`contents: read`, a permissions block zeroes every scope it does not list and
`actions/checkout` needs it.

Triage: an open `gate-red` issue means the gate has been red since the first
comment's run. Fix the cause and re-run the workflow (`workflow_dispatch`); the
green run closes the issue. Do not close it by hand while the gate still
fails — the next red run opens a fresh one.

Verification (plan 2026-09-05-001 U2): dispatch one gate with a required
secret deliberately blank → the issue appears; restore the secret and re-run →
the issue closes.

## Known limitations

- The queue-depth alert is deferred to tier 2 (requires emitting a metric;
  see `docs/runbooks/launch-quality-bar.md` for tier promotion).
