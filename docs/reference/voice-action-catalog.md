# Voice action catalog — what a tradesperson can do by speaking

**Audience:** product + engineering. **Source of truth:** the code, not this
file. The machine-readable block at the bottom is pinned to the code by
`packages/api/test/ai/voice-action-catalog.contract.test.ts` — if an intent,
proposal type, action class, or execution handler changes and this file is not
updated, that test fails. (This is deliberate: `docs/remaining-features.md`
rotted because it was prose with no test behind it.)

A spoken instruction travels:

```
push-to-talk → POST /api/voice/recordings → transcription worker
  → voice-action-router → classifyIntent (LLM gateway) → INTENT_TO_PROPOSAL_TYPE
  → task handler builds a Zod proposal → entity resolver (ambiguity → voice_clarification)
  → proposal persisted → human one-tap approve (UI/SMS) → ProposalExecutor
  → execution handler → row persisted + audit event
```

A voice action only works end-to-end when it has **all three**: (1) a classifier
intent, (2) an entry in `INTENT_TO_PROPOSAL_TYPE`, and (3) an execution handler
wired with its real dependency. Sections below are organised by which of these
exist today.

---

## A) Speakable today — intent + proposal + execution handler all exist

These 25 actions can be spoken, drafted as a proposal, approved, and executed.
"Persistence proof" = a Docker-gated integration test that proves the row +
audit event actually land in Postgres (vs. mocked-DB-only coverage, which cannot
catch schema drift or a missing dependency).

| Spoken example | Intent | Proposal type | Class | Persistence proof |
|---|---|---|---|---|
| "Invoice the Johnson job, $450 capacitor + labor" | `create_invoice` | `draft_invoice` | capture | integration (`integration/draft-invoice-execution.test.ts`) |
| "Quote the Khan install, 3-ton condenser" | `draft_estimate` | `draft_estimate` | capture | partial |
| "Book Carlos at the Garcia place Tue 2pm" | `create_appointment` | `create_appointment` | capture | integration (`integration/appointments.test.ts`) |
| "Add a $90 contactor to the Smith invoice" | `update_invoice` | `update_invoice` | capture | unit |
| "Change the Khan quote to a 3-ton" | `update_estimate` | `update_estimate` | capture | unit |
| "Issue the Garcia invoice" | `issue_invoice` | `issue_invoice` | money | unit |
| "New customer Maria Alvarez, 480-555-0102" | `create_customer` | `create_customer` | capture | integration (`integration/voice-create-customer.test.ts`) |
| "Open a job for Alvarez, no AC" | `create_job` | `create_job` | capture | integration (`integration/create-job-execution.test.ts`) |
| "Move the Garcia job to Thursday 10" | `reschedule_appointment` | `reschedule_appointment` | capture | unit |
| "Cancel Tuesday's Garcia appointment" | `cancel_appointment` | `cancel_appointment` | irreversible | unit |
| "Put Carlos on the Garcia job instead of me" | `reassign_appointment` | `reassign_appointment` | capture | unit |
| "Add Carlos to the Garcia appointment" | `add_crew_member` | `add_crew_member` | capture | handler-level |
| "Take Carlos off Tuesday's job" | `remove_crew_member` | `remove_crew_member` | capture | handler-level |
| "Note on the Patel job: wants morning visits" | `add_note` | `add_note` | capture | unit |
| "Send the Johnson invoice" | `send_invoice` | `send_invoice` | comms | unit |
| "Send the Khan estimate" | `send_estimate` | `send_estimate` | comms | unit |
| "Mark the Smith invoice paid, $200 cash" | `record_payment` | `record_payment` | money | unit |
| "Emergency, no heat at the Hayes place — page me" | `emergency_dispatch` | `emergency_dispatch` | irreversible | unit |
| "Update Alvarez's phone number" | `update_customer` | `update_customer` | capture | unit |
| "Log a $60 parts expense on the Patel job" | `log_expense` | `log_expense` | capture | unit |
| "Convert the Greenfield lead to a customer" | `convert_lead` | `convert_lead` | capture | unit |
| "Confirm the Garcia appointment" | `confirm_appointment` | `confirm_appointment` | capture | unit |
| "Mark the Wagner lead lost — went with a competitor" | `mark_lead_lost` | `mark_lead_lost` | capture | unit |
| "Add a service location for Greenfield, 12 Lakeshore" | `add_service_location` | `add_service_location` | capture | unit |
| "Clock 2 hours on the Patel job" | `log_time_entry` | `log_time_entry` | capture | unit |
| "Text the Garcia customer I'm 20 min late" | `notify_delay` | `notify_delay` | comms | unit |
| "Ask the Smith customer for a review" | `request_feedback` | `request_feedback` | comms | unit |

Two further intents are special-cased in the router (they reuse existing
proposal types and live outside `INTENT_TO_PROPOSAL_TYPE`):

- `complaint` → pinned `add_note` + companion `callback` (handler key `_complaint`).
- `negotiation` → `callback` guardrail (handler key `_negotiation`); never negotiates,
  routes to a human.

> **Money / comms / irreversible actions never auto-approve** regardless of trust
> tier or confidence (`decideInitialStatus` + `actionClassForProposalType`). Only
> capture-class actions can auto-approve, and only on the autonomous-trust path.

## B) Not yet speakable — execution handler exists, but no voice on-ramp

The machinery to *execute* these is built and wired; what's missing is a
classifier intent + an `INTENT_TO_PROPOSAL_TYPE` entry so a transcript can reach
them. Building the on-ramp is front-half-only (no new handler, schema, or
migration).

| Spoken example a tradesperson would expect to work | Proposal type | Class | Plan |
|---|---|---|---|
| "Invoice all my completed jobs from today" | `batch_invoice` | capture | U7 |
| "Add a late fee to the overdue Smith invoice" | `apply_late_fee` | money | U8 |
| "Send a payment reminder on the Smith invoice" | `send_payment_reminder` | comms | U8 |
| "Nudge the Khan estimate again" | `send_estimate_nudge` | comms | U8 |
| "Set up 50% deposit, 50% on completion for Garcia" | `create_invoice_schedule` | capture | deferred (complex payload) |
| "Respond to that 1-star review" | `review_response_proposal` | comms | deferred (review-monitoring driven) |
| "Book this caller for Thursday" | `create_booking` | capture | deferred (customer-call FSM path) |

## C) Not completable from speech yet — no proposal type/handler (white-space)

| Spoken example | Status | Reference |
|---|---|---|
| "Assign the closest certified tech to this job" | needs new type + handler + intent | parity P25 |
| "Add the Carrier unit I serviced in May to this customer" | needs new type + handler + intent | parity P24 |

## D) Classified but intentionally gated (locked decision, not a gap)

`approve_proposal`, `reject_proposal`, and `edit_proposal` are recognised by the
classifier but **hard-refused on the recorder channel** (RV-071 / RV-225); they
are actionable only on a live, verified owner telephony session. In-app voice
approval is post-launch per `docs/launch/voice-interaction-scope.md` (launch
approves by screen/SMS tap).

## E) Read-only voice queries (work today; not "actions")

`lookup_appointments`, `lookup_invoices`, `lookup_balance`, `lookup_jobs`,
`lookup_agreements`, `lookup_account_summary`, `lookup_customer`,
`lookup_estimates`, `lookup_availability`, `lookup_leads`, `lookup_revenue`,
`lookup_catalog`, `lookup_day_overview`, `lookup_digest`, `lookup_pending_items`
— routed to read-only skills, never to a proposal (correct by design).

---

<!-- BEGIN machine-readable: voice-action-catalog -->
```json
{
  "speakable": [
    { "intent": "create_invoice", "proposalType": "draft_invoice", "actionClass": "capture" },
    { "intent": "draft_estimate", "proposalType": "draft_estimate", "actionClass": "capture" },
    { "intent": "create_appointment", "proposalType": "create_appointment", "actionClass": "capture" },
    { "intent": "update_invoice", "proposalType": "update_invoice", "actionClass": "capture" },
    { "intent": "update_estimate", "proposalType": "update_estimate", "actionClass": "capture" },
    { "intent": "issue_invoice", "proposalType": "issue_invoice", "actionClass": "money" },
    { "intent": "create_customer", "proposalType": "create_customer", "actionClass": "capture" },
    { "intent": "create_job", "proposalType": "create_job", "actionClass": "capture" },
    { "intent": "reschedule_appointment", "proposalType": "reschedule_appointment", "actionClass": "capture" },
    { "intent": "cancel_appointment", "proposalType": "cancel_appointment", "actionClass": "irreversible" },
    { "intent": "reassign_appointment", "proposalType": "reassign_appointment", "actionClass": "capture" },
    { "intent": "add_crew_member", "proposalType": "add_crew_member", "actionClass": "capture" },
    { "intent": "remove_crew_member", "proposalType": "remove_crew_member", "actionClass": "capture" },
    { "intent": "add_note", "proposalType": "add_note", "actionClass": "capture" },
    { "intent": "send_invoice", "proposalType": "send_invoice", "actionClass": "comms" },
    { "intent": "send_estimate", "proposalType": "send_estimate", "actionClass": "comms" },
    { "intent": "record_payment", "proposalType": "record_payment", "actionClass": "money" },
    { "intent": "emergency_dispatch", "proposalType": "emergency_dispatch", "actionClass": "irreversible" },
    { "intent": "update_customer", "proposalType": "update_customer", "actionClass": "capture" },
    { "intent": "log_expense", "proposalType": "log_expense", "actionClass": "capture" },
    { "intent": "convert_lead", "proposalType": "convert_lead", "actionClass": "capture" },
    { "intent": "confirm_appointment", "proposalType": "confirm_appointment", "actionClass": "capture" },
    { "intent": "mark_lead_lost", "proposalType": "mark_lead_lost", "actionClass": "capture" },
    { "intent": "add_service_location", "proposalType": "add_service_location", "actionClass": "capture" },
    { "intent": "log_time_entry", "proposalType": "log_time_entry", "actionClass": "capture" },
    { "intent": "notify_delay", "proposalType": "notify_delay", "actionClass": "comms" },
    { "intent": "request_feedback", "proposalType": "request_feedback", "actionClass": "comms" }
  ],
  "handlerNoOnramp": [
    "batch_invoice",
    "create_invoice_schedule",
    "apply_late_fee",
    "send_payment_reminder",
    "send_estimate_nudge",
    "review_response_proposal",
    "create_booking"
  ],
  "gated": ["approve_proposal", "reject_proposal", "edit_proposal"]
}
```
<!-- END machine-readable: voice-action-catalog -->
