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
  turn_index)** — cheap, tenant-scoped, idempotent, and the recording
  webhook can rebuild from it. (Alternative: re-transcribe from storage;
  rejected as a second STT spend for data the process already had.)
- **`NOT VALID` on every CHECK, pinned schema-wide** — new rows are
  still checked; only the whole-table re-validation on every boot is
  skipped. The runner-level fix (skip re-adding a constraint whose
  `pg_get_constraintdef` is unchanged) is the durable root-cause fix and
  is deferred to its own plan because it changes every deploy's
  behaviour.

## Scope Boundaries

**In scope:** the nine units below, the prod env checklist and the two
ops runbooks they reference.

**Non-goals:** the JSON-404 for unmatched `/api/*` (C-1), Stripe request
timeouts on the nine untimed calls (C-2), the 30 route files still
lacking the shared malformed-id guard (#882 remainder), classifier
prompt-injection fencing (#894), Layer 1 eval blindness (#888), and the
voice-first build sequence (#852/#962). These are real and are listed
below so they are not lost; they are not among the five.

### Deferred to follow-up work
- Migration runner: compare constraint definitions before drop/re-add
  (root cause of Issue 5).
- C-1 JSON 404 middleware for `/api/*` before the SPA catch-all.
- C-2: wire `deps.stripeFetch` in `app.ts` with the `timedFetch` pattern
  from `stripe-payment-link.ts`.
- #882: adopt `notFoundOnMalformedId` in the remaining 30 route files.
- #894: route the classifier transcript through `fenceUntrusted`.
- #906 product decision: owner-approved Stripe customer recreate.
- Environment property on PostHog events so prod/dev/local can be told
  apart (noted in `docs/PRD-v4-part-E-state.md`).

## Repository invariants touched

- **Audit events:** U7 (max-call teardown) and U9 (incremental turns)
  emit audit rows for the new terminal reason and the persisted turns;
  no mutation is added without one.
- **tenant_id + RLS:** the new transcript-turn writes in U9 go through
  the existing tenant-scoped `callTranscriptTurnRepo`; the Docker-gated
  test pins the real columns.
- **LLM gateway:** U6 keeps every call inside the gateway and only
  widens the returned shape; no direct provider calls.
- **Human approval / proposals:** untouched. No proposal or approval
  path changes.
- **Integer cents:** cost tracker totals stay integer cents.

## Implementation Units

### U1. Sentry capture in the global error handler
- **Goal:** every unhandled 5xx reaches Sentry with scope tags (R1).
- **Requirements:** R1
- **Dependencies:** none
- **Files:** `packages/api/src/app.ts` (global handler at `:6978`),
  `packages/api/src/middleware/request-logging.ts`
  (`captureRequestError`), `packages/api/src/monitoring/sentry.ts`
  (no API change expected), test
  `packages/api/test/middleware/global-error-handler-sentry.test.ts`.
- **Approach:** in the global handler, when the mapped status is ≥ 500,
  call `getSentryClient().withScope` → `setTag('tenant_id' | 'route' |
  'request_id')` → `captureException(err)`, after `toErrorResponse` and
  alongside the existing `recordApiError`. 4xx never captures. Use the
  redaction already installed by `initSentry`. Keep `instrument()`
  untouched.
- **Patterns to follow:** `packages/api/src/monitoring/instrumentation.ts`
  scope usage; `packages/api/test/analytics/posthog.test.ts` for the
  error-handler harness.
- **Test scenarios:**
  - Happy path: a route throws → response 500 → `captureException`
    called once with the tags.
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
  `.github/scripts/report-gate-failure.test.ts`, doc
  `docs/runbooks/alerting.md`.
- **Approach:** one script, `if: failure()`, that finds-or-creates an
  issue labelled `gate-red` titled by workflow name, appends the run
  URL and the failing step name, and closes it on the next green run.
  Extract the issue-search/create helper the trend script already has.
  Keep the Slack steps but make them `continue-on-error`.
- **Patterns to follow:** `.github/scripts/voice-quality-trend-report.ts`
  `--open-issue` branch.
- **Test scenarios:**
  - Happy path: no open issue → one created with the run URL.
  - Edge: open issue exists → comment appended, no duplicate.
  - Happy path: green run with open issue → issue closed.
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
  (web service, triggers a rebuild). In GitHub Actions set
  `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `SLACK_WEBHOOK_URL`, the six
  `TWILIO_*`/`STAGING_*` secrets for the real-call smoke, and the
  `E2E_*` set for the QA matrix (staging targets, never prod).
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
- **Files:** `packages/api/src/telephony/media-streams/mediastream-adapter.ts`,
  `packages/api/src/telephony/twilio-adapter.ts` (Gather per-turn
  check), `packages/api/src/config/*` (new `VOICE_MAX_CALL_DURATION_MS`,
  default 20 min, declared in `.env.production.example` and the
  env-coverage guard), `packages/api/src/ai/skills/session-cost-tracker.ts`
  (delete dead `checkDuration`), tests
  `packages/api/test/telephony/media-streams/max-call-duration.test.ts`,
  `packages/api/test/telephony/gather-max-call-duration.test.ts`.
- **Approach:** arm one absolute timer at session start (not touched by
  `handleMedia`); at `limit - 30s` speak the wrap-up line through the
  existing TTS path, at `limit` call `handleClose('max_call_duration')`
  and emit the audit event with the reason. On Gather, compare session
  start against now at each turn and return the wrap-up TwiML + hangup
  when exceeded. Clear the timer on every existing close path.
- **Patterns to follow:** `armIdleTimer` / `handleClose` structure and
  the existing close-reason audit in the adapter;
  `packages/api/test/telephony/media-streams/telephony-realtime-fallback.test.ts`
  harness with fake timers.
- **Test scenarios:**
  - Happy path: continuous media frames for `limit + 1s` → wrap-up
    spoken once, close reason `max_call_duration`, audit emitted.
  - Edge: call ends normally before the limit → timer cleared, no
    wrap-up.
  - Edge: `limit` env unset → default applies; env `0`/negative → boot
    validation rejects.
  - Gather: turn arriving after the limit → hangup TwiML with wrap-up
    `<Say>`.
  - Error path: TTS failure during wrap-up → close still happens.
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

### U7. Single transcript append per caller utterance
- **Goal:** one append per utterance on every transport (R7).
- **Requirements:** R7
- **Dependencies:** none
- **Files:** `packages/api/src/telephony/twilio-adapter.ts`
  (`processCallerUtterance`), `packages/api/src/ai/voice-turn/create-voice-turn-processor.ts`
  (`speechTurn` append site `:4168-4187`),
  `packages/api/src/telephony/media-streams/mediastream-adapter.ts`
  (direct `speechTurn` call at `:1666`), `packages/api/src/ai/voice-turn/coverage-table.ts`
  (if the cell semantics reference the append), tests
  `packages/api/test/ai/voice-turn/coverage-table.behavior.test.ts`
  (extend), `packages/api/test/telephony/transcript-single-append.test.ts`
  (new, drives Gather, media-streams-via-adapter and media-streams-direct).
- **Approach:** add an explicit `transcriptAppended: boolean` input to
  `speechTurn`; `processCallerUtterance` passes `true` after its own
  append; the direct media-streams call passes `false`. Remove the
  surface-detection guard added by #962 in favour of the flag. Keep the
  empty-utterance handling.
- **Patterns to follow:** the #962 coverage-table behaviour anchors.
- **Test scenarios:**
  - Happy path: media-streams utterance via adapter → exactly one
    `appendTranscript` with that text.
  - Happy path: direct `speechTurn` caller → exactly one append.
  - Happy path: Gather utterance → exactly one append (unchanged).
  - Edge: the caller genuinely repeats the same line twice → two
    entries.
  - Edge: empty utterance → no append.
- **Verification:** a recorded media-streams call's summary no longer
  shows doubled caller lines.

### U8. Incremental transcript persistence and webhook recovery
- **Goal:** transcripts survive restarts; the recording webhook never
  silently drops one (R8).
- **Requirements:** R8
- **Dependencies:** U7 (so persisted turns are not duplicated)
- **Files:** `packages/api/src/voice/call-transcript-turn.ts`,
  `packages/api/src/voice/pg-call-transcript-turn.ts` (idempotent
  `recordTurn` on `(call_sid, turn_index)`; migration in
  `packages/api/src/db/schema.ts` adding the unique index with
  `NOT VALID`-safe pattern for any CHECK), `packages/api/src/voice/voice-session-store.ts`
  (`appendTranscript` → also enqueue/persist the turn),
  `packages/api/src/app.ts` (recording webhook `:3864`: when the session
  is missing, load turns by call sid and continue ingestion),
  `packages/api/src/workers/transcript-ingestion-worker.ts` (skip turns
  already persisted), tests
  `packages/api/test/workers/transcript-ingestion-worker.test.ts`
  (extend), `packages/api/test/integration/call-transcript-turn-durability.test.ts`
  (new, Docker-gated).
- **Approach:** persist each turn as it is appended, tenant-scoped,
  fire-and-forget with error logging so the call path never blocks on
  the DB. The webhook's missing-session branch becomes: load persisted
  turns → build the ingestion payload → enqueue as today; only when no
  turns exist does it log a `transcript_unrecoverable` audit (never a
  bare return). The worker upserts, so end-of-call ingestion stays
  idempotent.
- **Patterns to follow:** `pg-call-transcript-turn.ts` column names;
  `docs/solutions/database-issues/mocked-pool-hides-real-schema-mismatch.md`
  (pin real columns in the integration test).
- **Test scenarios:**
  - Happy path: three turns appended → three rows; restart simulated by
    clearing the store → webhook rebuilds and enqueues ingestion with
    three turns.
  - Edge: end-of-call ingestion after incremental persistence → no
    duplicate rows.
  - Edge: no session and no rows → audit `transcript_unrecoverable`,
    200 to Twilio.
  - Error path: DB write fails mid-call → call continues, error logged,
    end-of-call ingestion still writes the full transcript.
  - Integration (Docker): real repo, real unique index, RLS keeps
    another tenant's turns invisible.
- **Verification:** deploy during a live dev call; the call's
  transcript is present afterwards.

### U9. `NOT VALID` on every CHECK constraint, pinned schema-wide
- **Goal:** no deploy re-validates a whole table for a CHECK it did not
  change (R9).
- **Requirements:** R9
- **Dependencies:** none
- **Files:** `packages/api/src/db/schema.ts` (the 26 sites listed in
  Issue 5), `packages/api/test/db/check-constraints-not-valid.test.ts`
  (new, schema-wide), `packages/api/test/db/dispatch-entity-type-vocabulary.test.ts`
  (generalise into a parameterised vocabulary-pin for
  `jobs_status_check`, `proposals_status_check`, `leads_source_check`
  and any other constraint whose vocabulary is a TS union),
  `docs/solutions/database-issues/replay-migrations-check-constraints-not-valid.md`
  (new learning).
- **Approach:** append `NOT VALID` to each bare `ADD CONSTRAINT … CHECK`
  in place (the migration-immutability test allows text edits only
  where its rules permit; if it forbids editing old migrations, add one
  new migration that drops and re-adds each with `NOT VALID` and let the
  runner's rewrite handle replay). The schema-wide test parses every
  `ADD CONSTRAINT` with `CHECK` and fails listing any without
  `NOT VALID`. The vocabulary-pin test asserts the final definition of
  each named constraint matches its shared TS union.
- **Patterns to follow:** `packages/api/test/db/dispatch-entity-type-vocabulary.test.ts`,
  `packages/api/test/db/migration-immutability.test.ts`,
  `packages/api/test/db/migration-discipline.test.ts`.
- **Test scenarios:**
  - Happy path: schema-wide test passes on the edited schema; fails
    red-first listing the 26 sites before the edit.
  - Edge: a future migration adding a bare CHECK → test names the line.
  - Integration (existing `migrate:dryrun` in CI): all migrations still
    apply on a fresh database.
- **Verification:** `npm run migrate:dryrun` clean; the CI
  migration-key guard green; prod deploy time for the migration step
  does not grow.

## Risks & Dependencies

- U3 and U4 need Railway, Stripe and Twilio dashboard access; they gate
  R2–R4 and cannot be verified from CI.
- U5 changes live-call teardown; a wrong default cuts real calls. Ship
  with a generous default and the audit reason so the first weeks can be
  reviewed.
- U9 may be blocked by the migration-immutability rule; the fallback
  (one new migration) is stated in the unit.
- U8 adds a write per caller turn; fire-and-forget keeps latency
  unaffected but must never throw into the call path.

## Open Questions (deferred to implementation)

- Exact wrap-up copy for the max-duration close, and whether the
  brand-voice configurator should own it.
- Whether the QA matrix secrets should target dev or a dedicated staging
  tenant set (the workflow's runbook must say).
- The migration-immutability test's allowance for editing old migration
  text (decides U9's shape).
- Whether `checkDuration()` has any external consumer in
  `packages/voice-eval` before deletion (re-grep at implementation).
