# Wave C — Bad-Day Recovery

**Goal:** Cover the four "Mike bad-day" failure modes from PRD v2 §9 — tech no-show, public 1-star fallout, dropped intake call, and vulnerable caller misrouting — so that the system catches each one without depending on the owner being awake at the right minute. After Wave C merges, the bad-day timeline (11:00am vulnerable caller → 1:30pm dropped call → 5:00pm tech-out + 1-star review) is fully recoverable: every event triggers an owner-approvable proposal in the inbox with a brand-voice customer message already drafted.

**Pre-Wave-C requirements** (Wave 0 + Wave 1 — must merge first; 6 shared-infra freezes):
- **B1 — Brand-voice prompt (P4-015)** — `brand_voice_v1` registered in `packages/api/src/ai/prompt-registry.ts` + `composeBrandVoiceMessage()` helper. Three of the four stories draft customer-facing messages and will produce off-brand text without this. **Blocks P6-028, P7-026, P8-015.**
- **B2 — APPROVE ALL endpoint** — `approveProposalsBatch()` in `packages/api/src/proposals/actions.ts` + POST `/api/proposals/approve-batch`. Without this, the 5pm scenario (tech goes out, 4 customers need rescheduling) is 4 separate owner taps. **Blocks P6-028.**
- **B3 — Inbound SMS content dispatch** — refactor `webhooks/routes.ts:1243` `recordTwilio('sms')` to call new `packages/api/src/sms/inbound-dispatch.ts`. Today the webhook records the message and 200s; the body is never parsed. **Blocks P6-028 and any future inbound-SMS feature.**
- **B4 — `users.mobile_number` field** — migration 101 + repo helper `findByMobileNumber(tenantId, e164)`. Needed for tech identity binding and owner-cell paging. **Blocks P6-028 and P8-016.**
- **B5 — Per-caller rate-limit utility** — `packages/api/src/shared/rate-limit/phone-rate-limit.ts` + migration 102. PG sliding-window so a serial-dropper doesn't get 6 recovery SMSes. **Blocks P8-015.**
- **B6 — `LinkableEntityType` expansion** — extend enum in `packages/api/src/conversations/linkage.ts` to add `voice_session` and `sms_conversation`. No migration (`entity_type` is TEXT). **Blocks P8-015 conversation threading.**

If any of those six are not green, **do not dispatch the Wave C stories** — the brand-voice drafts will be empty, the APPROVE ALL UX is a 4-tap regression, and the dropped-call worker will rate-spam.

## Wave C story set

| Story | Layer | Story body | Dispatch addendum |
|---|---|---|---|
| **P6-028** | Tech / SMS | (this wave plan) | `p6-dispatch-addendum.md` (to extend) |
| **P7-026** | Reputation | (this wave plan) | `p7-dispatch-addendum.md` (new — create) |
| **P8-015** | Voice / Intake | (this wave plan) | `p8-dispatch-addendum.md` (to extend) |
| **P8-016** | Voice / Triage | (this wave plan) | `p8-dispatch-addendum.md` (to extend) |

P4-015 (brand voice), P2-002 (proposal contracts), P1-008 (tech assignment), P2-034 (SMS transport), P7-001 (Twilio), P8-001 (inbound calling agent), P0-014 (webhook base), P0-009 (async worker), P1-001 (customer entity) are cited as dependencies in story bodies; B1–B6 cover the subset that is actually MISSING or PARTIAL in current code. Other deps are satisfied by existing infra (see status tables per story).

## Dispatch order (with parallelism)

```
                ┌─────────────────────────────────┐
                │ Wave 0 — three blockers parallel│
                │ B1 brand-voice   (1 agent)      │
                │ B4 user mobile   (1 agent)      │
                │ B6 link entity   (1 agent)      │
                └────────────┬────────────────────┘
                             │
                ┌────────────▼────────────────────┐
                │ Wave 1 — three blockers parallel│
                │ B3 inbound-SMS dispatcher       │
                │ B2 APPROVE ALL endpoint         │
                │ B5 phone rate-limit             │
                └────────────┬────────────────────┘
                             │
              ┌──────────────┼──────────────┬──────────────┐
              ▼              ▼              ▼              ▼
            ┌──────┐      ┌──────┐       ┌──────┐       ┌──────┐
  Wave C1   │P8-015│      │P6-028│       │P7-026│       │P8-016│  ← all four parallel
            └──────┘      └──────┘       └──────┘       └──────┘
              ~3 hr         ~4 hr          ~6 hr          ~4 hr
                                          (3 PRs)
```

**Wave 0 — three agents in parallel** (no inter-dependencies; all touch different files):
- **B1** modifies `packages/api/src/ai/prompt-registry.ts` + new `packages/api/src/ai/brand-voice/composer.ts`
- **B4** adds migration `101_users_mobile_number` + `packages/api/src/users/user.ts` + `pg-user.ts`
- **B6** extends `packages/api/src/conversations/linkage.ts` + validator

**Wave 1 — three agents in parallel** (also disjoint files):
- **B3** modifies `packages/api/src/webhooks/routes.ts` + new `packages/api/src/sms/inbound-dispatch.ts`
- **B2** modifies `packages/api/src/proposals/actions.ts` + `packages/api/src/routes/proposals.ts`
- **B5** adds migration `102_phone_rate_limits` + new `packages/api/src/shared/rate-limit/phone-rate-limit.ts`

**Wave C1 — four agents in parallel** (after Wave 0+1 merge; allowed-files-disjoint per PRD specs):
- **P8-015** smallest surface; only needs B1+B5+B6 + the verified `finalizeTerminalOutcome` hook
- **P6-028** needs B1+B2+B3+B4 — owner UX collapses to one tap
- **P7-026** heaviest; needs only B1 of the new blockers. **Split into 3 sequential PRs:** (a) poll + model, (b) classifier + match, (c) proposal + credit + execution
- **P8-016** needs B4 + a customer-schema migration (nullable, no backfill)

**Total wall-clock:** ~3 wall-clock waves (Wave 0 → Wave 1 → Wave C1). Estimated ~6 hours dispatcher-time including review/merge gates between waves.

## Migration reservations

Refresh against `packages/api/src/db/schema.ts` before dispatching. Latest used key on main: `100_payments_refund_tracking` (verified). Reservations:

| Migration key | Owner | Domain |
|---|---|---|
| `101_users_mobile_number` | B4 | `ALTER TABLE users ADD COLUMN mobile_number TEXT` + partial UNIQUE `(tenant_id, mobile_number) WHERE mobile_number IS NOT NULL` |
| `102_phone_rate_limits` | B5 | Sliding-window counter table `(tenant_id, scope, key, window_start, count)` |
| `103_tech_unavailable_blocks` | P6-028 | PG-backed equivalent of the existing in-memory `availability/unavailable-block.ts` |
| `104_tech_status_today` | P6-028 | Daily idempotency key `(tenant_id, technician_id, local_date, status, source_message_sid, recorded_at)` |
| `105_google_reviews` | P7-026 (PR a) | `(id, tenant_id, source, source_review_id UNIQUE, rating, text, reviewer_display_name, posted_at, classification, matched_customer_id NULL→customers, processed_at, created_at)` |
| `106_review_poll_state` | P7-026 (PR a) | `(tenant_id PK, last_polled_at, last_cursor, backoff_until, consecutive_429_count)` |
| `107_service_credits` | P7-026 (PR c) | `(id, tenant_id, customer_id, amount_cents, source, source_entity_id, issued_at, redeemed_at NULL)` + 12-month index |
| `108_dropped_call_recoveries` | P8-015 | `(id, tenant_id, voice_session_id UNIQUE, caller_e164, scheduled_for, sent_at NULL, suppressed_reason NULL, sms_message_sid NULL, created_at)` |
| `109_customer_vulnerability_fields` | P8-016 | `ALTER TABLE customers ADD COLUMN date_of_birth DATE, ADD COLUMN account_type TEXT CHECK (account_type IN ('residential','b2b'))` |
| `110_weather_cache` | P8-016 | `(latitude_round, longitude_round, fetched_at, max_temp_f_24h, min_temp_f_24h, raw JSONB, PRIMARY KEY (latitude_round, longitude_round))` — no tenant scope |
| `111_vulnerability_signals` | P8-016 | `(id, tenant_id, voice_session_id, customer_id, signal_type, detail, weight, created_at)` for analytics + post-incident review |

**Rule (from runbook):** the wave coordinator confirms these are still free in `packages/api/src/db/schema.ts` immediately before dispatching. If main has advanced past any of them, bump.

## What each story delivers

### B1 — Brand-voice composer (P4-015 minimum subset)

**Why:** P6-028, P7-026, P8-015 all draft customer-facing text. Today there is no locked brand-voice prompt — the prompt registry exists at `packages/api/src/ai/prompt-registry.ts` but has no `brand_voice` entry, and there are no golden examples. Without B1, three of the four stories ship with whatever the LLM defaults to per call.

**Outcome:** `composeBrandVoiceMessage({tenantId, intent, context, maxChars})` returns `{text, promptVersionId}`. Tone JSONB lives on `tenant_settings` (already exists via migration 090). Defer the full golden-example dataset to a follow-up — V1 ships with the prompt registered and a smoke test that produces non-empty text for each intent.

**Allowed files:** `packages/api/src/ai/brand-voice/**`, `packages/api/src/ai/prompt-registry.ts`. Verification: `npx vitest --grep "brand-voice"` covers prompt selection by intent and tenant-tone merge.

### B2 — APPROVE ALL endpoint

**Why:** the 5pm tech-out scenario fires N reschedule proposals at once. With N≥3 the owner UX must collapse to one tap or P6-028's whole point evaporates.

**Outcome:** `approveProposalsBatch(proposalRepo, tenantId, proposalIds[], actorId, actorRole, auditRepo)` in `packages/api/src/proposals/actions.ts` re-uses the existing `approveProposal()` per ID, accumulates `{approved: string[], failed: {id, reason}[]}`, atomic per-proposal. New POST `/api/proposals/approve-batch` in `packages/api/src/routes/proposals.ts`. The 3+ threshold for showing APPROVE ALL is client-side.

**Allowed files:** `packages/api/src/proposals/actions.ts`, `packages/api/src/routes/proposals.ts`. Verification: vitest covers partial-success (one ID stale, others succeed), audit one row per approve, RLS enforced.

### B3 — Inbound SMS content dispatch

**Why:** `webhooks/routes.ts:1243` `recordTwilio('sms')` today verifies the Twilio signature, records the receipt, and returns 200. The message body is never read. P6-028 needs keyword routing on `OUT|SICK|UNAVAILABLE`; future stories will register more.

**Outcome:** new `packages/api/src/sms/inbound-dispatch.ts` exports `dispatchInboundSms({tenantId, fromE164, body, messageSid})` returning `{handled, handler}`. Internal keyword router. P6-028's tech-status module registers its keywords. The `recordTwilio('sms')` handler in `webhooks/routes.ts` invokes the dispatcher after `markProcessed`.

**Allowed files:** `packages/api/src/sms/inbound-dispatch.ts`, `packages/api/src/webhooks/routes.ts`. Verification: unit test for the keyword router; webhook test exercising the existing signature + receipt path stays green and additionally calls the dispatcher.

### B4 — `users.mobile_number` field

**Why:** P6-028 binds the inbound tech-status SMS to a registered tech mobile (anti-spoofing). P8-016 patches an emergency through to the owner's cell. Both need a new column on `users`.

**Outcome:** migration `101_users_mobile_number` adds `mobile_number TEXT` + `CREATE UNIQUE INDEX users_mobile_unique ON users (tenant_id, mobile_number) WHERE mobile_number IS NOT NULL`. `packages/api/src/users/user.ts` adds `mobileNumber?: string`. `pg-user.ts` adds `findByMobileNumber(tenantId, e164)`. E.164 normalization helper colocated.

**Allowed files:** `packages/api/src/db/schema.ts` (one new key), `packages/api/src/users/user.ts`, `packages/api/src/users/pg-user.ts`. Verification: migration replay + uniqueness violation test.

### B5 — Per-caller rate-limit utility

**Why:** P8-015 sends a recovery SMS within 60s of a drop. A caller who keeps dropping (bad signal) must not get 6 SMSes in 5 minutes. The existing `express-rate-limit` is HTTP-level on inbound API calls; this is a per-domain limit keyed on E.164.

**Outcome:** `packages/api/src/shared/rate-limit/phone-rate-limit.ts` exports `tryConsume(scope, key, limit, windowMs) → boolean`. PG sliding-window backed by `phone_rate_limits (tenant_id, scope, key, window_start, count)` + index. Migration `102_phone_rate_limits`. Generic — not coupled to dropped-call.

**Allowed files:** `packages/api/src/shared/rate-limit/**`, `packages/api/src/db/schema.ts` (one new key). Verification: vitest covers consume → consume → deny, expiry behavior across `windowMs`, concurrent-write safety.

### B6 — `LinkableEntityType` expansion

**Why:** P8-015's recovery SMS must thread to the original voice intake so a subsequent SMS reply continues the same conversation. Today `LinkableEntityType` is `'customer' | 'job' | 'estimate' | 'invoice'` — no `voice_session` or `sms_conversation`.

**Outcome:** extend the union and the validator in `packages/api/src/conversations/linkage.ts`; update `pg-conversation-link.ts`. No migration — `entity_type` is `TEXT`.

**Allowed files:** `packages/api/src/conversations/linkage.ts`, `packages/api/src/conversations/pg-conversation-link.ts`. Verification: vitest round-trip per new entity type; existing tests stay green.

### P6-028 — Tech "I'm out today" SMS

**Why:** the 5pm scene from PRD v2 §9 Mike bad-day. Today there is no way for Carlos to mark himself out short of calling the owner; if he no-shows, the four customers on his afternoon route find out when the truck doesn't arrive. Brand-impact: severe.

**Outcome:** tech replies `OUT|SICK|UNAVAILABLE` from registered mobile → status persisted for today (auto-clears via the daily key) → reschedule proposals fire for each remaining appointment with brand-voice customer SMS pre-drafted → owner taps APPROVE ALL.

**Files to create:** `packages/api/src/sms/tech-status/keyword-router.ts`, `handler.ts`, `idempotency.ts`; `packages/api/src/scheduling/reschedule/from-tech-out.ts`, `customer-message-draft.ts`; `packages/shared/src/contracts/tech-status-event.ts`.

**Files to modify:** `packages/api/src/users/pg-user.ts` (already extended by B4 — only the tech-status handler invokes `findByMobileNumber`); `packages/api/src/availability/unavailable-block.ts` adds PG-backed `pg-unavailable-block.ts` (keep in-memory for tests); B3's dispatcher receives the keyword registration.

**Allowed files:** per PRD — `packages/api/src/sms/tech-status/**`, `packages/api/src/scheduling/reschedule/**`, `packages/api/src/db/schema.ts` (keys 103+104), `packages/shared/src/contracts/tech-status-event.ts`, plus `packages/api/src/availability/pg-unavailable-block.ts`.

**Forbidden files:** everything else under `packages/api/src/users/`, `packages/api/src/webhooks/routes.ts` (B3 owns the edit), `packages/api/src/proposals/actions.ts` (B2 owns the edit).

**Verification gate:**
```bash
cd packages/api && npx tsc --project tsconfig.build.json --noEmit
cd packages/api && npm test -- --grep "P6-028"
```
Required tests: tech OUT → status + N proposals; APPROVE ALL collapses; brand voice invoked once per proposal; wrong-number rejected; second OUT same day no-op; midnight clear (new `local_date` row is independent — no cron needed).

### P7-026 — Google Business review monitoring + draft response

**Why:** the 5pm follow-up scene — Mrs. Donovan posts a 1-star after Carlos no-shows. Without monitoring, the owner sees it three days later (if ever) and the public response window has closed.

**Outcome:** 15-min poller per tenant → classify praise / specific_complaint / vague_complaint / wrong_business → conservatively match reviewer to a customer → draft public response (brand voice, PII-redacted) + private SMS/email + service-credit suggestion ($25/$50/$100, capped at $100/12mo) → `review_response_proposal` with three independently-approvable components.

**Files to create:** entire `packages/api/src/reputation/` (review model, pg-review, google-business-client, classifier, match-customer, pii-redact, draft-public-response, draft-private-followup, credit-tier, build-proposal); `packages/api/src/workers/google-reviews.ts`; `packages/api/src/proposals/execution/review-response-handler.ts`; `packages/shared/src/contracts/review-response-proposal.ts`.

**Files to modify:** `packages/api/src/proposals/proposal.ts` adds `'review_response_proposal'` to `ProposalType` (forces exhaustive switch updates — bucket as `'comms'` in `actionClassForProposalType`).

**Allowed files:** per PRD — `packages/api/src/reputation/**`, `packages/api/src/workers/google-reviews.*`, `packages/api/src/db/schema.ts` (keys 105+106+107), `packages/shared/src/contracts/review-response-proposal.ts`, plus the additive edits to `proposals/proposal.ts` and the new `proposals/execution/review-response-handler.ts`.

**Split into 3 PRs** (sequential — same allowed-files surface so cannot parallelize):
- **(a) poll + model:** migrations 105+106, `review.ts`/`pg-review.ts`, `google-business-client.ts`, `workers/google-reviews.ts` (backoff on 429); no AI yet
- **(b) classifier + match:** `classifier.ts` (deterministic regex first, LLM fallback), `match-customer.ts` (name>0.8 AND visit≤60d), `pii-redact.ts` (content-level — strips last names, addresses, phones, emails)
- **(c) proposal + credit + execution:** migration 107, `credit-tier.ts` (12-month cap query), `build-proposal.ts`, `draft-public-response.ts`, `draft-private-followup.ts`, the proposal-type enum addition, `review-response-handler.ts`

**Forbidden files:** all of `packages/api/src/logging/redact.ts` (this is the key-pattern infra-redactor; review-response needs a separate content-redactor — do not couple them).

**Verification gate (run after PR c):**
```bash
cd packages/api && npx tsc --project tsconfig.build.json --noEmit
cd packages/api && npm test -- --grep "P7-026"
```
Required tests: classifier accuracy >85% on labeled fixtures; matcher rejects ambiguous; PII redactor strips correctly; credit cap honored; backoff after 429; per-component approval; brand-voice golden examples.

### P8-015 — Dropped-call SMS recovery

**Why:** the 1:30pm scene — caller hangs up after 11 seconds. Today the voice session is marked `outcome='dropped'` (the enum already includes it; see `voice-session.ts`) and that's it. No SMS, no thread, no recovery.

**Outcome:** `finalizeTerminalOutcome()` at `inapp-adapter.ts:564` fires a `DroppedCallEvent` when `outcome ∈ {'dropped','failed'}` and no booking/escalation proposal exists. A worker drains the queue 60s later; re-checks for a booking proposal correlated to the session (suppress if found); rate-limits per E.164 (5min via B5); composes a brand-voice SMS with a partial-transcript cue (PII-stripped, 80-char cap); sends via Twilio; threads via `voice_session` + `sms_conversation` links (B6).

**Files to create:** `packages/api/src/voice/recovery/detect-dropped.ts`, `extract-context-cue.ts`; `packages/api/src/sms/recovery/dropped-call-handler.ts`, `scheduler.ts`; `packages/api/src/workers/dropped-call-worker.ts`; `packages/shared/src/contracts/dropped-call-event.ts`.

**Files to modify:** `packages/api/src/ai/agents/customer-calling/inapp-adapter.ts` — in `finalizeTerminalOutcome` (line ~564 post-`session.terminalOutcome`): inject `droppedCallScheduler` in deps; fire `void this.deps.droppedCallScheduler?.schedule(event)` when outcome qualifies. Mirror in `packages/api/src/voice/voice-service.ts` for the Twilio-adapter terminal path.

**Allowed files:** per PRD — `packages/api/src/voice/recovery/**`, `packages/api/src/sms/recovery/**`, `packages/api/src/db/schema.ts` (key 108), `packages/shared/src/contracts/dropped-call-event.ts`, plus the dep-injection edits to `inapp-adapter.ts` and `voice-service.ts`, and new `packages/api/src/workers/dropped-call-worker.ts`.

**Forbidden files:** `packages/api/src/conversations/linkage.ts` (B6 owns the entity-type expansion); `packages/api/src/shared/rate-limit/**` (B5 owns).

**Verification gate:**
```bash
cd packages/api && npx tsc --project tsconfig.build.json --noEmit
cd packages/api && npm test -- --grep "P8-015"
```
Required tests: schedule on drop; no schedule on completed; suppression within 60s window on booking; rate-limit blocks 2nd send within 5min; cue extraction handles empty transcript; threaded link present; brand-voice composer invoked.

### P8-016 — Vulnerability-aware emergency triage

**Why:** the 11:00am scene — elderly caller with flat affect, mom on oxygen, 104°F. The current urgency classifier (`packages/api/src/ai/skills/classify-urgency-tier.ts`) is deterministic regex on the utterance only; it misses the customer-record + weather + medical-utterance combination.

**Outcome:** four independent detectors (age, weather, medical, property-type) feed a pure `triage-decision()` function:
- **vulnerability ≥1 + urgency=tier 1/2** → patch to owner's cell with 5s deterministic-template preface
- **vulnerability ≥1 + urgency=tier 3+** → high-priority booking proposal + owner SMS
- **vulnerability=0** → existing escalation
- **owner unreachable for 60s** → cascade-exhausted falls through to high-priority booking + owner SMS

**Files to create:** `packages/api/src/ai/vulnerability/signal-extractor.ts`, `detectors/age-detector.ts`, `detectors/weather-detector.ts`, `detectors/medical-detector.ts`, `detectors/property-type-detector.ts`, `triage-decision.ts`; `packages/api/src/voice/triage/owner-cell-patch.ts`, `context-preface.ts`; `packages/api/src/integrations/weather/weather-client.ts`, `pg-weather-cache.ts`; `packages/shared/src/contracts/vulnerability-signal.ts`.

**Files to modify:** `packages/api/src/customers/customer.ts` + `pg-customer.ts` add `dateOfBirth?: Date`, `accountType?: 'residential'|'b2b'`; `packages/api/src/ai/skills/escalate-to-human.ts` adds `EscalationReason='vulnerability_patch'` + owner-mobile resolver + 60s timer fallback (reuses existing `<Dial>` infra); `packages/api/src/ai/agents/customer-calling/state-machine.ts` consults `triage-decision()` at the escalation site.

**Allowed files:** per PRD — `packages/api/src/voice/triage/**`, `packages/api/src/ai/vulnerability/**`, `packages/api/src/integrations/weather/**`, `packages/api/src/db/schema.ts` (keys 109+110+111), `packages/shared/src/contracts/vulnerability-signal.ts`, plus the additive edits listed above.

**Forbidden files:** the existing `classify-urgency-tier.ts` (vulnerability is a pre-filter, not a rewrite); `packages/api/src/users/**` (B4 owns the mobile-number column).

**Important constraints (security-critical):**
- The medical detector outputs evidence verbatim ("caller mentioned oxygen"). It **never** asserts diagnosis. The preface uses the evidence string; brand voice elsewhere is forbidden from saying "you have a medical emergency".
- The 5s preface is deterministic-template — not LLM. 5s is too tight for a model round-trip + TTS.
- Weather-API failure must fall back to age + medical only (not block the call).

**Verification gate:**
```bash
cd packages/api && npx tsc --project tsconfig.build.json --noEmit
cd packages/api && npm test -- --grep "P8-016"
```
Required tests: each detector pure; triage decision matrix exhaustive; preface ≤5s + no PII; owner-unreachable falls back; medical phrasing never asserts authority; weather-API failure → fall back to age+medical only; >95% correct-escalation on labeled fixtures.

## Tier 3 freezes — none required

None of B1–B6 touch a Tier 1 LOCKED surface. The only Tier 2 STABLE-WITH-EXTENSIONS touch is the additive `ProposalType` enum addition in P7-026 PR (c) — additive change is allowed per the freeze list. No new Tier 3 entries needed.

## One-line wave start (after the addenda are extended/written and freeze-list confirmed)

```bash
git checkout main && git pull
# Wave 0
/dispatch-story B1
/dispatch-story B4
/dispatch-story B6
# After Wave 0 merges:
git fetch origin main && git checkout main && git pull
# Wave 1
/dispatch-story B2
/dispatch-story B3
/dispatch-story B5
# After Wave 1 merges:
git fetch origin main && git checkout main && git pull
# Wave C1
/dispatch-story P6-028
/dispatch-story P7-026
/dispatch-story P8-015
/dispatch-story P8-016
```

Note: B1–B6 are not in `phase-*-gap-stories.md` yet — they need bodies written (or be re-numbered into the existing phase that owns the surface) before `/dispatch-story` will accept them. Suggested:
- B1 → new entry in `phase-4-gap-stories.md` (extracted from P4-015's scope)
- B2 → new entry in `phase-2-gap-stories.md` (extracted from P2-002 scope)
- B3 → new entry in `phase-2-gap-stories.md` (extracted from P2-034 scope)
- B4 → new entry in `phase-1-gap-stories.md` (extracted from P1-001 / P1-008 scope)
- B5 → new entry in `phase-0-gap-stories.md` (cross-cutting infra)
- B6 → new entry in `phase-0-gap-stories.md` (cross-cutting infra)

Once those entries exist and reference this wave plan, the dispatcher can pick them up.
