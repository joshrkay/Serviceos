# fix: Top 5 production issues — remediation plan

**Created:** 2026-09-05
**Depth:** Deep
**Status:** plan

## Summary

An audit of production signals on 2026-09-05 (open issues, the 2026-08-27
prod QA sweep #872, the shipgate deferred queue, PostHog, GitHub Actions
history, and a code re-verification of every deferred defect) ranks five
issues that are hurting or endangering production today. This plan fixes
each one: make production observable and its verification gates real,
unblock the live tenant's billing and phone line, bound and account
per-call voice spend, stop corrupting and losing call transcripts, and
remove the migration pattern that has already bricked three deploys.

## Problem Frame

Rivet is deployed on Railway with one real tenant (Rivet HVAC). The
audit found that the team cannot currently see what production is doing,
that the only real tenant cannot manage billing or receive calls, and
that several money-shaped defects in the voice path are still live in
code although they were catalogued weeks ago. Each issue below carries
the evidence that ranked it.

### Issue 1 — Production is unobservable and its automated gates are dead

- PostHog error tracking has **zero issues ever recorded**; no
  `$exception`, `$pageview`, `$autocapture` or `$identify` event has ever
  reached the project. Only `posthog-node` server events exist.
- Of ~1,850 server events in the last 14 days, 1,837 came from the QA
  sweep tenant (`a948cc66…`). A second tenant produced 8 events from 2
  people. Production customer activity is effectively unobserved.
- Sentry is initialised (`packages/api/src/app.ts:535`) but
  `captureException` is **not** wired to the global Express error
  handler (`app.ts:6978`); only four `instrument()`-wrapped paths report
  (`packages/api/src/monitoring/instrumentation.ts:40`). Whether
  `SENTRY_DSN`, `POSTHOG_API_KEY` and `VITE_POSTHOG_KEY` are set on prod
  was never confirmed (brief item B1 in
  `docs/verification-runs/live-deploy-verification-2026-08-05.md`).
- Three scheduled production-facing gates fail at their first step
  because the repository's GitHub Actions secrets are empty:
  `voice-smoke-real.yml` (daily, 3+ consecutive failures: all six
  Twilio/staging secrets empty), `qa-matrix-gate.yml` (daily, secrets
  check fails, every test step skipped), and
  `voice-quality-weekly-trend.yml` (five consecutive Monday failures;
  `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` empty, suite exits in 4 s).
  `SLACK_WEBHOOK_URL` is also empty, so the failure notifications
  themselves fail. Nobody is paged.

### Issue 2 — The live tenant can be neither billed nor phoned

- #906: Rivet HVAC's saved Stripe customer `cus_UswJPdKUh7f1eg` no
  longer exists; `POST /api/billing/portal-session` fails and the
  subscription is unmanageable in-app (QA sweep #872 blocker 2). PR #904
  shipped the machine-readable error and re-link guidance UI; the
  re-link itself is still open.
- #905: the tenant's telephony was provisioned with Twilio **test**
  credentials (`stub: true`, magic number `+1 500 555 0006`); there is no
  real inbound line, which also blocks the witnessed prod phone-call
  verification (B4). PR #904 stopped magic numbers from rendering or
  persisting; claiming a real number is still open.
- `TWILIO_BUSINESS_NAME` is unset in prod (greeting says "our team").

### Issue 3 — Per-call voice spend is unbounded and under-counted

- C-4 (deferred queue): `packages/api/src/telephony/media-streams/mediastream-adapter.ts`
  has only the 30-minute idle timer, re-armed on every media frame
  (`handleMedia` → `armIdleTimer`, `:1544`, `:3097`). Twilio sends
  comfort-noise frames continuously, so the timer can never fire on a
  live call (the code's own comment at `:3112-3117` says so). No
  wall-clock cap exists anywhere; `SessionCostTracker.checkDuration()`
  (`packages/api/src/ai/skills/session-cost-tracker.ts:157`) has no
  callers. An engaged or looping caller bills Deepgram + LLM +
  ElevenLabs + Twilio indefinitely.
- #895: `vulnerability-grader.ts` and `sentiment-classifier.ts` gate on
  `costTracker.totals.costCents` but never `recordUsage`; their LLM dep
  returns only `{ text }`, so the tokens they spend are structurally
  invisible to the per-session cap.
- #913: `packages/api/src/routes/assistant.ts` hard-codes
  `usage: { input: 0, output: 0, total: 0 }` at seven response builders
  (`:2106, 2213, 2428, 2440, 2549, 2593, 2647`) after a real classifier
  call; only the direct-chat path (`:2807`) forwards `tokenUsage`.

### Issue 4 — Voice transcripts are duplicated and, on restart, lost

- #859: on the media-streams path every caller utterance is appended
  twice — `twilio-adapter.ts:1913-1919` inside `processCallerUtterance`,
  then again in `create-voice-turn-processor.ts:4183-4187` inside
  `speechTurn`. The #962 guard (`:4179-4182`) only skips the second
  append on surfaces that serve the silence ladder there; media-streams
  keeps the unconditional append. Summaries, digests, `deriveCallOutcome`
  and prior-turn prompts all consume the duplicated transcript.
- C-5 (deferred queue): `app.ts:3864-3872` returns silently when the
  recording webhook arrives after the in-memory session is gone (deploy,
  restart, or 30-minute reap). Transcript turns are written to the DB
  only at the end, by `transcript-ingestion-worker.ts:186-200`, from the
  in-memory array. Every deploy drops the transcripts of calls in flight;
  audio survives in storage but is never re-transcribed.

### Issue 5 — Replay-every-boot migrations with bare CHECK constraints brick deploys

- #923: the migration runner (`packages/api/src/db/migrate.ts:142-148`)
  has no applied-migrations ledger; it concatenates every migration and
  rewrites `ADD CONSTRAINT` into `DROP CONSTRAINT IF EXISTS` + `ADD`
  (`schema.ts:6692-6695`). Every CHECK constraint is therefore dropped
  and fully re-validated against its whole table on every deploy, using
  that migration's (possibly stale) vocabulary. 26 of 33 `CHECK`
  constraints lack `NOT VALID` (`schema.ts` lines 984, 1914, 1960, 1979,
  2068, 2109, 2420, 2446, 2450, 3474, 3920, 4119, 4241, 4277, 4334, 4375,
  4392, 4550, 4561, 4734, 4752, 4804, 4827, 5144, 5532, 6528). This
  pattern already bricked deploys three times on
  `message_dispatches_entity_type_check`; only that constraint has a
  vocabulary-pin test (`packages/api/test/db/dispatch-entity-type-vocabulary.test.ts`).
  All 26 are dropped and re-added on every boot (21 by an explicit
  `DROP CONSTRAINT IF EXISTS`, 5 by the rewriter's injected one), so
  each runs a full validating scan per deploy whether or not it was
  ever widened, and the whole corpus shares one
  `statement_timeout = '25s'` (`migrate.ts:147`). Four of them are
  stale-narrower copies that already reject values production code
  writes (`leads_source_check` at `:1914` lacks `'sms'`,
  `proposals_status_check` at `:984` lacks `'executing'`,
  `proposal_sms_events_kind_check` at `:4119` and `:4277` lack two
  kinds), so one such row in prod bricks every subsequent deploy today.

## Requirements

- R1. Every unhandled 5xx in the API reaches Sentry with tenant, route
  and request-id tags and the existing redaction, when `SENTRY_DSN` is
  set.
- R2. `SENTRY_DSN`, `POSTHOG_API_KEY` and `VITE_POSTHOG_KEY` are set on
  the prod services and their presence is verifiable from the running
  app; the prod env checklist lists all three.
- R3. The three scheduled gates run to completion (secrets present) and
  a red gate is visible in GitHub (an auto-managed issue) even when
  Slack is unconfigured.
- R4. Rivet HVAC has a working Stripe customer link and a real inbound
  Twilio number; a real inbound call produces a proposal in prod (B4).
- R5. A media-streams call ends within a configurable absolute duration
  with a spoken wrap-up; the Gather path enforces the same cap per turn.
- R6. Every LLM call on the voice path records its usage into the
  session cost tracker, and assistant API responses report real usage.
- R7. A caller utterance appears exactly once in the transcript on every
  transport.
- R8. Transcript turns survive a process restart; the recording webhook
  never silently drops a transcript.
- R9. No `ADD CONSTRAINT … CHECK` in `schema.ts` lacks `NOT VALID`, a
  schema-wide test pins that, and the widened constraints carry a
  vocabulary-pin test.
- R10. When Langfuse keys are set, every gateway completion is exported
  as a redacted, tenant-tagged trace grouped by session; when they are
  not set, nothing is exported and no network call is made.

## Key Technical Decisions

- **Capture 5xx at the global error handler, not per route** — one seam
  covers every route; `instrument()` stays for the four critical paths
  that need transaction context. (Alternative: expand `instrument()`
  call sites; rejected as unbounded and easy to miss.)
- **Gate failures open/refresh a GitHub issue** — Slack is empty and the
  weekly trend script already knows how to open issues
  (`.github/scripts/voice-quality-trend-report.ts --open-issue`). One
  shared step reused by all three workflows. (Alternative: rely on
  Slack; rejected because the webhook is unset and a red scheduled job
  is invisible on GitHub's home page.)
- **Web analytics is an ops variable, not code** — `VITE_*` values are
  inlined at Vite build time and Railway exposes service variables to
  the build (this is how `VITE_CLERK_PUBLISHABLE_KEY` already works).
  `packages/web/public/env.js` stays static.
- **Stripe re-link is a runbook, not an endpoint** — #906 pins that
  auto-recreate is forbidden; a one-off SQL + Dashboard runbook
  unblocks the tenant now, and the owner-approved recreate path stays a
  product decision.
- **Absolute call timer armed once at session start** — independent of
  media frames; `handleClose('max_call_duration')` after a spoken
  wrap-up. Delete the dead `checkDuration()` rather than wire it: the
  timer is the enforcement, not an advisory check.
- **Widen the grader/classifier LLM dep to return usage** — the gateway
  already returns `tokenUsage`; the two modules narrowed it away.
  (Alternative: estimate tokens from text length; rejected because it
  fakes accounting.)
- **`processCallerUtterance` owns the transcript append** — it is the
  first site on every phone transport; `speechTurn` appends only when
  called directly (the `mediastream-adapter.ts:1666` path) via an
  explicit `transcriptAppended` input flag rather than surface
  detection. (Alternative: dedupe in `appendTranscript`; rejected
  because a legitimately repeated utterance must still record.)
- **Persist transcript turns incrementally, keyed on (call_sid,
  turn_index) and attached to the recording later** — the
  `call_transcript_turns` table is keyed on `voice_recording_id` today,
  which only exists after the recording webhook, so the call SID is the
  only key available mid-call; cheap, tenant-scoped, idempotent, and the
  recording webhook can rebuild from it. (Alternative: re-transcribe from storage;
  rejected as a second STT spend for data the process already had.)
- **`NOT VALID` on every CHECK, pinned schema-wide** — new rows are
  still checked; only the whole-table re-validation on every boot is
  skipped. The runner-level fix (skip re-adding a constraint whose
  `pg_get_constraintdef` is unchanged) is the durable root-cause fix and
  is deferred to its own plan because it changes every deploy's
  behaviour.
- **No `VALIDATE CONSTRAINT` follow-up** — with no migration ledger a
  bare `VALIDATE` in the corpus would re-scan on every boot, restoring
  the cost R9 removes, and the preceding replay re-adds each constraint
  `NOT VALID` anyway so validation could never stick. Permanently
  `NOT VALID` is acceptable here because every constrained value is
  produced by a TS union, not user input; real validation needs a
  ledger, which is its own plan. (Grep confirms no `VALIDATE
  CONSTRAINT` exists anywhere in the repo today.)
- **Persisted transcript rows are authoritative for ingestion** — once
  U8 persists turns mid-call, the recording webhook builds the
  ingestion payload from those rows (attached and renumbered) rather
  than from the in-memory session, and the worker upserts by the
  carried index. The alternative, letting the worker keep numbering
  from its own loop, silently overwrites the wrong turns whenever a
  turn parses empty or a second session leg exists for the same call.
- **Langfuse as a second sink behind the existing gateway seam, not a
  replacement for `ai_runs`** — the gateway already builds a redacted
  input snapshot, computes cost and carries `correlationId` and
  `promptVersionId`, so export is one best-effort call on each path.
  `ai_runs` stays the tenant-scoped system of record (it feeds
  `proposals.ai_run_id`); Langfuse is for opening a session's calls as
  one trace and for prompt-version and eval workflows. Content export is
  off by default because voice traces contain caller transcripts, and
  the base URL is configurable so a self-hosted instance can be used.
  (Alternatives considered: PostHog `$ai_generation`, rejected for now
  because it lacks prompt management and dataset evals, though the same
  exporter interface can feed it later; LangSmith, rejected because the
  platform is closed and self-hosting is enterprise-only, and the repo
  has no LangChain dependency to justify it.)

## Scope Boundaries

**In scope:** the ten units below, the prod env checklist and the two
ops runbooks they reference.

**Non-goals:** the JSON-404 for unmatched `/api/*` (C-1), Stripe request
timeouts on the nine untimed calls (C-2), the 30 route files still
lacking the shared malformed-id guard (#882 remainder), classifier
prompt-injection fencing (#894), Layer 1 eval blindness (#888), and the
voice-first build sequence (#852/#962). These are real and are listed
below so they are not lost; they are not among the five.

### Deferred to follow-up work
- Migration runner: compare constraint definitions before drop/re-add
  (root cause of Issue 5), or a real applied-migrations ledger.
- Non-CHECK constraints rebuilt on every boot by the same rewriter:
  `no_double_booking` (GiST EXCLUDE, `schema.ts:3406-3408`),
  `service_credits_review_id_fkey` (`:2768`) and seven UNIQUE
  constraints (`:4665, :4693, :4713, :5550, :5581, :5599, :5706`). Each
  is a full index build inside the same 25-second budget, and dropping
  `no_double_booking` briefly removes the double-booking guard that
  `verifyCriticalConstraints` polices. `NOT VALID` does not apply to
  these; they need the runner fix above.
- `transcript-ingestion-worker.ts:191` mis-indexes `transcript[i]`
  after a filtered turn; fixed incidentally by U8's payload change.
- C-1 JSON 404 middleware for `/api/*` before the SPA catch-all.
- C-2: wire `deps.stripeFetch` in `app.ts` with the `timedFetch` pattern
  from `stripe-payment-link.ts`.
- #882: adopt `notFoundOnMalformedId` in the remaining 30 route files.
- #894: route the classifier transcript through `fenceUntrusted`.
- #906 product decision: owner-approved Stripe customer recreate.
- Environment property on PostHog events so prod/dev/local can be told
  apart (noted in `docs/PRD-v4-part-E-state.md`).

## Repository invariants touched

- **Audit events:** U5's max-duration close persists its terminal
  reason through the same finalize path every existing close reason
  uses (no close reason emits a separate audit today, and this unit
  follows them). U8 emits `voice.transcript_unrecoverable` on the one
  new failure branch; the persisted turns themselves are captured data
  keyed to the audited call, not a new mutation class.
- **tenant_id + RLS:** the new transcript-turn writes in U8 go through
  the existing tenant-scoped `callTranscriptTurnRepo` on a FORCE-RLS
  table (`schema.ts:1535-1536`); the Docker-gated test pins the real
  columns.
- **LLM gateway:** U6 keeps every call inside the gateway and only
  widens the returned shape; no direct provider calls. U10 hangs off
  the gateway's existing success and error paths, so it sees every call
  by construction and nothing can bypass it.
- **Human approval / proposals:** untouched. No proposal or approval
  path changes.
- **Integer cents:** cost tracker totals stay integer cents.

## Implementation Units

### U1. Sentry capture in the global error handler
- **Goal:** every unhandled 5xx reaches Sentry with scope tags (R1).
- **Requirements:** R1
- **Dependencies:** none
- **Files:** `packages/api/src/app.ts` (global handler at `:6978`;
  widen the `anyReq` cast at `:6989` from `{ route?: string }` to also
  read `correlation_id` and `tenant_id`), `packages/api/src/monitoring/sentry.ts`
  (no API change expected), test
  `packages/api/test/middleware/global-error-handler-sentry.test.ts`
  (new).
- **Approach:** the handler today calls only `recordApiError` (PostHog)
  at `app.ts:6990`, gated on `statusCode >= 500`; `captureException`
  has no caller outside `monitoring/instrumentation.ts:40`, so no 5xx
  reaches Sentry. In the same `>= 500` branch call
  `getSentryClient().withScope` → `setTag` → `captureException(err)`,
  after `toErrorResponse` and alongside `recordApiError`. 4xx never
  captures. Tag sources, all pre-redacted because `scope.setTag`
  values do not pass through Sentry's `beforeSend` redaction: `route`
  from `req.safeRequestLog.route` (already `redactUrlValue`'d at
  `middleware/request-logging.ts:61`; never `req.originalUrl`),
  `request_id` from `req.safeRequestLog.correlation_id` (minted at
  `request-logging.ts:47`, stored at `:70`; there is no `requestId`
  field in this codebase), `tenant_id` from `req.auth?.tenantId` (what
  `recordApiError` already uses). Do not read `tenantContextStore`: it
  is only mounted under `/api` (`app.ts:4624`), so webhook and
  telephony 5xx would have no store. Keep `instrument()` untouched.
- **Patterns to follow:** `packages/api/src/monitoring/instrumentation.ts:31-41`
  for the `withScope` → `setTag` → `captureException` shape;
  `packages/api/test/monitoring/instrumentation.test.ts:11-40` for the
  fake `SentryClient` with a recording `withScope`, installed via
  `setSentryClient` and torn down with `resetSentryClient`;
  `packages/api/test/app/http-wiring.route.test.ts` for driving
  `createApp()` with supertest to reach the global handler. (There is
  no existing test of the global handler; `test/analytics/posthog.test.ts`
  calls `recordApiError` directly and never builds an app.)
- **Test scenarios:**
  - Happy path: an `/api` route throws → response 500 →
    `captureException` called once; tags carry the redacted route, the
    correlation id, and the tenant id.
  - Happy path: a non-`/api` route (webhook path) throws → captured
    with route and correlation id; `tenant_id` tag absent, no throw
    from the missing tenant store.
  - Edge: a 404/422 mapped error → `captureException` not called.
  - Error path: no `SENTRY_DSN` → no-op client, handler still returns
    the JSON error envelope.
- **Verification:** a deliberate test error on dev appears in Sentry
  (prod checklist step 4).

### U2. Gate failures open a GitHub issue
- **Goal:** a red scheduled gate is visible without Slack (R3).
- **Requirements:** R3
- **Dependencies:** none
- **Files:** `.github/scripts/report-gate-failure.ts` (new),
  `.github/workflows/voice-smoke-real.yml`,
  `.github/workflows/qa-matrix-gate.yml`,
  `.github/workflows/voice-quality-weekly-trend.yml`, test
  `packages/api/test/voice-quality/report-gate-failure.test.ts` (new;
  imports `'../../../../.github/scripts/report-gate-failure'` because
  `packages/api/vitest.config.ts` only discovers `test/**/*.test.ts`,
  so a test placed under `.github/` would never run), doc
  `docs/runbooks/alerting.md`.
- **Approach:** one script run as an `if: always()` post-step that
  receives the job conclusion (`${{ job.status }}`) and the workflow
  name. On failure it finds-or-creates an issue labelled `gate-red`
  titled by workflow name and appends the run URL and the failing step;
  on success it closes any open `gate-red` issue for that workflow. An
  `if: failure()` step would never run on the green run that should
  close the issue, so the conclusion must be passed in explicitly.
  No issue-search helper exists to reuse: `voice-quality-trend-report.ts:169`
  (`openRegressionIssue`) is a single create-only POST with no list,
  comment or close, and it deliberately swallows every failure
  (`:207-218`, documented at `:165-168`), which conflicts with this
  unit's exit-non-zero-on-403 requirement. Write the find-or-create
  and close logic new, following the list-then-PATCH sticky pattern in
  `.github/scripts/post-voice-quality-pr-comment.ts:175-200`.
  Permissions: `voice-quality-weekly-trend.yml:28-30` already grants
  `issues: write`; `voice-smoke-real.yml` and `qa-matrix-gate.yml`
  have no `permissions:` block at all and need
  `permissions: { contents: read, issues: write }`. `contents: read` is
  mandatory because introducing a `permissions:` block drops every
  unlisted scope to `none` and both use `actions/checkout`. Slack
  steps: `voice-smoke-real.yml:56-58` is `if: failure()` with no
  `continue-on-error`, add it; the weekly trend's Slack step already
  has `if: always()` + `continue-on-error: true`; `qa-matrix-gate.yml`
  has no Slack step.
- **Patterns to follow:** `.github/scripts/post-voice-quality-pr-comment.ts:175-200`
  (list existing, PATCH the sticky one, else POST);
  `packages/api/test/voice-quality/voice-quality-trend-report.test.ts:17`
  for importing and unit-testing a `.github/scripts` module with a
  mocked `fetch`.
- **Test scenarios:**
  - Happy path: no open issue → one created with the run URL.
  - Edge: open issue exists → comment appended, no duplicate.
  - Happy path: green run with open issue → issue closed.
  - Edge: green run with no open issue → no API write.
  - Error path: GitHub API 403 → script exits non-zero with a clear
    message, workflow still reports the original failure.
- **Verification:** trigger `workflow_dispatch` on one gate with a
  secret deliberately blank → issue appears; re-run green → closes.

### U3. Prod observability and CI secrets (operator)
- **Goal:** the keys exist where the code expects them (R2, R3).
- **Requirements:** R2, R3
- **Dependencies:** U2 (so the first green run closes the issues)
- **Files:** `docs/prod-env-checklist.md` (add `VITE_POSTHOG_KEY`,
  `POSTHOG_API_KEY`, `TWILIO_BUSINESS_NAME` rows to the web/API tables),
  `docs/runbooks/qa-github-secrets.md` (referenced by the gate workflow;
  create if missing and list every secret each gate needs).
- **Approach:** on Railway prod set `SENTRY_DSN`, `POSTHOG_API_KEY`,
  `TWILIO_BUSINESS_NAME` (API + voice services) and `VITE_POSTHOG_KEY`
  (web service, triggers a rebuild). In GitHub Actions set the
  repository secrets the workflows actually read: `ANTHROPIC_API_KEY`
  and `OPENAI_API_KEY` (weekly trend), `SLACK_ALERTS_WEBHOOK` (read by
  `voice-smoke-real.yml` and `mms-vision-smoke.yml` into the
  `SLACK_WEBHOOK_URL` env var), `SLACK_VOICE_QUALITY_WEBHOOK` (read by
  `voice-quality-weekly-trend.yml`), the six `TWILIO_*`/`STAGING_*`
  secrets for the real-call smoke, and the `E2E_*` set for the QA
  matrix (staging targets, never prod). There is no repository secret
  named `SLACK_WEBHOOK_URL`; that is only the env var name inside the
  jobs.
- **Test expectation:** none — operator configuration. Verification is
  the checklist's live probes.
- **Verification:** `$pageview` events from prod appear in PostHog;
  `/api/health/ai` providers non-empty after the first AI call; all
  three gates green on their next scheduled run; the `gate-red` issues
  close.

### U4. Rivet HVAC Stripe re-link and real inbound number (operator)
- **Goal:** the live tenant can manage billing and receive calls (R4).
- **Requirements:** R4
- **Dependencies:** U3 (real Twilio credentials on the provisioning
  worker)
- **Files:** `docs/ops/relink-stripe-customer.md` (new runbook: locate
  the tenant billing row, determine deletion vs key-mode mismatch in the
  Stripe Dashboard, create the customer in the correct mode, write the
  new id with an audit row, verify the portal session), `docs/ops/claim-inbound-number.md`
  (new runbook: confirm prod Twilio SID/token and the provisioning
  worker's `NODE_ENV`, clear the `stub: true` provider_data, claim a
  number through the onboarding Phone step, set the Business-profile
  phone, place a witnessed call). Close #905, #906 and the B4 item in
  `docs/verification-runs/live-deploy-verification-2026-08-05.md`.
- **Approach:** manual, audited SQL through the existing tenant-scoped
  paths; no new endpoint. The recreate-on-demand product decision stays
  in #906.
- **Test expectation:** none — operator runbook. The code guards from
  PR #904 (magic numbers cannot persist; portal failure is
  machine-readable) already carry tests.
- **Verification:** `POST /api/billing/portal-session` returns a Stripe
  portal URL for Rivet HVAC; a real inbound call lands a proposal in
  prod (B4 witnessed).

### U5. Absolute per-call duration cap on the voice path
- **Goal:** no call runs past a configured wall-clock limit (R5).
- **Requirements:** R5
- **Dependencies:** none
- **Files:** `packages/api/src/telephony/media-streams/mediastream-adapter.ts`
  (`start()` at `:1001` arms the idle timer; `armIdleTimer` at
  `:3097-3109` is re-armed from `handleMedia` at `:1544`;
  `handleClose(reason: string)` at `:3220`; `mapCloseReasonToFinalize`
  at `:851-870`; `speakAndEndAfterRepeatedSpeechTurnFailures` at
  `:1908-1921`; `speakRecoveryLine` at `:2032`), the language-aware
  copy constants next to `SPEECH_TURN_FAILURE_ESCALATION_COPY` (new
  wrap-up line; no closing-line copy exists today),
  `packages/api/src/telephony/twilio-adapter.ts` (`_handleGatherLocked`
  at `:2138`, entered via `handleGather` `:2125` under
  `withSessionLock`), `packages/api/src/ai/agents/customer-calling/outcome-mapper.ts`
  (`deriveCallOutcome` `:16-85`; unknown reasons fall to `'failed'` at
  `:84`), `packages/api/src/shared/config.ts` (`configSchema`: add
  `VOICE_MAX_CALL_DURATION_MS` as `z.coerce.number().int().positive()`
  with a default, alongside the `SLO_*` knobs at `:112-158`;
  `loadConfig` `:174` throws on 0/negative at boot),
  `packages/api/src/app.ts` (`:4379-4425`: thread the value into the
  `new TwilioMediaStreamAdapter` deps literal; `audioIdleTimeoutMs` is
  a dep that is never wired from config today, so this is new
  plumbing), `.env.production.example` (declared for the env-coverage
  guard), `packages/api/src/ai/skills/session-cost-tracker.ts` (delete
  `checkDuration` `:157`, `maxDurationMs` `:5,:76,:90`, and the
  `'duration'` `CapDimension` member `:9-11`) with
  `packages/api/test/ai/skills/session-cost-tracker.test.ts` (delete
  the `checkDuration` describe block at `:245` and its 12 call sites),
  tests `packages/api/test/telephony/media-streams/mediastream-adapter.test.ts`
  (extend) and `packages/api/test/telephony/gather-max-call-duration.test.ts`
  (new).
- **Approach:** arm one absolute timer in `start()`, never touched by
  `handleMedia`, and clear it on every existing close path. At
  `limit - 30s` speak the wrap-up through `speakRecoveryLine` (which
  goes `emitSideEffects` → `runTurnWithFiller` → TTS and appends the
  agent line). At `limit` reuse the exact shape of
  `speakAndEndAfterRepeatedSpeechTurnFailures`: stash
  `pendingFinalizeEffects = [{ type: 'end_session', payload: { reason:
  'max_call_duration' } }]` and call `handleClose('end_session')`, so
  `finalizeTerminatedSession` (`twilio-adapter.ts:3231-3245`) writes
  the reason to `voice_sessions.terminal_reason` through
  `persistSessionEnded`. Do not pass a new bare reason string to
  `handleClose`: `mapCloseReasonToFinalize` has no branch for it and
  falls through to `'caller_hangup'` at `:869`, which would also vote
  `success` on the realtime health circuit at `:3241-3246`. There is
  no close-reason audit event in the adapter today (its only audit
  emitter is `emitRealtimeResilienceAudit` with a closed three-member
  union at `:1480-1483`); the terminal reason is persisted through the
  existing finalize path like every other close reason, so no new
  audit type is added. Add a `max_call_duration` branch to
  `deriveCallOutcome` so the session outcome is not recorded as
  `'failed'`. On Gather, compute
  `Date.now() - session.createdAt.getTime()` in `_handleGatherLocked`
  (the way `runSummary` does at `twilio-adapter.ts:3325`;
  `VoiceSession.createdAt` is at `voice-session-store.ts:342`) and,
  when exceeded, return the wrap-up `<Say>` plus the builder's
  `end_session` → `<Hangup/>` branch (`twilio-adapter.ts:626,675`).
  Default: 15 minutes, matching the existing
  `DEFAULT_TELEPHONY_CAPS.maxDurationMs` intent that this unit deletes;
  the env var overrides it.
- **Patterns to follow:** `speakAndEndAfterRepeatedSpeechTurnFailures`
  (`mediastream-adapter.ts:1908-1921`) for speak-then-end with a custom
  terminal reason; `packages/api/test/telephony/media-streams/mediastream-adapter.test.ts`
  T2-F05 block at `:2864-2873` (`vi.useFakeTimers({ toFake:
  ['setTimeout', 'clearTimeout'] })` with a real `setImmediate` flush)
  and the `audioIdleTimeoutMs: 1` injection at `:376`. (The
  `telephony-realtime-fallback.test.ts` file is a supertest
  route-decision test with no fake timers and never constructs the
  adapter; do not copy it.)
- **Test scenarios:**
  - Happy path: continuous media frames for `limit + 1s` → wrap-up
    spoken once, `terminal_reason` is `max_call_duration`, outcome is
    not `'failed'`.
  - Edge: call ends normally before the limit → timer cleared, no
    wrap-up.
  - Edge: env unset → default applies; env `0`/negative → `loadConfig`
    rejects at boot.
  - Gather: turn arriving after the limit → hangup TwiML with wrap-up
    `<Say>`.
  - Error path: TTS failure during wrap-up → close still happens
    (`speakRecoveryLine` swallows the TTS error; close runs after the
    await).
  - Regression: the health circuit is not voted `success` by a
    max-duration close.
- **Verification:** a looping test caller on dev is cut at the limit
  and the session row carries the reason.

### U6. Voice LLM usage accounting and API usage propagation
- **Goal:** all voice-path spend is tracked and clients see real usage
  (R6).
- **Requirements:** R6
- **Dependencies:** none
- **Files:** `packages/api/src/ai/agents/customer-calling/vulnerability-grader.ts`,
  `packages/api/src/ai/agents/customer-calling/sentiment-classifier.ts`,
  their wiring call sites (grep the `llm:`/`costTracker:` construction
  in `inapp-adapter.ts`, `twilio-adapter.ts`,
  `create-voice-turn-processor.ts`), `packages/api/src/routes/assistant.ts`
  (seven builders), tests
  `packages/api/test/ai/agents/customer-calling/vulnerability-grader.test.ts`,
  `packages/api/test/ai/agents/customer-calling/sentiment-classifier.test.ts`,
  `packages/api/test/routes/assistant-usage-propagation.test.ts` (new).
- **Approach:** widen both modules' `llm.complete` result to
  `{ text, tokenUsage }` and their `costTracker` dep to include
  `recordUsage`; call it after each completion with the model id, like
  `create-voice-turn-processor.ts:1115`. In `assistant.ts`, thread
  `classification.tokenUsage` (and per-segment `segClass.tokenUsage`,
  summed) into every builder that follows a real classifier call; the
  deterministic-lookup and error-fallback builders keep zeros.
- **Patterns to follow:** `inapp-adapter.ts:1651`,
  `create-voice-turn-processor.ts:1115`, `text-mode-driver.ts:727`;
  `packages/api/test/routes/assistant-dropped-intents.test.ts` for the
  mocked-classifier route harness.
- **Test scenarios:**
  - Happy path: grader completes → `recordUsage` called with the
    provider's counts; totals rise by the expected cents.
  - Edge: budget ratio ≥ 0.8 → grader skips the call and records
    nothing (existing behaviour preserved).
  - Happy path: assistant proposal-draft response carries the
    classifier's non-zero usage; chained response sums segments.
  - Edge: deterministic lookup path → usage stays zero.
- **Verification:** the AI-capability sweep (branch
  `tools/ai-catalog-sweep`) reports non-zero usage for lookup and
  proposal probes.

### U10. Langfuse trace export from the LLM gateway
- **Goal:** every completion served through the gateway, success,
  failure or cache hit, is exported as a Langfuse trace and generation
  carrying tenant, task, model, prompt version, usage, cost, latency
  and the session it belongs to, with the same redaction the `ai_runs`
  snapshot already applies, so a voice turn or chat exchange can be
  opened as one trace instead of reconstructed from Prometheus
  aggregates (R10).
- **Requirements:** R10
- **Dependencies:** U6 (the exported usage must be the real provider
  counts, not the zeros #913 describes; landing this first would export
  wrong numbers). U1 and U3 are not hard dependencies but should land
  first so the new data has someone watching it.
- **Files:** `packages/api/src/ai/gateway/trace-exporter.ts` (new:
  `LLMTraceExporter` interface with `recordCompletion(event)` and
  `flush()`, a `LangfuseTraceExporter`, and a `NoopTraceExporter`),
  `packages/api/src/ai/gateway/gateway.ts` (constructor at `:367-377`
  takes four positional args; the exporter is the fifth; one call on
  the success path beside the `ai_runs` completion update at
  `:557-589` and one on the error path beside `failAiRun` at
  `:625-643`), `packages/api/src/ai/gateway/cache.ts`
  (`CachingGatewayWrapper` takes `aiRunRepo` as its fifth arg at `:97`;
  add the exporter as the sixth and emit from the hit branch at
  `:136`, mirroring `writeAiRunForCacheHit` at `:169-210`),
  `packages/api/src/ai/gateway/factory.ts` (add `traceExporter?` to
  `CreateLLMGatewayOptions` at `:52-71`; thread into the one
  options-bearing construction at `:204`; the sites at `:460` and
  `:479` are two-arg mock/hermetic constructions and take none; add
  `'traceExporter'` and the already-missing `'resilience'` to the
  options-versus-logger discriminator at `:110-116`, which otherwise
  coerces `{ traceExporter }` into a logger), `packages/api/src/app.ts`
  (`:1249`: construct the exporter only when `LANGFUSE_PUBLIC_KEY` and
  `LANGFUSE_SECRET_KEY` are set and pass it with a `logger`, which is
  not passed today; `:7089-7092`: call `flush()` beside
  `shutdownAnalytics()`, the queued-telemetry slot, before the cache,
  Redis and pool shutdowns), `packages/api/src/ai/orchestration/intent-classifier.ts`
  (`ClassifyContext` at `:1044-1124` carries no session identifier:
  add `sessionId?: string` and `callSid?: string`, put them into
  `metadata` at `:2723`, and thread them from the nine `classifyIntent`
  call sites: `ai/agents/customer-calling/inapp-adapter.ts:1070,1092`,
  `ai/voice-turn/create-voice-turn-processor.ts:4376`,
  `ai/voice-quality/path-smoke/run-path-smoke.ts:75`,
  `ai/voice-quality/text-mode-driver.ts:703`,
  `telephony/twilio-adapter.ts:2338`, `workers/voice-action-router.ts:1182`,
  `routes/assistant.ts:2029,2245`; the voice sites have `session.id`
  and `session.callSid` in scope), `packages/api/src/routes/assistant.ts`
  (`:2751`: add `sessionId: conversationId`; it is `undefined` on a
  conversation's first turn, so pass the id minted at `:2898,2928`
  down into `generateAssistantReply` instead of leaving turn one
  ungrouped), `packages/api/src/shared/config.ts` (declare the four
  `LANGFUSE_*` vars next to `SENTRY_DSN` at `:43`),
  `.env.production.example` (all four, in the `:238-239` style; the
  env-coverage guard requires a template entry for every read var and
  a `config.ts` schema entry alone does not satisfy it),
  `docs/prod-env-checklist.md`, `packages/api/package.json` (the
  `langfuse` SDK; a new runtime dependency falls under the
  high-severity gate in `.github/workflows/dependency-audit.yml`),
  tests `packages/api/test/ai/gateway/trace-exporter.test.ts` (new),
  `packages/api/test/ai/gateway/gateway-trace-export.test.ts` (new),
  and `packages/api/test/ai/gateway/factory-cache.test.ts` (extend for
  the hit branch).
- **Approach:** mirror the `aiRunRepo` pattern exactly: the exporter is
  optional, every call is wrapped so a throw is logged and never reaches
  the completion, and the payload is built from values the gateway
  already has. Two coverage facts shape the hook placement. The
  resilience stack wraps the provider, not the gateway
  (`compose-resilience.ts:403-435`, put into the providers map at
  `factory.ts:191-197`), so retries, breaker and fallback-provider
  paths all run inside `gateway.complete` and a hook there sees them
  with `providerPath`, `fallbackStage` and `degraded` populated. Cache
  hits do not: `CachingGatewayWrapper` wraps the gateway from the
  outside (`factory.ts:203-212`) and returns `{ ...cached.response,
  cached: true }` at `cache.ts:136` without calling it, and it is
  returned as a duck-typed `as unknown as LLMGateway`, not a subclass.
  So the exporter is called from three places: gateway success,
  gateway error, and the cache hit branch, which is how `ai_runs`
  already solved the same gap. Trace id is the request's
  `correlationId`; Langfuse `sessionId` comes from
  `request.metadata.sessionId`; the tenant id is a tag and metadata
  field, never a Langfuse user id. Generation fields: `taskType`,
  resolved and served model, provider, `providerPath`, `fallbackStage`,
  `cached`, `degraded`, `promptVersionId`, `tokenUsage`,
  `costMicroCents` (converted to the SDK's cost unit at the boundary
  only), `latencyMs`, and on failure the error message. Input and
  output content are exported only when `LANGFUSE_CAPTURE_CONTENT=true`,
  and then only after `redactMessagesForSnapshot` and
  `redactByTier('strict')`; the default exports metadata and usage
  alone. No keys means the noop exporter and zero network calls,
  matching the off-by-default posture of PostHog and Sentry. Because
  `app.ts:1249` builds the gateway without a `logger`, every existing
  best-effort `this.logger?.error` is already silent in production;
  pass a logger there as part of this unit so exporter failures are
  visible. The AI-gateway CI guard (`packages/api/scripts/check-ai-gateway-guard.sh`)
  forbids only `new OpenAI(`, `.chat.completions.create` and
  `from 'openai'` outside `src/ai/gateway/` and `src/ai/providers/`; a
  `langfuse` import trips nothing, so placement in `ai/gateway/` is a
  layering choice, not a guard requirement.
- **Patterns to follow:** the `aiRunRepo` create/complete/fail calls in
  `gateway.ts:464-643` (best-effort wrapping, correlation id on the
  failure log); `writeAiRunForCacheHit` in `cache.ts:169-210` for the
  hit-branch duplicate; `redactMessagesForSnapshot` and
  `packages/api/test/ai/gateway/snapshot-redaction.test.ts` for the
  redaction contract; `packages/api/test/ai/gateway/gateway-metrics.test.ts`
  for driving the gateway with a mock provider and asserting side
  effects; `initSentry` in `packages/api/src/monitoring/sentry.ts` for
  the no-op-without-key shape.
- **Test scenarios:**
  - Happy path: mock provider succeeds → exporter receives one event
    with the response's `tokenUsage`, `costMicroCents`, `latencyMs`,
    `promptVersionId`, `correlationId` and `sessionId`.
  - Happy path: cache hit → exporter receives one event with
    `cached: true` and no provider call.
  - Happy path: fallback provider serves the call → event carries
    `providerPath`, `fallbackStage` and `degraded: true`.
  - Failure path: mock provider throws → exporter receives an error
    event with the message and latency; the gateway still rethrows.
  - Isolation: exporter's `recordCompletion` throws → completion result
    is unchanged and the failure is logged with the correlation id.
  - Redaction: with content capture on, an input message containing a
    phone number and an `Authorization` value is exported redacted;
    with capture off (default), the event carries no `input`/`output`.
  - Config: no keys → `NoopTraceExporter`; keys present → Langfuse
    exporter constructed with the configured base URL;
    `createLLMGateway(config, { traceExporter })` is not coerced into a
    logger.
  - Session threading: the voice classifier's request carries the
    session id and call SID; the chat route's carries the conversation
    id on turn one and later turns alike.
  - Shutdown: `flush()` is awaited before the pool closes.
- **Verification:** with keys set on the dev service, one assistant
  probe and one in-app voice turn appear in Langfuse as traces grouped
  by session, with non-zero usage and the prompt version attached, and
  a repeated identical probe appears as a cached generation.

### U7. Single transcript append per caller utterance
- **Goal:** one append per utterance on every transport (R7).
- **Requirements:** R7
- **Dependencies:** none
- **Files:** `packages/api/src/telephony/twilio-adapter.ts`
  (`processCallerUtterance` at `:1898`; its unconditional append at
  `:1915-1920`; its `speechTurn` call at `:1955-1960`),
  `packages/api/src/ai/voice-turn/create-voice-turn-processor.ts`
  (`speechTurn` at `:4142`; its append at `:4179-4188`),
  `packages/api/src/telephony/media-streams/mediastream-adapter.ts`
  (`SpeechTurnHandler` type at `:143-149`; the direct `speechTurn` call
  at `:1671`), tests
  `packages/api/test/ai/voice-turn/coverage-table.behavior.test.ts`
  (extend), `packages/api/test/telephony/transcript-single-append.test.ts`
  (new, drives Gather, media-streams-via-adapter and
  media-streams-direct).
- **Approach:** #859 is still reproducible on current main: PR #974
  only wrapped the `speechTurn` append in an empty-utterance condition
  (`speechResult.trim().length > 0 || !servesFamilyHere(...)`), which
  any non-empty utterance satisfies, and its own message says the net
  observable change is zero. The code admits the double reach at
  `create-voice-turn-processor.ts:4166-4169`. Add an optional
  `transcriptAppended?: boolean` (default `false`) to the
  `SpeechTurnHandler` args and AND it into the existing #962 condition
  rather than replacing it, so the empty-utterance rule survives.
  `processCallerUtterance` passes `true` after its own append. The
  direct media-streams call at `:1671` passes nothing. Ownership of the
  empty skip: make the `processCallerUtterance` append conditional on
  a non-empty utterance too (matching Gather's guard at
  `twilio-adapter.ts:2163`), otherwise an empty media-streams final
  still writes an empty caller line and defeats the #962 rule on that
  surface. Gather is already single-append because it never reaches
  `speechTurn` (`_handleGatherLocked` classifies inline). Note that in
  shipped wiring (`app.ts:4379-4385`) `deps.speechTurn` is always
  `processCallerUtterance`, so no production caller passes `false`;
  the direct scenario below is a regression pin for a future rewire.
- **Patterns to follow:** the #962 coverage-table behaviour anchors;
  `SpeechTurnHandler` is declared in the adapter (not in
  `ai/voice-turn/`), re-exported via `telephony/media-streams/index.ts:24`
  and imported at `create-voice-turn-processor.ts:246`; keep the field
  optional so the direct call and existing test doubles compile.
- **Test scenarios:**
  - Happy path: media-streams utterance via adapter → exactly one
    `appendTranscript` with that text.
  - Happy path: direct `speechTurn` caller → exactly one append.
  - Happy path: Gather utterance → exactly one append (unchanged).
  - Edge: the caller genuinely repeats the same line twice → two
    entries.
  - Edge: empty utterance on media streams → no append at either site.
- **Verification:** a recorded media-streams call's summary no longer
  shows doubled caller lines.

### U8. Incremental transcript persistence and webhook recovery
- **Goal:** transcripts survive restarts; the recording webhook never
  silently drops one (R8).
- **Requirements:** R8
- **Dependencies:** U7 (so persisted turns are not duplicated)
- **Files:** `packages/api/src/app.ts` (recording `onPersisted` hook at
  `:3862-3872`; the bare `return` at `:3871`; the `embeddingProvider`
  conditional at `:3859`; the `!event.inserted` gate at `:3863`),
  `packages/api/src/ai/agents/customer-calling/voice-session-store.ts`
  (`appendTranscript` at `:676-681`; the session carries `tenantId`
  `:164`, optional `callSid` `:167`, `transcript` `:179`, and `id`),
  `packages/api/src/voice/call-transcript-turn.ts` and
  `packages/api/src/voice/pg-call-transcript-turn.ts` (widen
  `voiceRecordingId` to optional on `CallTranscriptTurn` `:31` and
  `RecordTurnInput` `:42`; replace the `voiceRecordingId is required`
  throws at `:66` and `pg:38` with "exactly one of `voiceRecordingId`
  or `callSid`+`sessionId`"; `rowToTurn` `pg:23` maps a null through;
  add `listByCallSid(tenantId, callSid)` and
  `attachRecording(tenantId, callSid, voiceRecordingId)`),
  `packages/api/src/db/schema.ts` (new migration
  `274_call_transcript_turns_call_sid`, appended at the end of
  `MIGRATIONS`, never by editing `060_capture_schema` at `:1518`),
  `packages/api/test/db/migration-immutability.test.ts` (add the
  `['274_call_transcript_turns_call_sid', '<sha256>']` `SNAPSHOT`
  entry), `packages/api/src/workers/transcript-ingestion-worker.ts`
  (`:176-201`), tests
  `packages/api/test/workers/transcript-ingestion-worker.test.ts`
  (extend), `packages/api/test/integration/call-transcript-turn-durability.test.ts`
  (new, Docker-gated).
- **Approach:**
  - **Step 0, land first and independently:** `app.ts:3864` calls
    `findByCallSid`, which returns `undefined` for any session with
    `ended === true` (`voice-session-store.ts:614-620`), and `ended` is
    set at hangup on every normal path. Ingestion is therefore dropped
    on nearly every completed call today, not only reaped ones. Swap
    to `findByCallSidIncludingEnded` (`voice-session-store.ts:630`),
    the precedent already documented at `twilio-adapter.ts:3409-3410`.
    This alone closes most of R8; the rest of the unit covers the
    genuinely-gone session (restart, other instance, 30-minute reap).
  - **Persist as you go, keyed by call SID and session id.** The
    `voice_recordings` row does not exist until Twilio's recording
    webhook (`recordInboundCall` at `voice-service.ts:523-539` is
    called only from the recording and voicemail webhooks), so
    mid-call writes cannot use today's key. In `appendTranscript`,
    when the session has a `callSid` (in-app sessions do not: no-op),
    stamp the turn index from the transcript length and persist
    `{ tenantId, callSid, sessionId, turnIndex, speaker, text }`
    fire-and-forget with error logging. A second session can be
    created for the same CallSid (`routes/telephony.ts:541-586`
    gather-fallback after a restart; Twilio re-delivery after a reap),
    restarting its index at 0, so the key must include `session_id`
    or the second leg would overwrite the first.
  - **Migration 274**, idempotent because the runner re-executes every
    migration on every boot with no ledger (`schema.ts:6660-6666`):
    `ALTER COLUMN voice_recording_id DROP NOT NULL`, `ADD COLUMN IF NOT
    EXISTS call_sid TEXT`, `ADD COLUMN IF NOT EXISTS session_id TEXT`,
    a partial unique index on `(tenant_id, call_sid, session_id,
    turn_index) WHERE call_sid IS NOT NULL`, and an index on
    `(tenant_id, call_sid)`. Any CHECK carries `NOT VALID` per U9. Key
    order is enforced by `test/db/migration-key-order.test.ts`.
  - **Attach is first-writer-wins and renumbers.** Two
    `voice_recordings` rows per call are legal (the voicemail leg
    dedupes on `(tenant_id, call_sid, recording_url)`,
    `recording-webhook.ts:19-21`; `idx_voice_call_sid` is non-unique).
    `attachRecording` runs in one transaction: select this call's
    unattached rows ordered by `(created_at, turn_index)`, rewrite
    `turn_index` to a single 0-based sequence across legs, and set
    `voice_recording_id` only `WHERE voice_recording_id IS NULL`, so
    the voicemail leg's webhook never steals turns and the existing
    unique `(voice_recording_id, turn_index)` holds after attach.
  - **Persisted rows are authoritative for ingestion.** The worker
    today derives `turnIndex` from its loop over a filtered array
    (`transcript-ingestion-worker.ts:187`), which drifts from append
    order whenever a turn parses empty, and mis-indexes
    `transcript[i]` at `:191`. Change the queue payload from
    `transcript: string[]` to `turns: { index, speaker, text }[]`.
    On every recording webhook (session present or not): attach, then
    build `turns` from the persisted rows when any exist, else from
    the in-memory session as today. The worker upserts using the
    carried index, so end-of-call ingestion updates the same rows it
    persisted mid-call and never fights over numbering.
  - **Recovery branch.** Replace the bare `return` at `:3871` with:
    load by call SID → attach → enqueue; only when no rows exist emit
    audit `voice.transcript_unrecoverable` (dotted, matching
    `voice.payload_contract_failed`; `audit_events.event_type` is
    unconstrained `TEXT` at `schema.ts:66`, so no enum change; `auditRepo`
    is in scope at `app.ts:1164`). Move the recovery and audit out of
    the `embeddingProvider` conditional at `:3859` so R8 holds when
    `AI_PROVIDER_API_KEY` is unset. Keep the `!event.inserted` early
    return: the first delivery already handled a Twilio retry.
- **Patterns to follow:** `pg-call-transcript-turn.ts` column names and
  its `ON CONFLICT DO UPDATE` upsert (`:73-78`);
  `docs/solutions/database-issues/mocked-pool-hides-real-schema-mismatch.md`
  (pin real columns in the integration test); the `REGEN_HINT` in
  `migration-immutability.test.ts:545` for the snapshot entry.
- **Test scenarios:**
  - Happy path: three turns appended → three rows keyed by call SID
    and session; restart simulated by clearing the store → webhook
    attaches, renumbers, and enqueues ingestion with three turns.
  - Happy path (Step 0): a normally-ended session is still found by
    the webhook and ingestion is enqueued.
  - Edge: end-of-call ingestion after incremental persistence → the
    worker updates the same rows; no duplicates, indices match append
    order even when one turn parses empty.
  - Edge: mid-call restart → gather-fallback creates a second session
    for the same CallSid → the webhook recovers both legs in order,
    none overwritten.
  - Edge: voicemail leg's second recording webhook → turns stay on the
    first recording; nothing re-pointed.
  - Edge: no session and no rows → audit
    `voice.transcript_unrecoverable`, 200 to Twilio.
  - Edge: in-app session (no `callSid`) → no persistence attempted.
  - Error path: DB write fails mid-call → call continues, error
    logged, end-of-call ingestion still writes from the in-memory
    session.
  - Integration (Docker): real repo against migration 274; nullable
    recording id, the partial unique index, and `attachRecording`'s
    renumber pinned on real columns; RLS keeps another tenant's turns
    invisible.
- **Verification:** deploy during a live dev call; the call's
  transcript is present afterwards, and a normally-ended dev call has
  its transcript ingested (Step 0).

### U9. `NOT VALID` on every CHECK constraint, pinned schema-wide
- **Goal:** no deploy re-validates a whole table for a CHECK it did not
  change (R9).
- **Requirements:** R9
- **Dependencies:** none
- **Files:** `packages/api/src/db/schema.ts` (the 26 sites listed in
  Issue 5), `packages/api/test/db/migration-immutability.test.ts`
  (regenerate the 26 affected `SNAPSHOT` hashes),
  `packages/api/test/db/check-constraints-not-valid.test.ts` (new,
  schema-wide), `packages/api/test/db/dispatch-entity-type-vocabulary.test.ts`
  (generalise into a parameterised vocabulary-pin for
  `jobs_status_check` → `JobStatus` at `packages/api/src/jobs/job.ts:15-23`
  and `leads_source_check` → `LEAD_SOURCES` at
  `packages/api/src/leads/enums.ts:9-25`; `proposals_status_check` has
  no single exported union today, see Open Questions),
  `docs/solutions/database-issues/replay-migrations-check-constraints-not-valid.md`
  (new learning).
- **Approach:**
  - **Fix these four first; they are live deploy-brickers, not
    hygiene.** Because replay runs in corpus order, a stale narrower
    copy validates the whole table against an old vocabulary before
    the widened one runs, exactly the 190/269/270 failure:
    `leads_source_check` at `schema.ts:1914` lacks `'sms'` (written by
    `sms/inbound-capture.ts:190,300`); `proposals_status_check` at
    `:984` lacks `'executing'` (written by `proposals/pg-proposal.ts:587`);
    `proposal_sms_events_kind_check` at `:4119` and `:4277` lack
    `'voice_reapproval'` / `'digest_approve_all_rendered'` (written by
    `ai/tasks/proposal-approval-task.ts:1004` and `app.ts:6070`). One
    SMS-originated lead or one proposal in `executing` at deploy time
    bricks every subsequent deploy with SQLSTATE 23514.
  - **Edit in place; no new migration; no runner change.** Append
    `NOT VALID` to each of the 26 bare `ADD CONSTRAINT … CHECK` sites
    and regenerate their `SNAPSHOT` entries with the `REGEN_HINT`
    one-liner in `migration-immutability.test.ts:545`. That test has
    no allowlist or cutoff; it is a deliberate speed bump, and commit
    `0c9bd4c` (190/269/270) is the exact precedent. A drop-and-re-add
    migration would instead add 26 permanent `ALTER TABLE` round trips
    to every boot inside the single `statement_timeout = '25s'` the
    whole corpus runs under (`migrate.ts:147`).
  - All 26 are dropped and re-added on every boot, so every one runs a
    full validating scan each deploy whether or not it was ever
    widened: 21 have an explicit `DROP CONSTRAINT IF EXISTS` in the
    migration text and the other 5 (`:2420, :4550, :4734, :5144,
    :5532`) get one injected by the rewriter (see the comment at
    `schema.ts:5137-5141`). Fixing all 26 is therefore correct, not
    over-broad.
  - **Schema-wide test.** Parse every `ADD CONSTRAINT` with `CHECK` in
    `getMigrationSQL()` and fail listing any without `NOT VALID`. The
    parser must tolerate both layouts: `ALTER TABLE t ADD CONSTRAINT n`
    on one line (`:984, :1914, :3474, :4334, :4561, :4804, :4827`) and
    the multi-clause `DROP CONSTRAINT …, ADD CONSTRAINT …` form
    (`:2445-2451, :6527-6529`). `ENTITY_TYPE_CHECK_RE` in the dispatch
    vocabulary test requires a newline before `CHECK` and silently
    misses sites if copied; assert the total match count is 33 so a
    regex regression fails loudly instead of passing vacuously.
  - **Vocabulary pins.** The DB side must be built from scratch:
    `packages/shared/src/contracts/status.test.ts` does not import
    `MIGRATIONS` despite the comment at `schema.ts:5141-5142`; it pins
    only TS to zod. Parameterise over the constraints that have an
    exported union and assert the last definition of each equals it in
    both directions.
- **Patterns to follow:** `packages/api/test/db/schema.test.ts:108-125`
  (`Blocker 3 — every ENABLE-RLS table also FORCEs RLS`: regex-scan
  `getMigrationSQL()`, set-difference, fail with a named list) and
  `:139-197` for the documented-exemption allowlist shape if any CHECK
  legitimately cannot take `NOT VALID`;
  `packages/api/test/db/dispatch-entity-type-vocabulary.test.ts` for
  the two-direction vocabulary assertion. (`migration-discipline.test.ts`
  is permissive by design and never fails; do not model on it.)
- **Test scenarios:**
  - Happy path: schema-wide test passes on the edited schema; fails
    red-first listing the 26 sites before the edit.
  - Edge: a future migration adding a bare CHECK → test names the line.
  - Edge: parser match count is exactly 33; a layout the regex misses
    fails the count.
  - Happy path: vocabulary pins pass for `jobs_status_check` and
    `leads_source_check`; adding a TS union member without widening
    the constraint fails naming the value.
  - Integration (existing `migrate:dryrun` in CI): all migrations still
    apply on a fresh database.
- **Verification:** `npm run migrate:dryrun` clean; the CI
  migration-key guard green; the migration step's wall time in the
  deploy log drops and stays well inside the 25-second corpus budget.

## Risks & Dependencies

- U3 and U4 need Railway, Stripe and Twilio dashboard access; they gate
  R2–R4 and cannot be verified from CI.
- U5 changes live-call teardown; a wrong default cuts real calls. Ship
  with a generous default and the audit reason so the first weeks can be
  reviewed.
- U9 may be blocked by the migration-immutability rule; the fallback
  (one new migration) is stated in the unit.
- U8 adds a write per caller turn; fire-and-forget keeps latency
  unaffected but must never throw into the call path. Its attach step
  rewrites `turn_index` across session legs in one transaction; the
  Docker-gated test must cover the two-leg and voicemail-leg cases or
  the renumber can silently corrupt ordering.
- U9 regenerates 26 immutability hashes in one commit; a reviewer must
  be able to see that only `NOT VALID` was appended at each site (a
  diff with nothing else on those lines).
- U10 exports data off-platform. Content capture is off by default and
  strict-redacted when on; the self-hosted versus Langfuse Cloud choice
  is an operator decision that must be made before enabling it in prod,
  given caller transcripts and the #850 PIN history.

## Open Questions (deferred to implementation)

- Exact wrap-up copy for the max-duration close, and whether the
  brand-voice configurator should own it.
- Whether the QA matrix secrets should target dev or a dedicated staging
  tenant set (the workflow's runbook must say).
- The migration-immutability test's allowance for editing old migration
  text (decides U9's shape).
- Whether `checkDuration()` has any external consumer in
  `packages/voice-eval` before deletion (re-grep at implementation).
- Langfuse session id on the voice path: U10 now threads both the
  session id and the call SID; which one Langfuse groups on is an
  implementation choice (the call SID matches what U8 persists and
  spans a restart's second leg, so it is the safer default).
- `proposals_status_check` has no single exported TS union to pin
  against; either add one in `packages/api/src/proposals/` or leave
  that constraint out of U9's parameterised vocabulary test.
- Whether `persistSessionEnded` emits an audit event for the session
  end; if it does not, no existing close reason is audited and U5
  inherits that gap rather than closing it.
- The exact wrap-up copy constant name and its Spanish rendering (must
  be language-aware like `SPEECH_TURN_FAILURE_ESCALATION_COPY`).
