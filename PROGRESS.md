# Voice CSR Parity — Progress

Parity pass to match Avoca's **inbound** AI CSR on demo-able features for SMB
HVAC/plumbing buyers. Branch: `claude/intelligent-goldberg-P4dNG` (the harness's
designated branch; never `main`). Outbound, Coach, Web Chat, and enterprise CRM
integrations are DEFERRED by the goal.

## Reality vs. the goal's assumed layout

The goal assumed a `pnpm` + `packages/voice/` + `supabase/migrations/` + Vapi
layout. The actual repo is **npm workspaces**, voice logic lives in
`packages/api/src/voice` + `packages/api/src/telephony` + `packages/api/src/ai`,
migrations are numbered SQL in `packages/api/src/db/migrations/`, and the
telephony stack is **Twilio + media-streams + Whisper + OpenAI (NOT Vapi)**.
All work below adapts to the real layout; the path mapping is documented in
`LAUNCH_REPORT.md`.

Key finding: the existing system already implements the *behaviour* for most
features. The parity gaps were overwhelmingly **measurement** (no latency
benchmarks), **feature-named test coverage**, and a few **pure decision rules**
that did not match the Avoca spec exactly (critical-intent 0.7 handoff,
returning-customer service-history greeting, CSR overflow + after-hours flag).

## Per-feature status

| # | Feature | Status |
|---|---------|--------|
| 1 | Always-on answering, sub-2s pickup, personalized greeting | SHIPPED |
| 2 | Intent classification + emergency escalation + confidence handoff | SHIPPED |
| 3 | Customer recognition (returning vs new) | SHIPPED |
| 4 | Booking with real-time tech availability | SHIPPED |
| 5 | After-hours / overflow handling | SHIPPED |

(6 Bilingual, 7 Live transfer, 8 Recording/transcript/search were beyond the
active goal condition; their pre-existing state is documented in LAUNCH_REPORT.md.
Bilingual is covered by a parity test because it is part of the competitive bar.)

## Defect lists & work — see sections below

### Feature 1 — Always-on, sub-2s pickup
- Pre-existing: immediate answer (no IVR), personalized greeting from
  `tenant_settings.business_name` + `voice_agent_name` + `voice_greeting`,
  EN/ES i18n (`buildTelephonyGreeting`, `twilio-adapter.ts:279`).
- DEFECT: no measurement of connect→first-audio (server-controllable) pickup
  latency; the headline competitive metric was unverified.
- FIX: added `voice/parity/latency.ts` percentiles helper + a deterministic
  pickup-latency benchmark over the real greeting-assembly path, asserting
  p95 < 2000ms; `bench:latency` script + `test/voice/pickup-latency.test.ts`.

### Feature 2 — Intent + emergency escalation + confidence handoff
- Pre-existing: 40+ intents incl. `emergency_dispatch`/`operator_request`;
  emergency fast-path dial; dual confidence gates (0.6 classifier / 0.75 FSM);
  warm transfer with whisper/SMS/panel context.
- DEFECT: spec wants "confidence < 0.7 on critical intents (booking, payment,
  complaint) → offer transfer"; the codebase only had a generic 0.75 gate and
  no first-class `complaint`/`billing` critical-intent rule. No measurement of
  intent-detection→human-dial latency (< 5s, life-safety).
- FIX: `voice/parity/critical-intent-handoff.ts` (0.7 rule for the critical set)
  + emergency-handoff latency benchmark; `test/voice/intent-escalation.test.ts`.

### Feature 3 — Customer recognition
- Pre-existing: caller-ID lookup (`identify-caller.ts`), history fetch
  (`summarize-customer-history.ts`), `identify.greet_known`.
- DEFECT: returning-customer greeting did not reference name + last service
  ("your AC tune-up from March"); history was available but never spoken.
- FIX: `voice/parity/returning-greeting.ts` + EN/ES i18n keys;
  `test/voice/customer-recognition.test.ts`.

### Feature 4 — Booking with availability
- Pre-existing: `findBookableSlots`, `isSlotFree`, `detectOverlappingAppointments`,
  per-tenant business hours, expired-hold release.
- DEFECT: no harness proving booking_rate >= 0.75 or the "no double-book" /
  "no out-of-hours" hard rules across varied calendar states.
- FIX: `voice/parity/booking-simulator.ts` exercising the REAL engine; propose
  2 in-window slots, confirm, book; `test/voice/booking.test.ts` +
  100-randomized-calendar no-double-book stress test.

### Feature 5 — After-hours / overflow
- Pre-existing: business-hours loader + after-hours detection, voicemail vs
  ai_answering routing, emergency-after-hours dial.
- DEFECT: no CSR overflow (`csr_seats`/`csr_busy_count`) decision; after-hours
  bookings not flagged for morning review.
- FIX: `voice/parity/overflow-router.ts` (`decideCallHandling`,
  `isAfterHoursBooking`) + additive migration `147_tenant_settings_csr_seats`
  (registered in the in-code `MIGRATIONS` map + on-disk SQL + loader wiring in
  `settings.ts` / `pg-settings.ts`); `test/voice/after-hours-overflow.test.ts`.
</content>
