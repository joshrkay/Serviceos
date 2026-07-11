# Architecture Scorecard Re-grade — 2026-07-11

A nine-layer scorecard (graded from the 2026-07-10 verification run and the
subsequent architecture review) rated six layers below B+. Workstreams
WS1–WS6 landed the same day the review merged; WS7–WS10 close the residual
gaps. This document re-grades every layer against the original criticism,
with commit/file/test evidence. Target: **every layer B+ or better**.

Evidence commits (all on `main` or this branch):

| WS | Commit | Subject |
|----|--------|---------|
| WS1 | `01cf2aa` | Unified outbound SMS consent gate — one chokepoint, recipient classes, audited suppression |
| WS2 | `f7b6cb7` | PROCESS_ROLE split — gate worker loops so web and worker deploy separately |
| WS3 | `b621411` | Voice ingestion resilience — per-tenant realtime rollout, health circuit, degrade-to-Gather |
| WS4 | `8afaba1` | Approval loop hardening — dead voiceApprovable code removed, dictation approval tested, friendly challenge fallback |
| WS5 | `7d216c0` | In-call grounded quoting — live voice agent speaks catalog prices, never invented ones |
| WS6 | `689c3aa` | Digest supervisor-check reflection |
| — | `d3d118e` | Enforce RLS runtime role in prod (SEC-01/SEC-02) |
| — | `e5fc4c2` | Wire TCPA consent gate into outbound path |
| WS7 | `TBD-WS7` | Voice realtime auto-default + mid-call REST degrade to Gather |
| WS8 | `TBD-WS8` | Web/worker as the defined deploy topology |
| WS9 | `TBD-WS9` | D-015 platform kill switch + autonomous-booking digest visibility |
| WS10 | `TBD-WS10` | Learning-loop reflection — "instructions applied" digest section |

---

## 1. Action rail (intent → proposal → execution) — was A−, now **A−** (held)

Untouched by WS7–WS10 except additive gates. 33 proposal-driving intents, 42
typed Zod contracts (`packages/shared/src/contracts/`), ~30 handlers,
idempotency, chains, undo window all intact. `DATA-31` (`51894ac`,
`ab6cb82`) since made proposal execution atomic with external I/O outside
the transaction. WS9 adds a *stricter* gate (platform kill switch evaluated
before every other autonomous-lane gate) — no loosening.

## 2. Read-side voice (lookups) — was A−, now **A−** (held)

17 lookup skills unchanged. WS5 added the owner-only gate on
`lookup_catalog` (raw price-book recital restricted to caller-ID-verified
owner sessions, `test/telephony/lookup-catalog-owner-gate.test.ts`) —
a tightening, not a regression.

## 3. Voice ingestion — was C+, now **B+**

Criticism: *"Realtime Deepgram agent path exists but is flag-gated; the
legacy turn-based Gather adapter is still the default."*

- **WS3** (`b621411`): per-tenant `voice_realtime` flag **default ON**,
  process-wide health circuit (opens after 2 consecutive realtime failures,
  60s half-open), and a complete degrade-to-Gather decision table — every
  failure mode (missing prereqs, open circuit, flag-read error) lands on the
  proven Gather path. Runbook: `docs/runbooks/voice-realtime-rollout.md`.
- **WS7**: `TWILIO_MEDIA_STREAMS_ENABLED` unset now means **auto** — realtime
  is the default whenever the deployment is capable (Deepgram + ElevenLabs
  configured); explicit `false` remains the kill switch
  (`resolveMediaStreamsEnabled`, `packages/api/src/shared/config.ts`).
  Gather is no longer the deployment default on a capable stack.
- **WS7**: the one documented resilience hole — a mid-call realtime failure
  dropped the call — is closed: terminal mid-call failures now REST-redirect
  the live call to `POST /api/telephony/voice/gather-fallback`, which
  continues the *same session* on Gather TwiML (never `<Stream>`, so no
  redirect loop), audited as `voice.realtime.degraded_to_gather`, failing
  safe to the previous close-WS behavior.
- Tests: realtime-vs-Gather decision matrix
  (`test/telephony/media-streams/telephony-realtime-fallback.test.ts`),
  circuit + resilience suites, new redirect/route/adapter failure-path tests.

Remaining below A: no mid-call *handoff* between replicas (industry-standard
drain instead), realtime rollout still ultimately an ops env decision.

## 4. In-call intelligence (quote on the phone) — was C, now **B+**

Criticism: *"Voice captures intent only; the deterministic catalog resolver
runs operator-side after the call, not in the turn loop."*

- **WS5** (`7d216c0`) wired the same deterministic resolver
  (`packages/api/src/ai/resolution/catalog-resolver.ts`) into the **shared**
  `VoiceTurnProcessor` (`ai/voice-turn/create-voice-turn-processor.ts`,
  `groundVoiceEstimate`) — so it runs in the live turn loop on **both**
  transports (realtime Media Streams and legacy Gather).
- Money safety preserved end-to-end: voice carries line-item *descriptions*
  only (never an LLM price); catalogued lines speak the catalog price;
  uncatalogued/ambiguous lines speak **no number** and cap confidence below
  the auto-approve threshold (`quote-readback.ts`, `session-catalog.ts`,
  `UNCATALOGUED_CONFIDENCE_CAP`); catalog preload timeout degrades to
  silence, never fabrication.
- 25 tests: `voice-turn-grounded-estimate.test.ts`, `quote-readback.test.ts`,
  `session-catalog.test.ts`, `estimate-grounding-idempotent.test.ts` (voice
  and operator paths agree).

Remaining below A: grounding covers `draft_estimate` only; multi-line quotes
speak the total only; quantity fixed at 1 on the spoken path. These are
deliberate money-safety scoping choices, not correctness gaps.

## 5. Approval loop — was C+, now **B+**

Criticism: *"no voice read-back/approve, and `voiceApprovable === false`
proposals punt to a screen."*

- The `voiceApprovable` field was **dead mock-only scaffolding** (no API code
  ever set it); WS4 (`8afaba1`) deleted it. The real engine predates the
  scorecard: `ai/tasks/proposal-approval-task.ts` — payload-derived spoken
  read-back (`composeReadback`), strict deterministic confirmation, spoken
  PIN challenge for money/irreversible classes, multi-turn voice edit
  (`startVoiceEdit`) — wired on **both** telephony transports and gated to
  caller-ID-verified owner sessions.
- Coverage by action class: all ~30 capture-class proposal types are fully
  voice-approvable; money/irreversible types voice-approve behind a
  per-tenant spoken PIN (`escalation_settings.voice_approval_challenge`).
- The "punt" is no longer a screen: when no PIN is configured (or after
  challenge lockout) the flow texts a **one-tap approve link** and says so in
  a friendly line (WS4). Web/in-app assistant voice deterministically refuses
  approval (UB-B3) — approval by voice is deliberately owner-telephony-only.
- Tests: `proposal-approval-task.test.ts` (1,779 lines),
  `voice-approval-gather.test.ts` + `voice-edit-gather.test.ts` (end-to-end
  on the telephony channel), SMS `reply-handler.test.ts`,
  `batch-approve.test.ts`.

Remaining below A: money-class voice approval requires one-time PIN setup;
no voice-quality-corpus scenario reaches the approval dialogue (text-mode
driver limitation).

## 6. Learning loop — was B, now **B+/A−**

Criticism: *"digest reflection sections still missing."*

Four reflection sections now compute, render on the owner's nightly SMS, and
render on the web digest page (`digest/digest-service.ts`,
`pages/digest/DigestPage.tsx`), each omitted when empty:

1. **What I wasn't sure about** (N-005) — confidence-marked proposals + outcome.
2. **What I learned** (N-005) — correction lessons applied today
   (`learning/corrections/`, `findAppliedForDay`).
3. **Supervisor checks** (WS6) — proposals the supervisor agent reviewed and
   how many it flagged (`ai/supervisor/reviews-repo.ts findForDay`).
4. **Instructions applied** (WS10) — which standing instructions shaped
   today's drafts and how many drafts each touched, read from the
   `payload._meta.appliedStandingInstructions` stamp the drafting tasks
   already persist (no separate bookkeeping), with a partial index for the
   day query.

Plus (WS9) the **auto-booked** line — the D-015 autonomous lane reports its
own activity to the owner nightly. Standing instructions ("from now on…"),
correction lessons, and `ai_run` persistence were already wired.

Tests: `digest-service.test.ts` describe blocks per section,
`DigestPage.test.tsx`, integration column-pinning for the new day queries.

## 7. Safety rails for autonomy — was D+, now **B+**

Criticism: *"RLS is dormant at runtime, the TCPA/DNC consent gate has zero
call sites, and D-015 already carved an auto-approve exception."*

- **RLS is enforced at runtime, and prod cannot boot without it.**
  Migrations 217–220 provision `rls_app_runtime` (NOLOGIN, RLS-subject, no
  BYPASSRLS); `applyTenantContext` (`db/rls-runtime-role.ts`) issues
  `SET LOCAL ROLE rls_app_runtime` + `app.current_tenant_id` inside
  `PgBaseRepository.withTenantTransaction` — every repo path. SEC-01
  (`d3d118e`) makes `RLS_RUNTIME_ROLE=true` **hard-required** in
  prod/staging with no opt-out flag. Backstop proven by
  `test/integration/rls-runtime-backstop-repo.test.ts` (filter-less
  cross-tenant read blocked at the DB), plus the leak/catalog/pgbouncer
  suites.
- **FORCE RLS "gap" was a mis-grade**: the scorecard read the early CREATE
  migrations (002–011, ENABLE only) without seeing migration
  `130_force_rls_missing_tables` (+ `044` for AI artifacts), which already
  FORCE tables including `users`, `audit_events`, `ai_runs`, `messages`,
  `conversations`, `files`, `voice_recordings`.
  `test/integration/rls-force-catalog.test.ts` asserts at runtime that every
  `tenant_id` table is ENABLE+FORCE except exactly the two documented
  exemptions (`oauth_states`, `platform_deprovision_log`).
- **TCPA/DNC now has call sites and fails closed in prod.** The voice gate
  (`voice/outbound-consent.ts`: format → tenant DNC list → consent status,
  fail-closed on unknown customer, audited suppression) is wired into the
  only outbound-call surface (`telephony/outbound-call-service.ts`). WS1
  (`01cf2aa`) wraps the single SMS provider construction site in
  `GatedMessageDelivery` — every product SMS passes one consent+DNC
  chokepoint. `TCPA_CONSENT_ENFORCEMENT` resolves to `block` in prod/staging
  when unset.
- **D-015 is now bounded, killable, and owner-visible** (WS9). The carve-out
  was already narrow (default-off per tenant, `create_appointment`/
  `create_booking` only, 0.90 confidence floor enforced in code, held slot +
  verified customer + no risk flags, undo SMS). WS9 adds
  `AUTONOMOUS_BOOKING_DISABLED` — a platform-wide kill switch evaluated as
  the **first** gate with its own audited reason (`platform_disabled`) — and
  the nightly digest "auto-booked" line, so the lane cannot operate
  invisibly. D-015 amendment recorded in `docs/decisions.md`.

Remaining below A: D-015 remains an intentional exception to
proposal-first; RLS depends on migrations having run with a CREATEROLE
principal (self-degrading otherwise, surfaced by the boot probe).

## 8. Operational resilience for live calls — was C−, now **B+**

Criticism: *"One process runs HTTP + ~30 worker loops + voice sessions;
every deploy can drop a live call."*

- **Graceful drain (ARCH-02/U-P4a, pre-WS)**: SIGTERM/SIGINT **and**
  `uncaughtException` route through one drain path — `/ready` 503s, new WS
  upgrades rejected (503 + Retry-After), background intervals cleared, then
  up to `DRAIN_TIMEOUT_MS` (25s) waiting for live voice sessions before
  teardown, with a 30s force-exit backstop. `railway.toml`
  `overlapSeconds=35` keeps the old replica serving past the backstop —
  deploys no longer drop live calls. Tests:
  `test/app/graceful-shutdown.test.ts`, `test/ws/drain-state.test.ts`.
- **WS2** (`f7b6cb7`): `PROCESS_ROLE` (`web|worker|all`) gates every worker
  loop; `pg_try_advisory_lock` leader election keeps `all` correct across
  replicas (`test/app/process-role.test.ts`).
- **WS8**: the split is now the **defined deploy topology**, not an option —
  `railway.worker.toml` (no `preDeployCommand`; migrations run once on web,
  which deploys first), `PROCESS_ROLE=web`/`worker` documented as service
  variables in `docs/deployment.md` + `docs/prod-env-checklist.md`, and
  worker-role processes no longer construct the voice WS stack at all.
  Worker deploys can no longer cycle the voice-serving process.
- Multi-replica correctness prerequisites are boot-enforced (ARCH-01:
  `NUM_REPLICAS>1` without `REDIS_URL` fails boot).

Remaining below A: no live-call migration between replicas (drain is the
mitigation); the split still requires the operator to create the second
Railway service.

## 9. Regression protection for voice — was A−, now **A−** (held)

The cassette-based voice-quality harness with LLM-judge grading
(`test/voice-quality/`, layer-2 audio-mode driver with 2-of-3 voting,
TTFA/completion graders) is untouched by WS7–WS10. New voice behavior added
in this wave carries its own handler-level tests (grounded estimate,
quote-readback, redirect/fallback, approval dialogues), keeping the
harness's corpus green.

---

## Result

| Layer | Was | Now |
|---|---|---|
| Action rail | A− | A− |
| Read-side voice | A− | A− |
| Voice ingestion | C+ | **B+** |
| In-call intelligence | C | **B+** |
| Approval loop | C+ | **B+** |
| Learning loop | B | **B+/A−** |
| Safety rails | D+ | **B+** |
| Operational resilience | C− | **B+** |
| Voice regression protection | A− | A− |

All nine layers at B+ or better.
