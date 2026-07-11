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
| WS7 | `2ef8100` | Voice realtime auto-default + mid-call REST degrade to Gather |
| WS8 | `d020335` | Web/worker as the defined deploy topology |
| WS9 | `bc29696` | D-015 platform kill switch + autonomous-booking digest visibility |
| WS10 | `eed44ea` | Learning-loop reflection — "instructions applied" digest section |
| WS11 | `c51b56e` | Structural audit — execution state changes cannot commit without their audit row |
| WS12 | `45ddf3a` | One consent model — cross-channel revocation on the consent_events ledger (D-017) |
| WS13 | `83caa13` | Integration suite runs under the RLS runtime role by default in CI |
| WS14 | `25f428c` | Dedicated 'voice' process role + railway.voice.toml + provisioning VOICE_PUBLIC_URL |
| WS15 | `105ebe4` | Platform SLO monitor + drain-abandonment alarm — alerting a human |
| WS16 | `a381da5`/`f0de11d`/`e431424` | Circuit fed by real call outcomes; establishment unified; transport drift converged |
| WS17 | `0151e8d` | In-call quotes: quantity, per-line read-back, invoice parity |
| WS18 | `5e4727c`/`6e18e49`/`4a0f9f3`/`020813f` | Post-quote FSM + refinement; consent capture + hold; D-018 lane; wired autonomous close |
| WS19 | `80cd860` | Batch voice approval sessions — one call clears the queue |
| WS20 | `48a5501`/`2e77785` | Per-SKU correction capture; correction-repetition meta-proposals |
| WS21 | `b58bf22`/`b296e01` | Enrolled hashed voice PIN; harness reaches approval + quoting dialogues |
| WS22 | `5c8cd02` | Honest flaggedFixed + weekly same-mistake-twice rate |
| WS23 | `ecc43da` | Proof layer: CI reality + 15-minute E2E unlock runbook |

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

## 3. Voice ingestion — was C+, now **A−**

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

**A-grade additions (third wave, WS16):** the health circuit is fed by REAL
call outcomes — success recorded only at clean established close (the
establish-then-die trap that could never trip a consecutive breaker is
fixed and regression-pinned against a real circuit), one latched vote per
call leg, deepgram-reopen failures reclassified transport_failure;
runtime-verified live (two mid-call failures → third call routed to
Gather). The duplicated ~260-line Gather establishment is unified with the
stream path (pure refactor pinned by 412 unmodified tests), and the
silently-drifted features converged — realtime calls now fire owner
incoming-call notifications and customer-timeline entries. voice_realtime
reframed kill-switch-only. Remaining below a flat A: no mid-call replica
handoff (drain + the WS14 rarely-deployed voice service are the
mitigation).

## 4. In-call intelligence (quote on the phone) — was C, now **A−**

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

**A-grade additions (third wave, WS17 + WS18):** quantity-aware quotes
('three smoke detectors' → 3 × catalog unit; sizes like '2 inch pipe'
never misparse), per-line read-back for all-catalogued quotes up to 3
lines (mixed quotes keep the all-or-nothing no-number rule), invoice
grounding parity (unitPriceCents contract, cents-mapping pinned). Mid-call
refinement: 'actually make it two of those' re-grounds and re-speaks the
total in place (max 3, then owner fallback) — and the discard bug (a
post-quote 'yes, book it' previously THREW AWAY the quote) is fixed and
regression-pinned. The close itself: D-018's guardrailed autonomous close
(default-off tenant flag, grounded-clean-only, cap, strict confirm,
on-call SMS consent captured to the ledger, live hold, owner UNDO SMS)
executes draft_estimate → send_estimate → create_booking before hangup,
with the one-tap owner close as the always-available fallback. Proven on
real Postgres end-to-end. Remaining below a flat A: autonomous close
requires tenant opt-in by design; the deposit rides the approval link
rather than a separate texted link.

## 5. Approval loop — was C+, now **A−**

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
  per-tenant spoken PIN. WS21a made that PIN a real **enrolled** credential:
  it is captured via `PUT /api/settings/voice-approval-pin`, hashed at rest
  (HMAC-SHA256, tenant-salted — `settings/voice-approval-pin.ts`), stored as
  `escalation_settings.voice_approval_pin_hash`, and never echoed back. The
  verify seam checks the hash first and falls back to the deprecated
  plaintext `voice_approval_challenge` so any tenant who set the interim value
  keeps working with no migration. (Onboarding-step capture is a stated
  follow-up — enrollment today is the settings route; a spoken PIN would land
  plaintext in the onboarding proposal payload/transcript, so it was
  deliberately kept off the conversation path.)
- The "punt" is no longer a screen: when no PIN is enrolled (or after
  challenge lockout) the flow texts a **one-tap approve link** and says so in
  a friendly line (WS4). Web/in-app assistant voice deterministically refuses
  approval (UB-B3) — approval by voice is deliberately owner-telephony-only.
- Tests: `proposal-approval-task.test.ts` (1,779 lines),
  `voice-approval-gather.test.ts` + `voice-edit-gather.test.ts` (end-to-end
  on the telephony channel), SMS `reply-handler.test.ts`,
  `batch-approve.test.ts`.

WS21b closed the corpus gap: the voice-quality harness now grades approval and
quoting conversations like everything else. The TextModeDriver stamps
`ownerSession` (caller-ID match or an explicit fixture flag) and routes
approve/reject/edit + pending-dialogue continuations through the SAME
`createVoiceTurnProcessor` the telephony transports use (the voice-action-router
worker refuses those intents), and the fixtures schema grew
`proposals`/`catalog`/owner-PIN so a script can seed a pending proposal, a
grounded catalog, and a money-class PIN. New corpus scenarios: owner batch
approval walk, money-class approval with the WS21a PIN challenge, grounded quote
against a catalog fixture, and a quantity variant.

**A-grade additions (third wave, WS19 + WS21):** batch voice sessions —
'You have four waiting. First: estimate for Lopez, \$450.00 — approve it?
… Next: …' — one call clears the queue over the unchanged single-item
engine (money items get the per-item challenge, never silently skipped
like SMS APPROVE ALL; lockout defers them to one-tap links while capture
items keep approving). Money-class identity is now an ENROLLED voice PIN:
HMAC-hashed at rest, settings-route enrollment (never echoed), legacy
plaintext honored as fallback — replacing the config nobody set. The
voice-quality corpus now reaches the approval dialogue (recorded
scenarios: batch walk, PIN challenge). Remaining below a flat A:
onboarding-step PIN capture is a stated follow-up (the conversational
proposer would land the PIN in plaintext transcripts); caller-ID stays the
deliberate base identity for capture-class.

## 6. Learning loop — was B, now **A**

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

**A-grade additions (third wave, WS20 + WS22):** corrections now change the
SYSTEM, not just the log — per-SKU price-correction identity is actually
captured (the stale onExecuted wiring that silently discarded catalogItemId
is fixed), and after the third same-target correction the AI proposes the
catalog update itself (update_catalog_item proposal in the normal inbox,
evidence attached, deduped, rejection-respecting; repeated banned-phrase
removals propose the standing instruction). flaggedFixed is honest — a
flagged proposal counts fixed only when the owner actually edited it after
the flag ('Checked: N, M flagged, K fixed.') — and the weekly feedback
email carries the metric that proves learning is real: 'Of 6 corrections
this week, 2 were repeats of an earlier correction (33%).'

Plus (WS9) the **auto-booked** line — the D-015 autonomous lane reports its
own activity to the owner nightly. Standing instructions ("from now on…"),
correction lessons, and `ai_run` persistence were already wired.

Tests: `digest-service.test.ts` describe blocks per section,
`DigestPage.test.tsx`, integration column-pinning for the new day queries.

## 7. Safety rails for autonomy — was D+, now **A−**

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

**A-grade additions (2026-07-11, second wave):**

- **Structural audit, not conventional** (WS11 `c51b56e`): the proposal
  execution engine — the agent-action chokepoint — now writes its
  `proposal.executed`/`proposal.execution_failed` audit event in the SAME
  transaction as the state change (`commands/command-runner.ts
  executeAudited`, audit descriptor required at compile time; `auditRepo` a
  required executor constructor param). Proven on real Postgres: a failed
  audit insert rolls back the entire execution unit. Before this, the
  executor emitted zero audit events and audit writes could land on a
  separate connection.
- **One consent model** (WS12 `45ddf3a`, D-017): both outbound gates derive
  from the `consent_events` ledger via one resolver. Contact-kind
  revocations (`sms`/`marketing`) suppress BOTH channels from either
  direction; grants never cross (an SMS START no longer manufactures TCPA
  voice consent — the rollup leak is closed); `recording` objections stay
  voice-scoped. 23-case matrix + real-Postgres cross-channel integration
  proof.
- **RLS proven on every PR** (WS13 `83caa13`): `npm run test:integration`
  (what PR CI runs) now sets `RLS_RUNTIME_ROLE=true` — the full 696-test
  integration suite executes under the least-privilege `rls_app_runtime`
  role on every merge; verified green both ways against real Postgres.

Remaining below a flat A: D-015 remains an intentional (bounded, killable,
owner-visible) exception to proposal-first; the structural-audit wrapper
covers the execution chokepoint — route-layer mutations still audit by
convention.

## 8. Operational resilience for live calls — was C−, now **A−** (code/config complete; final grade contingent on the operator cutover)

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

**A-grade additions (2026-07-11, second wave):**

- **Dedicated voice service** (WS14 `25f428c`): `PROCESS_ROLE=voice` — full
  HTTP + media-streams WS, zero worker loops — with `railway.voice.toml`
  (`overlapSeconds=35`, no migrations). Twilio number webhooks point at the
  voice domain, so web/worker deploys never touch live calls; the voice
  service deploys rarely and drains. The onboarding provisioning worker now
  targets `VOICE_PUBLIC_URL` for new numbers' voice webhooks, so the
  property holds for post-cutover tenants automatically. Runtime-verified:
  voice-role boot serves signed `/voice` → `<Connect><Stream/>` with the WS
  handshake accepted and zero background intervals.
- **SLOs with teeth** (WS15 `105ebe4`): a leader-locked monitor evaluates
  call completion rate (real `voice_sessions` outcomes), queue staleness,
  and sweep lag every 5 minutes and ALERTS A HUMAN — Sentry error event
  always, operator SMS when `ALERT_SMS_TO` is set, per-rule cooldown. Drain
  windows that expire with live calls now emit a durable drain-abandonment
  alarm (counter + Sentry with callSids). Turn-latency P95 is deliberately
  not claimed: no production histogram exists and the runbook records where
  it belongs. `docs/runbooks/slo-alerts.md`.
- **"Actually run the split"** — everything scriptable is in the repo
  (three service configs, role gates, alarms); the irreducible remainder is
  ~15 minutes of Railway dashboard work captured step-by-step in
  `docs/runbooks/deploy-topology-cutover.md` (`2e09211`). **This layer's A
  is contingent on the operator executing that cutover** — until then
  production runs the (fully supported) single-service shape.

Remaining below a flat A: no live-call handoff between replicas (drain +
rare voice deploys are the mitigation); turn-latency SLO pending a safe
measurement seam.

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
| Voice ingestion | C+ | **A−** |
| In-call intelligence | C | **A−** |
| Approval loop | C+ | **A−** |
| Learning loop | B | **A** |
| Safety rails | D+ | **A−** |
| Operational resilience | C− | **A−** (operator cutover pending) |
| Voice regression protection | A− | A− |

All nine layers at A− or better (the two original A− holds unchanged), and
§9's harness gained the reach it lacked — approval and grounded-quote
corpus scenarios (WS21b). The proof layer's reality is recorded in
docs/runbooks/proof-layer.md: integration tests gate every PR under RLS
already; the browser-journey unlock is a 15-minute operator checklist.
