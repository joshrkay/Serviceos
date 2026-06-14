# Verification: AI voice agent — inbound calls → appointment booking

**Date:** 2026-06-14
**Scope:** Prove the inbound-call → appointment-booking flow works, that the
agent captures *what* the appointment is for, and that an inbound call routes
to the right tradesperson's number. Verification only — no feature changes.

This is a **proof map**: it points at the automated tests that hold each
property, the one new test that closes the end-to-end gap, and the commands to
run them. Everything below is in the canonical product under `packages/`.

---

## TL;DR

| Goal | Status | Primary proof |
|------|--------|---------------|
| 1. Inbound call → appointment booking works | ✅ Proven | `test/voice/inbound-caller-booking-golden-path.test.ts` (new) + the chain below |
| 2. Agent captures intent + what/when ("type") | ✅ Proven | classifier + golden-path entity assertions |
| 3. Inbound call routes to the owning tenant's number | ✅ Proven | `test/routes/telephony-tenant-lookup.test.ts` |
| 3b. A *technician* selects their *own* number | ⚠️ Not built | gap — see "Flagged gaps" |

---

## How a booking actually flows (the chain under test)

1. **Twilio inbound webhook** `POST /api/telephony/voice`
   (`packages/api/src/routes/telephony.ts`) — signature-verified.
2. **Number → tenant** — `resolveInboundTenantId` looks the dialed `To`
   number up in `tenant_integrations.provider_data->>'phoneE164'` via
   `PgPhoneNumberRepository.findByNumber`
   (`packages/api/src/integrations/twilio/phone-number-repository.ts`). No
   tenant context exists yet, so the lookup is cross-tenant, gated by the
   `app.system_lookup` RLS exception (migration 074).
3. **Gather-mode turns** — Twilio does STT and posts `SpeechResult` text to
   `POST /api/telephony/gather`. Each turn runs
   `createVoiceTurnProcessor().speechTurn(...)`
   (`packages/api/src/ai/voice-turn/create-voice-turn-processor.ts`).
4. **Intent classification** — `classifyIntent`
   (`packages/api/src/ai/orchestration/intent-classifier.ts`) routes through
   the **LLM gateway** and returns `create_appointment` + extracted entities
   (`dateTimeDescription`, `jobReference`, `customerName`). Below confidence
   0.60 it returns `unknown` instead of guessing.
5. **Readback → confirm** — the FSM moves to `intent_confirm`; the caller's
   "yes" runs `confirmIntent` and emits a `create_proposal` side effect
   carrying the classifier entities (`transitions.ts:781`).
6. **Proposal persisted** — `handleCreateProposal` builds a
   `create_appointment` proposal. Because the inbound calling-agent path
   threads **no** `sourceTrustTier`, `decideInitialStatus`
   (`packages/api/src/proposals/proposal.ts:364`) returns **`draft`** — it
   cannot auto-approve. A human approves before any appointment row is
   written.
7. **Execution (post-approval)** — on approval, the appointment
   task/handler resolves the spoken time against the tenant timezone and
   holds the slot (`create-appointment-task.ts`, `create-booking-handler.ts`).

The held-slot / time-resolution logic runs at **approval/execution** time,
not on the classify turn — so the inbound turn produces a review item, never a
booked slot.

---

## Goal 1 — inbound call → appointment booking works

**New end-to-end proof (closes the gap):**
`packages/api/test/voice/inbound-caller-booking-golden-path.test.ts`

Drives the inbound engine the way a Gather call does (dialed number → tenant
→ "my furnace stopped heating, can someone come Tuesday at 2pm?" → readback →
"yes") and asserts a `create_appointment` proposal lands in the dialed
tenant, in `draft`, with the spoken what/when in the payload. A second case
asserts a low-confidence utterance is **never silently booked**.

Why this test is needed: the §11 H2 synthetic smoke test left exactly this as
a `.todo()` — *"routes a canned 'book Tuesday at 2' call to a CreateBooking
proposal"* (`test/voice/voice-smoke.synthetic.test.ts`). The per-component
pieces were each tested; nothing stitched the inbound-caller story together.

**Supporting proofs (already green):**
- `test/ai/voice-turn/voice-turn-processor.test.ts` — the inbound FSM turn
  loop (classify → confirm → persist) and graceful degrade on gateway errors.
- `test/telephony/telephony-routes.test.ts` — `/voice` and `/gather` HTTP
  round-trips with Twilio signature enforcement; `/gather` reaches
  `intent_confirm`.
- `test/ai/tasks/create-appointment-task.test.ts`,
  `test/ai/held-slot-booking-task.test.ts` — time resolves to the tenant-tz
  UTC instant; held appointment + `create_booking` on the happy path;
  review-gated `create_appointment` (`status: draft`) on the degrade paths;
  `voice_clarification` when the time can't be resolved.

## Goal 2 — agent captures intent + what/when ("appointment type")

There is **no discrete appointment-type taxonomy** (no quote/repair/install
enum). "Type" today = the classifier **intent** (`create_appointment` vs
`reschedule_appointment` / `cancel_appointment` / `create_booking`) plus the
**free-text job reference + time** the agent extracts, scoped to the tenant's
vertical pack. That is what we verify:

- `test/ai/orchestration/intent-classifier.test.ts` and
  `intent-classifier.launch-fixtures.test.ts` — intent + entity extraction.
- `test/voice/operator-voice-golden-path.test.ts` (case 2) — "schedule a
  furnace tune-up … Tuesday at 2pm" → `create_appointment` with the HVAC
  vertical pack on the prompt.
- The new golden-path test asserts `payload.entities.jobReference` ("furnace
  not heating") and `dateTimeDescription` ("Tuesday at 2pm") ride into the
  proposal — i.e. the agent records what the visit is for and when.

> If a real type taxonomy is wanted later, it is a **build**, not a
> verification: add an enum to the shared contract + a classifier, then
> assert it. Out of scope here by decision.

## Goal 3 — inbound call routes to the tradesperson's number

**Proven (number → tenant):** `test/routes/telephony-tenant-lookup.test.ts`
covers found-number → Gather TwiML on the resolved tenant; unknown number →
"not in service" decline; prod/staging refuse the `TWILIO_DEFAULT_TENANT_ID`
fallback; DB error → 503 so Twilio retries. The new golden-path test adds the
booking-side assertion: the proposal is scoped to the tenant the dialed number
resolved to.

Number provisioning + webhook wiring (buy DID, set `VoiceUrl`) is covered by
`test/integration/onboarding-vapi.test.ts` and the provisioning worker.

---

## Flagged gaps (follow-up, out of this verification's scope)

1. **A technician's own number is not used for escalation routing.** Today
   every on-call dispatcher rings the same `tenant_settings.business_phone`
   (`packages/api/src/telephony/dispatcher-phone-resolver.ts` —
   `createBusinessPhoneDispatcherResolver` ignores its `userId` arg, explicitly
   "v1 … until per-user mobile numbers land"). Note: a per-user
   `users.mobile_number` column **already exists** (migration
   `109_users_mobile_number`) with `UserRepository.setMobileNumber` /
   `findByMobileNumber` support — it's used for P1-022 (tech SMS-reply binding,
   emergency owner paging) but **not** consulted by the escalation
   dial path, and there is no technician-facing UI to set it. To finish it:
   refactor the dispatcher-phone-resolver to prefer `user.mobileNumber` with a
   `business_phone` fallback, add a self-service `PUT` endpoint + a technician
   settings sheet. (The onboarding *business* number is separately
   auto-assigned and read-only — `web/.../onboarding/v2/steps/PhoneStep.tsx`.)

2. **Media Streams canned-audio smoke is still a `.todo()`.** The Gather-mode
   inbound booking is now proven (above). The raw-audio Media Streams variant
   (`test/voice/voice-smoke.synthetic.test.ts`) still needs a fake STT
   provider + mulaw fixture + test-mode gateway to assert end-to-end over
   audio frames.

---

## Run it

```bash
cd packages/api

# The new end-to-end inbound booking proof
npx vitest run test/voice/inbound-caller-booking-golden-path.test.ts

# The full inbound-voice + appointment + routing proof set
npx vitest run \
  test/voice/ test/telephony/ \
  test/routes/telephony-tenant-lookup.test.ts \
  test/ai/voice-turn/ test/ai/orchestration/intent-classifier.test.ts \
  test/ai/tasks/create-appointment-task.test.ts test/ai/held-slot-booking-task.test.ts

# DB-backed appointment + voice integration (Docker-gated)
npm run test:integration -- test/integration/appointments.test.ts test/integration/voice.test.ts
```
