---
title: "Inbound voice booking runs on the Twilio Gather path, not VAPI"
date: 2026-06-14
track: knowledge
problem_type: architecture-patterns
module: "packages/api/src/telephony, packages/api/src/integrations/vapi, packages/api/src/ai/tasks"
tags: ["voice", "telephony", "vapi", "twilio", "appointments", "inbound"]
related: ["docs/solutions/logic-errors/voice-reason-for-visit-summary-vs-notes.md"]
---

## Context
When verifying "the AI voice agent takes inbound calls and books appointments,"
it's natural to assume the modern VAPI integration is the booking path (it's the
newer, headline telephony integration, and provisioning even creates a VAPI
assistant). It isn't. Driving a proof or a fix against VAPI would certify
nothing, because VAPI inbound does not create appointments.

## Guidance
There are **three** voice code paths; know which one books:

- **VAPI inbound webhook** — `handleVapiCallEvent`
  (`packages/api/src/integrations/vapi/webhook.ts`, route
  `POST /webhooks/vapi/:tenantId`). Verifies the signature, dedupes, records a
  `voice_sessions` row, and fires the activation event. It does **not** classify
  intent, draft proposals, or create appointments.
- **Twilio Gather (canonical booking path)** — `POST /api/telephony/voice` →
  `POST /api/telephony/gather` → `TwilioGatherAdapter` FSM
  (`packages/api/src/telephony/twilio-adapter.ts`). The FSM classifies intent,
  resolves entities, and emits the `create_appointment` proposal. Dialed-number →
  tenant routing is `PgPhoneNumberRepository.findByNumber` reading
  `tenant_integrations.provider_data->>'phoneE164'`.
- **voice-action-router** (`packages/api/src/workers/voice-action-router.ts`) →
  `CreateAppointmentAITaskHandler` — a separate transcript-routing path (not wired
  to either inbound webhook), used for non-telephony/programmatic transcripts.

All paths that produce a `create_appointment` proposal converge on the **same**
downstream `CreateAppointmentExecutionHandler`
(`packages/api/src/proposals/execution/handlers.ts`), so a fix at that seam
covers every producer.

## Why This Matters
- An end-to-end proof must drive the **Twilio Gather** path (or, at minimum, the
  shared `ProposalExecutor` + `CreateAppointmentExecutionHandler` against a real
  repo). A VAPI-driven booking test is vacuous today.
- "Add booking to the VAPI assistant and it'll just work" is false — VAPI inbound
  has no intent→proposal→appointment chain. Making VAPI book is net-new work, not
  a config change.

## When to Apply
Any inbound-voice appointment work, or when proving/altering the voice → booking
chain end to end.

## Examples
- Keystone proof drives routing + the shared executor with real Postgres:
  `packages/api/test/integration/voice-inbound-appointment.test.ts`.
- Live-call procedure (certifies the Gather path explicitly):
  `docs/runbooks/voice-inbound-appointment-verification.md`.
