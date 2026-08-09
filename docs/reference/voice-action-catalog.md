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

These 48 actions can be spoken, drafted as a proposal, approved, and executed.
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
| "Invoice all my completed jobs" | `batch_invoice` | `batch_invoice` | capture | handler-level |
| "New customer Maria Alvarez, 480-555-0102" | `create_customer` | `create_customer` | capture | integration (`integration/voice-create-customer.test.ts`) |
| "Open a job for Alvarez, no AC" | `create_job` | `create_job` | capture | integration (`integration/create-job-execution.test.ts`) |
| "Mark the Henderson job in progress" | `update_job` | `update_job` | capture | integration (`integration/update-job-execution.test.ts`) |
| "Move the Garcia job to Thursday 10" | `reschedule_appointment` | `reschedule_appointment` | capture | unit |
| "Cancel Tuesday's Garcia appointment" | `cancel_appointment` | `cancel_appointment` | irreversible | unit |
| "Put Carlos on the Garcia job instead of me" | `reassign_appointment` | `reassign_appointment` | capture | unit |
| "Add Carlos to the Garcia appointment" | `add_crew_member` | `add_crew_member` | capture | handler-level |
| "Take Carlos off Tuesday's job" | `remove_crew_member` | `remove_crew_member` | capture | handler-level |
| "Note on the Patel job: wants morning visits" | `add_note` | `add_note` | capture | unit |
| "Send the Johnson invoice" | `send_invoice` | `send_invoice` | comms | unit |
| "Send the Khan estimate" | `send_estimate` | `send_estimate` | comms | unit |
| "Nudge the Khan estimate again" | `send_estimate_nudge` | `send_estimate_nudge` | comms | handler-level |
| "Chase the unpaid Smith invoice" | `send_payment_reminder` | `send_payment_reminder` | comms | handler-level |
| "Add a $25 late fee to the Smith invoice" | `apply_late_fee` | `apply_late_fee` | money | handler-level |
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
| "Set up 50% deposit, 50% on completion for the Hendersons" | `create_invoice_schedule` | `create_invoice_schedule` | capture | unit + handler-level (schedule execution: `proposals/invoice-schedule-handler.test.ts`) |
| "Respond to that 1-star review" | `respond_to_review` | `review_response_proposal` | comms | unit |
| "From now on always add a $79 diagnostic fee to AC calls" | `create_standing_instruction` | `create_standing_instruction` | capture | unit (table: integration via UB-A1 `integration/standing-instructions.test.ts`) |
| "Set my brand voice: friendly, plain-spoken, no slang, always sign off 'Thanks — Bob's HVAC'" | `update_brand_voice` | `update_brand_voice` | manual | integration (`integration/update-brand-voice-voice-execution.test.ts`) |
| "Schedule the rough-in inspection for Thursday" | `schedule_inspection` | `create_appointment` | capture | unit |
| "Log permit 2024-1187 on the Patel job" | `log_permit` | `add_note` | capture | unit |
| "Log a warranty callback for the Hendersons' water heater" | `log_warranty_claim` | `create_job` | capture | unit |
| "Raise the diagnostic fee to 89 dollars" | `update_catalog_item` | `update_catalog_item` | capture | unit |
| "Refund the Smiths 100 dollars on their invoice" | `record_refund` | `record_refund` | money | unit |
| "Knock 50 dollars off the Henderson invoice" | `apply_credit` | `apply_credit` | money | unit |
| "Text the Hendersons the part arrived, we can come Thursday" | `send_customer_message` | `send_customer_message` | comms | unit |
| "The Garcias want a second zone — change order for 1800" | `create_change_order` | `create_change_order` | capture | integration (`integration/draft-estimate-execution.test.ts`) |
| "Sign the Garcias up for the annual maintenance plan, 290 a year" | `create_service_agreement` | `create_service_agreement` | capture | unit + sweep round-trip (`proposals/create-service-agreement-handler.test.ts`: handler-created agreement → `runDueAgreements` → asserts a `generated`, not `failed`, run) |
| "Add three boxes of half-inch PEX to the shopping list" | `add_material` | `add_material` | capture | unit (`proposals/add-material-handler.test.ts`) |
| "Log 32 miles to the Patel job" | `log_mileage` | `log_expense` | capture | unit |
| "Add a catalog item: smart thermostat install, 385" | `add_catalog_item` | `add_catalog_item` | capture | unit (`proposals/add-catalog-item-handler.test.ts`) |

> **Voice technician resolution (U1, taxonomy 1.2.0):** `reassign_appointment`,
> `add_crew_member`, and `remove_crew_member` now resolve the spoken technician
> name via the entity resolver (`kind: 'technician'`, pg_trgm over the `users`
> full-name expression, roles technician/dispatcher/owner, τ_ent 0.8). A unique
> match lands on the payload as a verified `toTechnicianId` / `technicianId`;
> an ambiguous name ("two Carloses") becomes a one-tap `voice_clarification`
> picker; an unmatched name keeps the pre-U1 behavior — the id stays in
> `missingFields` and the review UI resolves it before approval.

Notes on the taxonomy-1.3.0 row:

- `update_job` — deliberately scoped to SAFE field edits (status, priority,
  title/description) — never money or schedule (those keep their own
  intents/paths). The `jobId` target resolves the SAME way
  `update_estimate`/`update_invoice` resolve their reference: a literal UUID
  ungates the proposal; a free-text reference is best-effort resolved via a
  jobRepo search (stamped for review-card context, candidates offered) but
  ALWAYS stays gated behind `missingFields: ['jobId']`. Execution is a raw
  field write via the `updateJob` domain function (jobs/job.ts) — NOT the
  governed lifecycle transition (`transitionJobStatus`) POST
  `/api/jobs/:id/transition` uses, which adds forward/backward-move
  validation, a timeline entry, and completion side effects. Emits
  `job.updated` (not a new audit event type).

Notes on the Tradesperson wave 1, Task 2 row (`update_catalog_item`,
taxonomy 1.7.0):

- The proposal type + execution handler are WS20's — originally minted
  system-side by the correction-repetition loop after N repeated same-SKU
  price corrections (`learning/corrections/correction-repetition.ts`) —
  this task adds ONLY the voice on-ramp (classifier intent + map entry +
  drafting `UpdateCatalogItemTaskHandler`). Neither the contract
  (`proposals/contracts/update-catalog-item.ts`) nor the execution handler
  changed.
- Only a **price** change actually executes: the contract's `name` field is
  informational-only (the item's name at proposal time, for the review
  card) and there is no `description` field on the contract at all — the
  execution handler writes `proposedUnitPriceCents` and nothing else. A
  spoken rename/description request is surfaced on `proposal.explanation`
  ("edit from the Catalog screen") rather than silently no-opped as if it
  had applied.
- The catalog item reference is resolved by the task handler itself
  (`catalogRepo.listByTenant` + case-insensitive substring match) — zero
  matches or an ambiguous (>1) match keeps the proposal gated with a
  human-readable reason; there is no general entity-resolver `kind:
  'catalogItem'` the way jobs/appointments/technicians have.
- The contract's `evidence` field (`lessonIds` + `correctionCount`) is
  REQUIRED by the Zod schema but carries correction-loop-specific
  provenance a voice utterance cannot honestly supply — the task handler
  omits it rather than fabricating a fake lesson id. This is safe for
  drafting and approval (the execution handler never reads `evidence`, and
  `approveProposal` only blocks on the tracked `missingFields` list, not
  full Zod re-validation) but means a voice-drafted `update_catalog_item`
  proposal cannot go through the generic `editProposal` field-edit path
  before approval — editing revalidates the FULL payload against the
  schema and would reject it for the missing key. Loosening the schema
  itself is out of this task's scope; see
  `UpdateCatalogItemTaskHandler`'s doc comment
  (`ai/tasks/voice-extended-tasks.ts`) for the full analysis.
- This type is deliberately **absent** from `S1_ALLOWED_PROPOSAL_TYPES`
  (`proposals/surface.ts`) — operator/owner-only, never reachable from an
  unauthenticated inbound caller.

Notes on the Tradesperson wave 1, Task 3 row (`record_refund`, taxonomy 1.8.0):

- **NEW money-class proposal type** — this is the first Tradesperson-wave
  addition that isn't an alias onto an existing type. Never auto-approves at
  any trust tier (D3), same as `record_payment` / `apply_late_fee`.
- **Manual refunds only — Stripe-automated refunds are explicitly OUT OF
  SCOPE** (YAGNI). A refund the owner wants Stripe itself to push back is a
  separate, deliberately unbuilt feature; this proposal type only ever
  records money the owner ALREADY gave back by hand (cash/check/a card
  swiped outside Stripe).
- **Reuses `recordRefund()` (payments/payment-service.ts), not a new refund
  ledger.** The plan's draft assumed a dedicated `PaymentRefundRepository`
  writing into `payment_refunds` (migration `264_create_payment_refunds`) —
  investigation before writing code found that table is NOT a general
  refund record: it's the Stripe webhook idempotency claim ledger
  (`stripe_refund_id TEXT NOT NULL`, unique on `(tenant_id,
  stripe_refund_id)`, no `invoice_id` column at all). `recordRefund()`
  already owns refund recording end to end and enforces the invariant
  `refundedAmountCents + refundCents <= amountCents` atomically; the
  execution handler resolves the invoice's refundable payments
  (`PaymentRepository.findByInvoice`) and calls `recordRefund()` with
  `stripeRefundId: null` — the same "no provider id" branch a webhook-less
  manual refund takes, which never touches `payment_refunds`.
- **Single-payment scope — a `record_refund` never splits across payments**
  (spec-review fix, 2026-08-08). An earlier revision looped `recordRefund()`
  across every refundable payment on the invoice to satisfy an amount
  larger than any one payment; that loop had a genuine partial-state
  window (a concurrent mutation between the headroom snapshot and a later
  chunk's write could leave an earlier chunk committed while the overall
  execution reported failed — the executor commits a failed execution's
  status transition, and everything already written, in the SAME shared
  transaction unless the handler throws instead of returning
  `{success:false}`, which would change the executor's error contract for
  every handler, not just this one). The handler now targets exactly ONE
  payment — the OLDEST refundable payment whose own headroom covers the
  full requested amount — so there is a single `recordRefund()` call,
  already atomic, and zero partial-state window. **Limitation:** a refund
  that fits the invoice's combined refundable total but not any ONE
  payment (e.g. a $500 refund against a $300 deposit + $300 final, neither
  alone enough) fails before any write with a message telling the operator
  to record it as separate smaller refunds — it is never silently split or
  partially applied. See `RecordRefundExecutionHandler`'s doc comment
  (`proposals/execution/record-refund-handler.ts`) for the full analysis of
  why a cross-payment transaction was rejected instead of fixed.
- **No new execution dep** — the handler is wired against the SAME
  `paymentRepo` `record_payment` already uses (app.ts passes it to
  `createExecutionHandlerRegistry` once).
- **The invoice reference resolves the SAME way `record_payment`'s does.**
  There is no separate `invoiceReference` extraction field anywhere in this
  taxonomy — every invoice-doc intent reuses `jobReference`/`jobTitle`,
  disambiguated by `INVOICE_DOC_INTENTS` membership
  (`ai/agents/customer-calling/entity-resolution.ts`). Unlike
  `record_payment`'s contract, `record_refund`'s has **no
  `invoiceReference` fallback field**: an unresolved reference gates
  `missingFields: ['invoiceId']` rather than persisting free text (even a
  bare customer name) as a stand-in "reference" — a deliberately safer
  posture than `record_payment`'s own precedent for the identical case.
- **RBAC finding (no policy change made):** the `CONFIG_WRITING_PROPOSAL_TYPES`
  gate (`proposals/actions.ts`) only restricts proposal types whose
  execution writes TENANT CONFIGURATION (settings); a refund record isn't
  one. Under the CURRENT, pre-existing RBAC policy, any `dispatcher` (not
  just `owner`) holds `proposals:approve` and can approve a `record_refund`
  proposal — identical to how a dispatcher can already approve
  `record_payment` and `apply_late_fee` today. This task did not change
  that policy; it is flagged here because a controller may want a stricter,
  owner-only gate specifically for refunds in the future.
- `refund.recorded` (entityType `invoice`) is a SEPARATE audit event the
  execution handler emits for proposal-level traceability
  (`proposalId`/`proposalType`/`amountCents`/`method`/`paymentId`, plus
  `reason`/`checkNumber` when the operator stated them), alongside whatever
  `payment.refunded` event(s) `recordRefund()` emits per payment touched.
  `refund.recorded` is deliberately **not** added to
  `analytics/audit-event-mapping.ts` — the money signal is already
  captured by `payment.refunded` (which IS mapped there); a second mapped
  product event for the same real-world refund would double-count refund
  volume. This mirrors `expense.logged`'s unmapped-by-design posture.

Notes on the Tradesperson wave 1, Task 4 row (`apply_credit`, taxonomy 1.9.0):

- **NEW money-class proposal type** — reduces what a customer owes on an
  ISSUED invoice (goodwill, warranty labor, price match). Never auto-approves
  at any trust tier (D3), same as `record_payment` / `apply_late_fee` /
  `record_refund`.
- **Mirrors `apply_late_fee`'s mutation shape exactly, with a NEGATIVE,
  floor-guarded line.** `ApplyCreditExecutionHandler`
  (`proposals/execution/apply-credit-handler.ts`) appends a non-taxable line
  item (`unitPriceCents: -amountCents`) and recomputes the document totals
  through the SAME shared billing engine `apply_late_fee` uses — no second
  invoice-mutation route was invented. Unlike `apply_late_fee`, this type has
  no `stepKey`-based idempotency: the periodic dunning sweep that motivates
  `apply_late_fee`'s deterministic line id has no analog here (each credit is
  a one-off, human-approved voice action), and re-execution of the SAME
  proposal is already deduped upstream by `ProposalExecutor`'s
  `IdempotencyGuard` — see the execution handler's doc comment for the full
  analysis of why forcing the stepKey pattern here would be wrong (it would
  wrongly collapse two DIFFERENT, separately-approved credits on the same
  invoice into one line).
- **Floor guard — over-crediting is a refund, not a credit.** A credit may
  never exceed the invoice's current `amountDueCents`; the execution handler
  refuses BEFORE any write with a message naming both amounts
  (`formatUsdCentsPlain`, matching `RecordRefundExecutionHandler`'s style)
  and pointing the caller at `record_refund` instead. Over-crediting would
  mean handing money back that was already collected — that mutates
  PAYMENTS, a materially different operation `record_refund` already owns.
- **Same issued-status precondition as `apply_late_fee`** — only `open` /
  `partially_paid` invoices can be credited, never `draft` (not sent yet) or
  `paid`/`void`/`canceled`.
- **The invoice reference resolves the SAME way `record_payment`/
  `record_refund`'s does** — `INVOICE_DOC_INTENTS` membership
  (`ai/agents/customer-calling/entity-resolution.ts`), `jobReference`
  carries the spoken reference, no separate `invoiceReference` fallback
  field (unresolved gates `missingFields: ['invoiceId']`).
- **`ApplyCreditTaskHandler` lives in its own file**
  (`ai/tasks/apply-credit-task.ts`), not `voice-extended-tasks.ts` (at
  capacity) — house pattern from `complaint-task.ts` / `brand-voice-task.ts`.
- **RBAC posture unchanged (flagged, no policy change):** same as
  `record_refund` — any `dispatcher` holding `proposals:approve` can approve
  an `apply_credit` proposal under the current, pre-existing RBAC policy;
  this task did not add a stricter owner-only gate.
- `credit.applied` (entityType `invoice`) is the execution handler's audit
  event, carrying `proposalId`/`proposalType`/`amountCents`/
  `newAmountDueCents`, plus `reason` when stated. Deliberately not added to
  `analytics/audit-event-mapping.ts` — mirrors `refund.recorded`'s
  unmapped-by-design posture (no existing mapped event double-counts a
  credit the way `payment.refunded` would a refund, but a credit is a pure
  invoice-total adjustment with no separate payment-side event to defer to,
  so this event is the sole record and stays intentionally out of the
  product-analytics mapping to keep this type's traceability scope identical
  to its sibling).

Notes on the Tradesperson wave 1, Task 5 row (`send_customer_message`,
taxonomy 1.10.0):

- **NEW comms-class proposal type** — the highest-frequency gap in the
  2026-08-07 tradesperson plan: a free-form outbound customer message
  ("Text the Hendersons the part arrived", "Email the Garcias that the
  inspection passed", "Let Maria know we're finished and the gate is
  locked"). Never auto-approves at any trust tier (D3), same as
  `notify_delay` / `send_invoice` / `request_feedback` — the owner ALWAYS
  reads the exact text before a customer sees it; the AI drafts, a human
  sends.
- **Routes through the SAME delivery machinery `notify_delay` uses, not a
  new Twilio/email touchpoint.** `SendCustomerMessageExecutionHandler`
  (`proposals/execution/send-customer-message-handler.ts`) depends on a
  structural `CustomerMessenger` interface; production wires
  `TwilioCustomerMessageService`
  (`notifications/twilio-customer-message-service.ts`), built next to
  `delayNotificationService` in `app.ts` from the SAME `MessageDeliveryProvider`
  + `DispatchRepository` + `CustomerRepository` instances. That provider is
  the SAME gated wrapper (`notifications/gated-message-delivery.ts`) that
  enforces the TCPA `sms_consent` + tenant DNC + per-channel kill-switch
  gates for every other customer SMS/email in the product — no new consent
  logic was written. A gate refusal is a THROWN error (`SmsSuppressedError`/
  `EmailSuppressedError`, or this service's own "no phone/email on file"
  checks); the execution handler's `catch` converts it into an honest
  `{ success: false, error }`, never a silent success.
- **Deliberately NOT layered on top of `TwilioDelayNotificationService`
  itself** (Step 1's exemplar for this task), even though
  `DelayNotificationService.sendDelayNotice()` can carry an arbitrary
  message string: its concrete email path hardcodes the subject line
  "Update about your upcoming appointment", which would be actively
  misleading on a message that may have nothing to do with an appointment.
  `TwilioCustomerMessageService` talks to the lower-level
  `MessageDeliveryProvider` directly instead — the same "existing service
  layer," same gates, but with a subject line this proposal type actually
  controls (`payload.subject`, email-only, defaulted generically when
  unstated).
- **Customer resolution mirrors `update_customer` exactly.**
  `send_customer_message` joined `CUSTOMER_REF_INTENTS`
  (`ai/agents/customer-calling/entity-resolution.ts`), so the router
  resolves a spoken customer name to a verified id BEFORE drafting (or
  short-circuits to a `voice_clarification` on an ambiguous match) and
  threads it onto `context.customerId` — the SAME router-injected seam
  `UpdateCustomerTaskHandler` reads. No `customerReference` free-text
  fallback exists on the contract; an unresolved reference gates
  `missingFields: ['customerId']`.
- **The message body is optionally cleaned up by a second, degradable LLM
  call** (`SendCustomerMessageTaskHandler`, `ai/tasks/send-customer-message-
  task.ts`) — mirrors `SuggestReplyTask`'s house pattern for AI-drafted
  customer-facing text, with the system-prompt instruction "Rewrite the
  operator's spoken message as a short, polite customer message. Do not add
  promises, prices, or times the operator did not say." No gateway wired,
  or ANY failure/empty result from the rewrite call, falls back to the
  VERBATIM spoken text — this never fabricates content beyond what the
  operator said, and never blocks the draft on an LLM outage.
- **`channel` defaults to `sms`** when the operator doesn't say "email";
  the contract (`proposals/contracts/send-customer-message.ts`) requires it
  explicitly so a proposal can never execute with an ambiguous channel.
  `body` is capped at 1000 characters and must be non-empty after trimming.
- **New dispatch entity type.** Migration `270_dispatch_entity_custom_message`
  (`db/schema.ts`) widens the `message_dispatches.entity_type` CHECK
  constraint to add `'custom_message'` (`entity_id` = `customers.id`) — the
  same audit-trail table every other outbound send writes to.
- **RBAC posture unchanged (flagged, no policy change):** `send_customer_message`
  is not in `CONFIG_WRITING_PROPOSAL_TYPES` (`proposals/actions.ts`) — its
  execution sends a message, it does not write tenant configuration — so
  approval requires only the generic `proposals:approve` permission every
  `dispatcher` already holds, identical to `notify_delay` / `send_invoice`
  today. This task did not add a stricter owner-only gate.
- This type is deliberately **absent** from `S1_ALLOWED_PROPOSAL_TYPES`
  (`proposals/surface.ts`) — operator/technician-only, never reachable from
  an unauthenticated inbound caller.

Notes on the Tradesperson wave 1, Task 6 row (`create_change_order`,
taxonomy 1.11.0):

- **NEW capture-class proposal type** — mints a NEW estimate pinned to an
  EXISTING job (migration 271 adds `estimates.is_change_order`, NOT NULL
  DEFAULT FALSE, plus a partial index on `(tenant_id, job_id) WHERE
  is_change_order`), so reporting can separate mid-job scope-adds from
  original bids. No money moves at creation — sending the resulting
  estimate to the customer is a later, separate `send_estimate` (comms)
  step — same posture as `draft_estimate`.
- **`jobId` is REQUIRED on the contract** (`proposals/contracts/create-
  change-order.ts`), unlike `draft_estimate`'s optional jobId (which falls
  back to auto-opening a job for a resolved customer). That's the entire
  distinction between this type and a fresh bid: a change order without
  its job is meaningless, so `CreateChangeOrderTaskHandler` (ai/tasks/
  create-change-order-task.ts) never derives or auto-opens one — an
  unresolved reference gates the proposal (`missingFields: ['jobId']`).
- **The job reference resolves the SAME way `update_job`/`log_expense`'s
  does** — `JOB_REF_INTENTS` membership (`ai/agents/customer-calling/
  entity-resolution.ts`), the router resolving the spoken jobReference to
  a verified `jobId` stamped onto `context.existingEntities.jobId` BEFORE
  this handler runs. No LLM call in the drafting leg: the added work is a
  single named line, not a multi-line quote the model needs to structure.
- **`isChangeOrder` survives `cloneEstimate`** (`estimates/estimate.ts`) —
  quality-review fix. Clone is the documented escape hatch for editing a
  locked (sent/accepted) estimate; `isChangeOrder` is a classification of
  what the estimate IS, not lifecycle state, so it must NOT reset to false
  on clone — that would launder a change order into a plain estimate on
  its very first correction, defeating migration 271's reporting purpose.
- **The catalog-grounding passthrough fields are declared on the line-item
  contract, not just produced by the resolver** (quality-review fix,
  `proposals/contracts/create-change-order.ts`): `unit` / `category` /
  `catalogItemId` / `pricingSource` / `needsPricing` / `totalCents` /
  `imageFileId` / `id` all mirror `contracts.ts`'s shared `lineItemSchema`.
  Zod strips any undeclared key, and `CreateChangeOrderExecutionHandler`
  parses the payload through this schema BEFORE handing line items to
  `normalizeDraftLineItems` — the function that forwards exactly these
  fields onto the persisted row. A narrower schema silently destroyed the
  catalog-grounded-vs-AI-invented signal on every change order (the same
  parity bug B7.5/EE-4 fixed for the shared estimate/invoice path).
- **Catalog price grounding** — the single line item (built from
  `changeOrderDescription` + the spoken `amount`) is run through
  `groundLineItemPricing` (ai/resolution/catalog-resolver.ts), the SAME
  tenant-catalog grounding pass `draft_estimate`/`draft_invoice` use: a
  catalog match overrides the spoken price; an uncatalogued price rides
  as-is, flagged via the RV-007 confidence-marker `_meta` for human review.
  A line that ends up with NO resolvable price (no spoken amount, no
  catalog match — the classifier's own canonical example, "Customer added
  three more outlets — write it up") gates the proposal
  (`missingFields: ['lineItems[0].unitPriceCents']`) rather than drafting
  ungated and failing post-approval at execution (quality-review fix).
  `_meta.overallConfidence` is ALWAYS present when `_meta` is set (a
  REQUIRED field on the shared `_meta` envelope, contracts.ts) — its
  absence was a quality-review-caught bug that made every uncatalogued
  change order fail `assertValidProposalPayload` the moment an operator
  tried to edit or approve it. Unlike the LLM-drafting handlers, no
  numeric `confidenceScore`/cap exists here (no LLM call); the real
  auto-approve safety is that this task omits `sourceTrustTier` entirely,
  so `decideInitialStatus`'s auto-approve branch is never reached at any
  confidence.
- **`title` has no home on the `Estimate` entity** (estimates carry no
  title/name column) — `CreateChangeOrderExecutionHandler`
  (`proposals/execution/create-change-order-handler.ts`) folds the title
  into `internalNotes` alongside the proposal id for traceability;
  `customerMessage` is a separate, optional field that rides straight onto
  the created estimate. The title-prefixing logic (`changeOrderTitle` /
  `ensureChangeOrderTitle`) lives in ONE place
  (`proposals/contracts/create-change-order.ts`), imported by both the
  drafting task and the execution handler — a quality-review fix for a
  double-prefix bug the previous duplicated-literal version had on the
  no-description fallback path.
- **Customer-visibility asymmetry (v1 product decision, flagged, not
  fixed here):** a change order's created estimate arrives on the public
  customer approval page BYTE-IDENTICAL to a fresh bid —
  `PublicEstimateView` never reads `isChangeOrder` or `internalNotes` (the
  title lives only in `internalNotes`), and the drafting task never
  populates `customerMessage`, so the only customer-visible description is
  the single line item's own text. Migration 271 distinguishes change
  orders internally (reporting, the operator-facing internal notes) but
  the CUSTOMER sees no difference from an original bid. Filed as a known
  v1 gap rather than fixed in this task.
- **Needs BOTH `estimateRepo` and `settingsRepo`** to be fully wired — like
  `DraftEstimateExecutionHandler`, minting a real `estimateNumber` requires
  `getNextEstimateNumber` (settings/settings.ts). Registered in the SAME
  `if (deps?.estimateRepo)` block as `update_estimate` (handlers.ts);
  `isFullyWired()` fails closed without `settingsRepo` too.
- **Deliberately does NOT thread `auditRepo` into `createEstimate()`**
  (which would additionally emit a generic `estimate.created` event):
  migration 271 exists precisely so reporting can separate change-order
  volume from original-bid volume, and double-emitting `estimate.created`
  would pollute that same `estimate_created` product-analytics counter
  (`analytics/audit-event-mapping.ts`). This handler's own
  `estimate.change_order_created` event (entityType `estimate`) is the
  sole record, deliberately **not** added to `audit-event-mapping.ts` —
  mirrors `credit.applied` / `refund.recorded` / `expense.logged`'s
  unmapped-by-design posture.
- **RBAC posture unchanged (flagged, no policy change):** `create_change_order`
  is not in `CONFIG_WRITING_PROPOSAL_TYPES` (`proposals/actions.ts`) — its
  execution drafts an estimate, it does not write tenant configuration —
  so approval requires only the generic `proposals:approve` permission
  every `dispatcher` already holds, identical to `draft_estimate` today.
  This task did not add a stricter owner-only gate.
- This type is deliberately **absent** from `S1_ALLOWED_PROPOSAL_TYPES`
  (`proposals/surface.ts`) — operator/technician-only, never reachable from
  an unauthenticated inbound caller.

Notes on the Tradesperson wave 1, Task 7 row (`create_service_agreement`, taxonomy 1.12.0):

- **NEW capture-class proposal type** — signs a customer up for a
  recurring maintenance plan/membership ("Sign the Garcias up for the
  annual maintenance plan, 290 a year"). Writes a `service_agreements` row
  (migration 056, which was already live before this task — no new
  migration was needed).
- **Reuses the existing agreements substrate end to end, does not
  reimplement it.** `CreateServiceAgreementExecutionHandler`
  (`proposals/execution/create-service-agreement-handler.ts`) writes
  through `createAgreement` (`agreements/agreement-service.ts`) — the SAME
  function the authenticated `POST /api/agreements` route calls, which in
  turn writes through the SAME `AgreementRepository`
  (`agreements/agreement.ts`, Pg-backed via `agreements/pg-agreement.ts`)
  the recurring-agreements sweep (`runDueAgreements`, driven by
  `workers/recurring-agreements-worker.ts`) reads from. Quality-review fix
  (I1) — an earlier revision hand-assembled the `Agreement` row instead of
  calling `createAgreement`, duplicating six defaults
  (`autoGenerateInvoice`/`autoGenerateJob`/`autoRenew`/`renewalCount`/
  `memberDiscountBps`/`priorityBooking`/`autoCollectDues`) and skipping
  three invariants (`endsOn >= startsOn`, the auto-renew term invariant,
  `parseRule` validation) that live in `createAgreement` — most of those
  fields are OPTIONAL on the `Agreement` interface (added well after the
  original table), so the type system could not have caught a future
  hand-rolled copy silently missing one. Calling `createAgreement` means
  `computeFirstRun` (its internal `nextRunAt` calculation) runs there too;
  on TODAY's 4-cadence mapping table this is currently equivalent to a
  plain copy of `startsOn` (`computeFirstRun` only diverges when the rule
  carries `BYMONTHDAY`, which none of the four mappings emit) — reusing
  the shared function is parity with the authenticated route and
  future-proofing, not a fix for a live bug on today's table.
- **`createAgreement`'s own audit call is suppressed** (called with
  `undefined` as its audit-repo argument) because that call is not
  failure-soft (no try/catch) — a thrown audit error there would propagate
  AFTER the row was already inserted, misreporting a successful create as
  a failed execution. The execution handler emits its OWN failure-soft
  `service_agreement.created` event afterward instead, exactly like every
  other LogExpense-family handler (`log-expense-handler.ts`).
- **No money moves at creation.** `createAgreement`'s own doc comment
  explains that service agreements bypass the proposals layer for their
  RECURRING runs (each cycle's job/invoice generation is pre-approved
  standing consent from the sign-up itself) — this task adds the sign-up
  step itself as a reviewed proposal; once approved, the resulting row is
  swept by the exact same unmodified `runDueAgreements` machinery as a
  form-created agreement, and each generated invoice rides the normal
  review path already in place for that invoice type.
- **CRITICAL fix (C1) — service-location resolution.** The drafting task
  has no location-reference extraction seam, so `payload.locationId` is
  ALWAYS absent on a voice-drafted proposal. `runDueAgreements` generates
  each cycle's job with `locationId: agreement.locationId ?? ''`, and job
  creation REJECTS an empty `locationId` — so before this fix, EVERY
  voice-created agreement produced a `failed` run on EVERY sweep tick
  (every 60 seconds — app.ts), forever, with the only trace being a
  buried `agreement_runs` row (`nextRunAt` also advances on a failed run,
  so the cycle was never retried either). `CreateServiceAgreementExecutionHandler`
  now resolves the customer's PRIMARY active service location, else their
  first active location, at execution time — the SAME ladder
  `EmergencyDispatchExecutionHandler` and `CreateJobExecutionHandler`/
  `CreateAppointmentExecutionHandler` (`handlers.ts`) already use. A
  customer with no active location at all fails execution outright
  ("Customer has no service location — add one before starting a plan")
  rather than persisting a row the sweep can never service. Disabling
  `autoGenerateJob` as a workaround was considered and rejected:
  `createInvoice` independently requires a `jobId` (`invoices/invoice.ts`),
  so a location-less agreement can never produce either side effect.
  `isFullyWired()` requires BOTH `agreementRepo` and `locationRepo` for
  this reason — a missing `locationRepo` is not a degraded-but-usable
  mode here, since v1 never supplies a payload `locationId` at all. (The
  underlying "an agreement can be created with no location" hole is
  PRE-EXISTING and repo-wide — the authenticated route's `locationId` is
  optional too, and no test anywhere covered a no-location agreement
  before this task's sweep round-trip test; this fix closes it for the
  voice path specifically, not the route.)
- **PERPETUAL by default (info, not a bug).** A voice-created agreement
  never sets `endsOn`, so `autoRenew: false` does not actually BOUND
  anything — `autoRenew` only controls whether a LAPSED `endsOn` rolls
  forward; with no `endsOn`, nothing ever lapses. "No auto-renew" reads
  safer than it is: a voice-signed-up plan runs indefinitely until an
  operator manually pauses or cancels it from the agreements screen.
- **Idempotent replay, not just a synthetic-id passthrough.** Like
  `create_change_order`, this handler mints a brand NEW row on every
  `execute()` call (unlike `apply_credit`/`record_refund`, which mutate an
  EXISTING row and are naturally idempotent elsewhere) — a `resultEntityId`
  already stamped on the proposal short-circuits to a pure replay so a
  redelivered/re-executed approval can never sign the same customer up
  twice.
- **Customer resolution mirrors `send_customer_message` exactly** (not
  `apply_credit`'s invoice-reference pattern): `create_service_agreement`
  joined `CUSTOMER_REF_INTENTS` (`ai/agents/customer-calling/entity-
  resolution.ts`), so the router resolves a spoken customer name to a
  verified id BEFORE drafting and threads it onto `context.customerId`
  (the top-level `TaskContext` field, not
  `context.existingEntities.customerId`). An unresolved reference gates
  `missingFields: ['customerId']`.
- **Cadence is a fixed 4-token enum, mapped deterministically to an
  RRULE — no LLM call.** The classifier normalizes the spoken cadence word
  onto one of `monthly`/`quarterly`/`twice_a_year`/`annual` (synonyms like
  "semiannual"/"yearly" map onto the same tokens); `quarterly` and
  `twice_a_year` are expressed as `FREQ=MONTHLY;INTERVAL=3` and
  `FREQ=MONTHLY;INTERVAL=6` respectively. `FREQ=QUARTERLY;INTERVAL=2` is an
  EQUALLY valid RRULE for "every 6 months" (`recurrence.ts`'s
  `nextOccurrence` steps a `quarterly` frequency by `interval * 3` months)
  — `MONTHLY;INTERVAL=6` was chosen so every multi-month cadence in this
  table rides the same `FREQ`, not because the engine lacks a
  `QUARTERLY`-based equivalent. The mapping table is typed against the
  classifier's own cadence union (`Record<ServiceAgreementCadence,
  string>`), not a widened `Record<string, string>`, so a fifth cadence
  token added later without a matching RRULE entry is a COMPILE error, not
  a silent gate. An absent/unrecognized cadence gates
  `missingFields: ['recurrenceRule']`. **Weekly/biweekly cadences (lawn
  care, pool service, pest control — core recurring-trades work) are
  UNSUPPORTED by the recurrence engine itself** (`RECURRENCE_FREQUENCIES`
  is `monthly | quarterly | yearly` only, `agreements/enums.ts`) — a
  spoken "weekly" gates on `missingFields: ['recurrenceRule']` with no
  further explanation on the card; this is a real product gap, not a bug,
  filed here so the gate isn't mysterious.
- **`startsOn` defaults to the first of next month computed from the
  TENANT's local calendar date** (`shared/timezone.ts localDateKey`), never
  raw server-local `Date` math — a naive default is off by a day for any
  tenant whose local "today" differs from the server/UTC day. This is a
  DELIBERATE, narrower exception to the general "never silently default an
  unresolved tenant timezone" rule (the Phoenix mis-booking incident
  documented in `voice-action-router.ts`): the blast radius of a wrong
  START DATE — possibly off by one day, on a review card the operator
  reads before approving, for a sweep run weeks away — is materially
  smaller than a mis-timed booking. The assumption is made VISIBLE rather
  than silent: whenever the fallback timezone is used, the proposal's
  `explanation` names it (e.g. "…starting Sep 1 2026 (assumed
  America/New_York — tenant timezone unset)").
  A spoken override ("starting September", "October 1st") is parsed
  best-effort via chrono-node, anchored to the tenant-local "now" (mirrors
  `ai/scheduling/resolve-datetime.ts`'s own chrono+luxon reference-date
  construction, minus the exact-time/daypart requirement — this field is a
  bare calendar DATE, never a time-of-day), guarded (quality-review I2)
  against two classes of bad parse: (1) a fully AMBIGUOUS relative phrase
  with neither an explicit month nor day named — chrono still returns a
  best guess for "a year"/"last year" (reading them as a bare duration
  from "now"), and that guess is materially wrong for the classifier's own
  canonical example ("290 A YEAR" could drop "a year" into this field);
  (2) a resolved date already in the tenant's PAST ("January 2019") —
  `runDueAgreements` (the sweep, every 60 seconds) would pick a back-dated
  `nextRunAt` up on its very next tick and advance ONE interval per pass,
  so a back-dated MONTHLY plan would drip a job+invoice pair roughly once
  a MINUTE until it caught up to today. Either guard tripping, or chrono
  simply failing to parse, falls back to the computed default rather than
  gating — a soft scheduling default the reviewer can correct before
  approving is not the "silent guess" the P0 voice-safety invariant
  targets. The contract (`proposals/contracts/create-service-agreement.ts`)
  layers two backstops: `startsOn` must be a REAL calendar date (not just
  `YYYY-MM-DD` shape — `computeFirstRun` feeds the string straight into
  `Date.UTC` with no further validation, so "2026-02-30" would otherwise
  silently roll over to March 2), and must not already be in the past
  (computed fresh per validation call against the server's wall clock —
  defense in depth behind the drafting task's tenant-aware guard above).
- **`explanation` renders the plan in plain language, not the raw
  RRULE.** No operator reviewing a card verifies `"FREQ=MONTHLY;
  INTERVAL=6"` by eye. `Proposal.explanation` (rendered on the review card
  without touching the payload's Zod contract) carries a summary like
  "Twice a year, $290.00, starting Sep 1 2026" instead, built from
  whatever of {cadence, price, start date} is concretely known.
- **A $0 plan is legal at the contract layer but never reachable by voice
  today.** `priceCentsSchema` (`agreements/enums.ts`) is non-negative, so a
  `priceCents: 0` payload (a comp membership) validates — a legitimate
  configuration for a future non-voice caller (a hand-edited proposal, or
  a comp-plan UI path). `CreateServiceAgreementTaskHandler` is stricter on
  purpose: it requires a POSITIVE spoken amount (`ee.amount > 0`), because
  voice cannot distinguish "the caller said zero" from "the caller didn't
  state a price" — the voice path can never currently produce
  `priceCents: 0`. The contract also caps `priceCents` at a $100,000/period
  sanity ceiling (quality-review minor) — a backstop against a misheard
  "290 thousand a year" persisting a $2.9M/period plan, not a real product
  limit.
- **No `_meta` confidence marker.** Unlike `create_change_order`, there is
  no catalog grounding or LLM call in this handler that would produce a
  real confidence signal on a plan price — `_meta` is omitted rather than
  fabricated (`overallConfidence` is a REQUIRED field on the shared `_meta`
  envelope whenever `_meta` is present at all).
- **Never auto-approves.** The drafting task deliberately omits
  `sourceTrustTier`, so `decideInitialStatus`'s only auto-approve branch
  (`sourceTrustTier === 'autonomous' AND` capture-class) is never reached
  at any confidence — same posture as `create_change_order` /
  `create_standing_instruction`.
- **New fields voice-extractable in v1 only:** `customerId` (router-
  resolved), `name` (`serviceAgreementName`), `recurrenceRule` (from
  `serviceAgreementCadence`), `priceCents` (the existing `amount` seam),
  and `startsOn` (`serviceAgreementStartsOn`, optional). `locationId` /
  `description` / `autoRenew` / `renewalTermMonths` / `memberDiscountBps` /
  `priorityBooking` / `autoCollectDues` all exist on the contract (mirroring
  the authenticated route) but have no voice extraction seam yet — a v1
  scope decision, not an oversight; the new rows default to
  `autoGenerateInvoice: true`, `autoGenerateJob: true`, no auto-renew, no
  member discount, no priority booking, no auto-collect-dues, matching
  `createAgreement`'s own defaults.
- **RBAC posture unchanged (flagged, no policy change):**
  `create_service_agreement` is not in `CONFIG_WRITING_PROPOSAL_TYPES`
  (`proposals/actions.ts`) — its execution writes a customer-scoped
  agreement, not tenant configuration — so approval requires only the
  generic `proposals:approve` permission every `dispatcher` already holds,
  identical to `draft_estimate`/`create_change_order` today. This task did
  not add a stricter owner-only gate, even though signing a customer up
  for a recurring charge is a meaningfully different risk profile than a
  note or a job-field edit; a controller may want to reconsider this in
  the future.
- This type is deliberately **absent** from `S1_ALLOWED_PROPOSAL_TYPES`
  (`proposals/surface.ts`) — operator/technician-only, never reachable
  from an unauthenticated inbound caller.

Notes on the Tradesperson wave 1, Task 9 row (`add_material`, taxonomy 1.13.0):

- **NEW capture-class proposal type** — adds a row to the voice-captured
  shopping list. Writes a `material_items` row (migration 272, Task 8's
  substrate — `src/materials/material-item.ts`, `PgMaterialItemRepository`
  / `InMemoryMaterialItemRepository`). No money moves, and it's reversible
  (the row can be marked purchased via `markPurchased`, or simply
  ignored) — same posture as `log_expense`.
- **Wires Task 8's dormant substrate.** `material_items` shipped in Task 8
  with zero callers — nothing constructed a repo instance and no voice
  intent read/wrote through it. This task is what gives it real callers:
  `AddMaterialExecutionHandler` (`proposals/execution/
  add-material-handler.ts`) writes through it, and `lookup_materials`
  (below) reads from the SAME instance (`app.ts` constructs one
  `materialItemRepo` and threads it into both the execution-handler
  registry and `lookupAnswerDeps`).
- **jobId is OPTIONAL, unlike `create_change_order`'s REQUIRED jobId.** A
  shopping-list item can be unlinked to any job ("grab three boxes of PEX"
  with no job named is still a perfectly good capture) — `add_material`
  joined `JOB_REF_INTENTS` (`entity-resolution.ts`) so a NAMED job still
  resolves to a verified id, but an unresolved/absent reference never
  gates the proposal (same posture as `log_expense`'s jobId).
- **`neededBy` accepts a PAST date — a deliberate divergence from Task
  7's `startsOn`.** `startsOn` (`create-service-agreement.ts`) rejects a
  past date because a back-dated value feeds a 60-second recurring sweep
  that would immediately drip a job+invoice pair. `neededBy` has no such
  consumer — nothing sweeps, bills, or repeats off it, and Task 8's
  `listPending` doesn't even filter by it — so a tradesperson genuinely
  saying "we needed this yesterday" is a real, useful shopping-list
  signal, not a malformed one. See `contracts/add-material.ts`'s module
  doc comment for the full rationale.
- **`quantity`'s domain cap (1,000,000) is imported, not duplicated
  (quality-review I6).** The contract imports `MAX_QUANTITY` from
  `material-item.ts` rather than repeating the literal — the SAME number
  enforced at the repo layer, structurally, so a payload that passes the
  draft-time contract can never throw at execution against a stricter
  repo-layer check (the divergence class Task 6's change-order contract
  first surfaced, and which a mere "keep these in sync" comment cannot
  prevent on its own).
- **`description` rejects whitespace-only input (quality-review I5).**
  The contract trims BEFORE checking length
  (`z.string().trim().min(1).max(1000)`) — without `.trim()`, a
  spoken-then-mistranscribed `"   "` would pass this draft-time gate and
  only fail later at execution against `material-item.ts`'s own
  (trim-then-check) validator, exactly the "contract looser than the
  layer it feeds" class this task's own `quantity` cap guards against on
  a different field.
- **Audit event: `material.requested`, entityType `material_item`.**
  "Requested" names what happened from the shop's point of view (a
  tradesperson asked for a part), not that it physically arrived —
  `markPurchased` is the event that would earn a past-tense verb.
  `entityType` is `material_item` (singular of the `material_items`
  table), mirroring `service_agreement.created`'s choice over the bare
  domain-object name. Like `expense.logged`/`credit.applied`/
  `refund.recorded`, this event is deliberately **not** added to
  `audit-event-mapping.ts` — same unmapped-by-design posture.
- **Idempotent replay, not just a synthetic-id passthrough.** Like
  `create_change_order`/`create_service_agreement`, this handler mints a
  brand NEW row on every `execute()` call — a `resultEntityId` already
  stamped on the proposal short-circuits to a pure replay so a
  redelivered/re-executed approval can never double-add the same item.
- **No `_meta` confidence marker.** No catalog grounding or LLM call
  anywhere in this type's drafting leg produces a real confidence signal
  on a shopping-list line — `_meta` is omitted rather than fabricated,
  same posture as `create_service_agreement`.
- **Never auto-approves (today).** The drafting task deliberately omits
  `sourceTrustTier`, so `decideInitialStatus`'s only auto-approve branch
  is never reached at any confidence — same posture as
  `create_change_order`/`create_service_agreement`. A shopping-list add is
  about as low-risk as a capture-class action gets, so a future revision
  may reconsider graduating it to the autonomous lane; that is a
  deliberate scope decision for a later pass, not an oversight here.
- **RBAC posture unchanged (flagged, no policy change):** `add_material`
  is not in `CONFIG_WRITING_PROPOSAL_TYPES` (`proposals/actions.ts`) —
  its execution writes an operational shopping-list row, not tenant
  configuration — so approval requires only the generic
  `proposals:approve` permission every `dispatcher` already holds,
  identical to `draft_estimate`/`create_change_order`/
  `create_service_agreement` today.
- This type is deliberately **absent** from `S1_ALLOWED_PROPOSAL_TYPES`
  (`proposals/surface.ts`) — operator/technician-only, never reachable
  from an unauthenticated inbound caller.

`lookup_materials` (read-only, Section E) reads the same substrate back:

- **Bounded fetch, not "load everything and slice" (quality-review I4).**
  `ai/skills/lookup-materials.ts` fetches at most `MAX_ITEMS_SPOKEN + 1`
  (6) rows via `MaterialItemListOptions.limit` — a NEW option Task 9 added
  to Task 8's `MaterialItemListOptions`/`PgMaterialItemRepository`/
  `InMemoryMaterialItemRepository`. A shopping list is append-mostly (only
  `markPurchased` prunes it), so the original unbounded `SELECT *` loaded
  every pending row for the tenant just to speak 5 of them. Because the
  fetch is capped, the skill genuinely cannot report an exact total once a
  tenant has more than 5 pending items — `data.count` is `null` in that
  case (never a guessed number) and the summary says "5+ items" rather
  than a false-precise total. This is a deliberate divergence from
  `lookup_catalog` (which fetches the tenant's WHOLE catalog and lets the
  WORKER slice, since other consumers need every item) — there is no
  non-TTS consumer of the pending shopping list today.
- **An unresolved spoken job reference refuses honestly (spec-review
  MAJOR A).** "What materials are open on the Patel job?" with no
  matching Patel used to silently fall through to the UNFILTERED tenant
  list, announced as a normal found-answer — the worse failure mode,
  since the operator actively named a scope. `executeLookupAnswer`'s
  `lookup_materials` case (`workers/voice-lookup-answer.ts`) now mirrors
  `lookup_job_profit`'s identical guard: `jobReference` present but
  `jobId` absent → `"I couldn't find a job matching \"…\""`, never a
  silent widen. Absent any jobReference at all, the unfiltered (or
  job-scoped, when `jobId` resolved) list remains the correct, INTENDED
  answer for "read me the shopping list".
- **"For tomorrow" is not a filter, but `neededBy` IS spoken (spec-review
  MAJOR B).** Task 8's `MaterialItemListOptions` has no date filter, so
  the taxonomy no longer advertises "what parts do I need tomorrow?"
  phrasing — a date-scoped ask now classifies elsewhere rather than
  quietly returning an unfiltered list under a promise the query can't
  keep. But `neededBy` IS captured by `add_material` and persisted on
  every row, so silently never mentioning it on the read side would mean
  this module collects data it then hides from the person who spoke it:
  each spoken/rendered item now states its needed-by date when present
  ("3 boxes of PEX, quantity 3, needed by August 9"), letting the operator
  identify which of the (possibly unfiltered) items are time-sensitive
  themselves. A real `neededBy` QUERY filter is a genuine Task 8 contract
  extension, filed as separate follow-up work — not done here.
- **TTS-safe quantity wording (quality-review I2).** The original
  `${quantity}× ${description}` shape used U+00D7 MULTIPLICATION SIGN,
  which Amazon Polly reads as "times" in a numeric context ("3× 3 boxes"
  → "three times three boxes," i.e. nine) and Google Cloud TTS typically
  drops entirely. Every quantity is now spoken as the word "quantity".
- **Spoken items are the OLDEST pending, not the newest.** Mirrors Task
  8's own `listPending` contract (oldest-created-first); a caller with
  more than 5 pending items hears the 5 that have been waiting longest,
  and "and more beyond that" hides the most RECENTLY added ones — a
  plausibly surprising order for a shopping list, documented here and in
  `lookup-materials.ts`'s own module doc comment rather than left
  implicit.
- **`lookup_events.result_count` SATURATES at 6 for this intent.** The
  bounded fetch (I4, above) means the row written by `record()` carries
  rows-fetched, capped at `MAX_ITEMS_SPOKEN + 1` (6) — never the true
  pending total once it exceeds that. `avg(result_count) where intent =
  'lookup_materials'` (or any analytics query treating this column as an
  exact count) is therefore a ceilinged metric: a genuine 6 pending items
  is indistinguishable from a genuine 600. See `lookup-events/lookup-event.ts`'s
  `resultCount` doc comment.

Notes on the Tradesperson wave 1, Task 11 row (`log_mileage`, taxonomy 1.15.0):

- **ALIAS onto the EXISTING `log_expense` proposal type — no new
  ProposalType, no new execution handler, no migration.** A technician
  logs drive miles for the tax-deduction mileage log ("Log 32 miles to
  the Patel job"); the resulting row is a plain `expenses` row with
  `category: 'vehicle'`, indistinguishable in storage from a manually
  logged vehicle expense.
- **Branches inside `LogExpenseTaskHandler`, not a subclass or a second
  file.** House precedent for a no-op alias (`schedule_inspection` →
  `create_appointment`, `log_permit` → `add_note`) is a thin dispatch-only
  alias where the target handler runs completely unchanged. `log_mileage`
  can't follow that byte-for-byte — it needs its OWN math (miles × rate)
  the plain `log_expense` drafting never does.
- **Quality-review fix (2026-08-09) — the branch keys on `context.intent
  === 'log_mileage'`, not the presence of `mileageMiles`.** `TaskContext`
  gained an `intent?: IntentType` field (`ai/tasks/task-handlers.ts`),
  threaded at the `voice-action-router.ts` dispatch site, specifically to
  fix this: the branch originally keyed on the mere PRESENCE of the
  `mileageMiles` extracted-entity field, reasoned as safe because "a plain
  `log_expense` utterance never extracts `mileageMiles`" — but that is a
  PROMPT-LEVEL instruction to the model, not a structural guarantee.
  `entitiesForProposal` (`workers/voice-action-router.ts`) is a passthrough
  for every intent except `create_customer`, and the classifier's JSON
  response shape is ONE GLOBAL template shared by every intent — nothing
  stops a real utterance ("drove 32 miles round trip, spent $240 on
  fittings") from classifying `log_expense` while the model still emits
  `mileageMiles` alongside the real `amount`, or the mirror image (a
  `log_mileage` turn where the model puts the heard number on the shared
  `amount` key instead). Field-presence keying let either direction hijack
  or silently vanish; `context.intent` is the classifier's actual verdict,
  so neither can. A stray `expenseDescription` or `amount` on a
  `log_mileage` turn is folded into the visible description rather than
  discarded, so the operator always sees everything the model heard.
- **`amountCents = round(miles × DEFAULT_MILEAGE_RATE_CENTS_PER_MILE)`.**
  `DEFAULT_MILEAGE_RATE_CENTS_PER_MILE` (70¢, `ai/tasks/voice-extended-
  tasks.ts`) is the 2026 IRS standard mileage rate — a CONSTANT, not
  tenant config (the IRS publishes one national rate per year; this isn't
  a per-tenant business setting the way a labor rate is). Gated on the
  COMPUTED CENTS, not the raw miles — any `0 < miles < 1/140` (~0.00714)
  rounds to 0 cents, which would pass a bare `miles > 0` check yet violate
  the contract's `amountCents.positive()` at execution.
- **Miles get a domain cap (0 < miles ≤ 10,000).** `MAX_MILEAGE_MILES`
  (exported, `ai/tasks/voice-extended-tasks.ts`) is a SANITY BOUND on a
  spoken figure, not an overflow guard: `expenses.amount_cents` is
  Postgres `INTEGER` (int4, max 2,147,483,647), which at this rate would
  need roughly 30.7 MILLION miles to overflow. 10,000 is a domain judgment
  ("no single logged trip is five figures of miles"), not a boundary the
  overflow math requires. `logExpensePayloadSchema` has NO upper bound on
  `amountCents` (a real expense — a new work van — legitimately runs into
  the tens of thousands), so this handler-level cap on MILES is the only
  thing standing between an STT-garbled spoken figure and Postgres; that
  is the actual argument for having any cap at all. An out-of-range value
  (0, negative, or over the cap) gates on `amountCents` exactly like a
  genuinely absent one — never silently clamped.
- **`spentAt` is TODAY in the TENANT timezone as a full ISO instant, not a
  bare date string (Task 7's lesson, quality-review fix).** `spent_at` is
  TIMESTAMPTZ (`schema.ts`) and `LogExpenseExecutionHandler` parses the
  payload's `spentAt` with `new Date(spentAtRaw)`, which reads a bare
  `'YYYY-MM-DD'` string as UTC MIDNIGHT — silently rendering back as the
  PREVIOUS calendar day in any tenant west of UTC, the exact off-by-one
  this fix exists to eliminate. `tzMidnight(localDateKey(now, tz), tz)`
  (`shared/timezone.ts`) converts the tenant-local calendar date into the
  correct UTC instant instead; the contract explicitly allows a full ISO
  timestamp. Uses the shared `resolveTenantTimezone` (`ai/tasks/
  task-input.ts` — lifted here from four independent copies, quality
  review "I4"), falling back to `DEFAULT_TENANT_TIMEZONE` when the tenant
  zone is unresolved. Applies to the PLAIN `log_expense` path too, not
  just `log_mileage` — same flaw, same fix, computed once for both. No
  past-date guard is needed for either (unlike Task 7's `startsOn`, which
  feeds a 60-second recurring sweep): nothing sweeps, bills, or repeats
  off this field, mirroring `add_material`'s `neededBy` reasoning, not
  `startsOn`'s.
- **`jobReference` joins `JOB_REF_INTENTS` mirroring `log_expense`'s OWN
  membership exactly** (`entity-resolution.ts`) — jobId stays OPTIONAL on
  the (shared) contract, so an unresolved/absent reference still logs the
  mileage UNLINKED; resolution only ever ADDS the link. Also mirrors
  `log_expense`'s `CUSTOMER_REF_INTENTS` membership for full parity with
  its target — `log_mileage`'s own taxonomy doesn't ask the classifier for
  `customerName`, but it's a SHARED template key, so a real utterance
  ("log 32 miles for the Hendersons") could still populate it, and this
  membership is what resolves that name to a customerId instead of
  leaving it inert.
- **`voiceProposalSummary` gives `log_mileage` its own copy** ("Log
  mileage on `<job>`" / "for `<customer>`", mirroring `log_permit`'s
  preposition convention) rather than falling through to the generic
  `Voice intent: log_mileage` debug fallback (the exact drift-guard gap
  Task 9 shipped and a later review caught).
- **Field name is `mileageMiles`, not the plan's literal suggested `miles`.**
  A generic key like `miles` in a shared, cross-intent entity bag risks a
  future collision; the qualified name is the better choice and is applied
  consistently everywhere (interface, JSON template, parse allowlist) —
  recorded here as a deliberate divergence from the plan text, not an
  oversight.
- This type is deliberately **absent** from `S1_ALLOWED_PROPOSAL_TYPES`
  (`proposals/surface.ts`) — it aliases `log_expense`, which is itself
  operator/technician-only, never reachable from an unauthenticated
  inbound caller.

Notes on the Tradesperson wave 1, Task 12 row (`add_catalog_item`, taxonomy 1.16.0):

- **NEW capture-class proposal type** — the create-side mirror of
  `update_catalog_item` (Task 2): an owner adds a price-book entry by
  voice ("Add a catalog item: smart thermostat install, 385"). No money
  moves at creation (only shapes FUTURE drafts, which are themselves
  reviewed), no customer is contacted, and it's reversible (archive the
  item from the Catalog screen).
- **Extraction seams REUSE Task 2's fields — no new fields for name/
  description/price.** `catalogItemNewName` / `catalogItemNewDescription`
  / `unitPriceCents` already existed on `ExtractedEntities`
  (`update_catalog_item`); their meaning generalizes cleanly to a CREATE
  ("the NEW name" is exactly what's true of a brand-new item's only
  name). Reusing them avoids minting a duplicate field for the same
  concept on the shared, cross-intent entity bag, and carries no
  field-presence-hijack risk (Task 11's `TaskContext.intent` concern):
  `add_catalog_item` and `update_catalog_item` dispatch to DIFFERENT
  drafting AND execution handlers, so a stray value on the wrong intent's
  turn is simply never read. Only ONE genuinely new field was added:
  `catalogItemUnit` (`CatalogUnit`'s 5-token vocabulary) — no existing
  field carried a catalog unit of measure. See
  `AddCatalogItemTaskHandler`'s doc comment (`ai/tasks/add-catalog-item-
  task.ts`) for the full reuse-vs-new analysis.
- **Zero is a LEGAL `unitPriceCents` — contract and drafting gate
  deliberately AGREE at that boundary.** A free/comp price-book line ("free
  estimate", "no-charge warranty inspection") is a real, common catalog
  entry for a tradesperson — a DELIBERATE divergence from
  `create_service_agreement`'s stricter, positive-only voice gate for a
  RECURRING plan price (a stated $0 RECURRING charge is inherently
  suspicious; a one-time price-book SKU is not). Both
  `contracts/add-catalog-item.ts`'s Zod schema and
  `AddCatalogItemTaskHandler`'s hand-written gate use the exact same
  `>= 0` boundary, so they can never disagree the way a prior task's
  review found for a different type (contract accepted 0, the task
  refused to draft on 0, and two passing tests locked the contradiction
  in without either side ever exercising the disagreement). A sanity
  ceiling ($100,000, mirroring `create-service-agreement.ts`'s identical
  backstop) guards against a misheard "290 thousand" style figure — not a
  real product limit, and NOT a shared constant (the domain/HTTP layer
  places no upper bound on `unitPriceCents` at all, so there is nothing
  to keep in lockstep with).
- **`category`/`unit` defaults live at EXECUTION time, not drafting.**
  `CatalogItem.category`/`.unit` are BOTH required at the domain layer,
  but this intent's taxonomy has no category extraction seam at all (a v1
  scope decision — category is a business-taxonomy choice a tradesperson
  rarely states aloud alongside a price) and `unit` is only sometimes
  spoken. `AddCatalogItemExecutionHandler` defaults `category: 'Labor'`
  (both taxonomy examples are installation/labor-type line items;
  `test/catalog/catalog-item.test.ts`'s own fixture precedent pairs an
  "Install" item with category 'Labor') and `unit: 'each'` (a flat,
  one-off price-book line is naturally "each", not hourly) only when the
  drafted payload omits them — the drafting task never guesses a default
  itself, so the review card only ever shows what the operator actually
  said.
- **In-memory catalog repo's `create()` has NO analogous trap to its
  `update()`'s (checked, not assumed).** Task 2's review found
  `InMemoryCatalogItemRepository.update()`'s `{...current, ...updates}`
  merge silently wipes `name`/`description` on a price-only patch,
  because `updateCatalogItem` (the domain function) always constructs its
  patch object with explicit `name: updates.name?.trim()` /
  `description: updates.description?.trim()` keys — even when unstated,
  these keys exist on the patch object with value `undefined`, and the
  spread happily overwrites the current value with `undefined`.
  `create()` has no such risk: it takes a FULL, already-materialized
  `CatalogItem` (built by the pure `createCatalogItem()` function, which
  fills every field with a concrete value via `??`/`.trim() ?? ''`
  fallbacks) and does a plain `Map.set` — there is no partial-object
  merge for a subset of fields to silently clobber.
- **Reuses `catalog_item.created` — the SAME audit event type/analytics
  mapping the authenticated `POST /api/catalog-items` route already
  emits.** `analytics/audit-event-mapping.ts` already maps
  `catalog_item.created` → `catalog_item_created`
  (category/unit/unitPriceCents/hasImage) — a voice-added catalog item is
  the SAME real-world event as one added from the Catalog screen, so
  `AddCatalogItemExecutionHandler` emits the identical eventType with a
  matching metadata shape, feeding the SAME product-analytics counter
  rather than a second, unmapped one. This is deliberately UNLIKE
  `add_material`'s `material.requested` / `apply_credit`'s
  `credit.applied` (each omitted from the mapping to avoid
  double-counting a signal an existing mapped event already captures
  elsewhere) — there is no separate "item created" event this could
  double with. The handler does NOT call `catalog-item.ts`'s own
  `persistCatalogItem` helper (whose bundled audit call has no try/catch
  — a thrown audit error there would propagate AFTER the row was already
  inserted, misreporting a successful create as a failed execution, the
  exact anti-pattern `create_service_agreement`'s handler found and
  worked around for `createAgreement`'s own audit call); it builds the
  item with `createCatalogItem()`, persists via `catalogRepo.create()`
  directly, and emits its own FAILURE-SOFT audit event afterward instead.
- **RBAC — joined `CONFIG_WRITING_PROPOSAL_TYPES` (`proposals/actions.ts`)
  for the SAME reason `update_catalog_item` did.** The catalog HTTP
  routes (`routes/catalog-items.ts` POST/PUT/DELETE) all require
  `settings:update`, and a dispatcher holds `proposals:approve` but NOT
  `settings:update` (`auth/rbac.ts`). Without this entry, a dispatcher
  could speak "Add a catalog item: smart thermostat install, 385" and
  approve their own card, creating a price-book entry with only
  `proposals:approve` — the identical approval-queue-as-route-permission-
  bypass the `update_catalog_item` guard exists to close, just on the
  create side instead of the price-edit side.
- **No `_meta` confidence marker.** No LLM call anywhere in this type's
  drafting leg (`ai/tasks/add-catalog-item-task.ts`) produces a real
  confidence signal on a price-book entry — `_meta` is omitted rather
  than fabricated, same posture as `add_material` /
  `create_service_agreement`.
- **Never auto-approves.** The drafting task deliberately omits
  `sourceTrustTier`, so `decideInitialStatus`'s only auto-approve branch
  is never reached at any confidence — same posture as
  `update_catalog_item` / `create_change_order` /
  `create_service_agreement` / `add_material`.
- **Idempotent replay, not just a synthetic-id passthrough.** Like
  `add_material`, this handler mints a brand NEW row on every `execute()`
  call — a `resultEntityId` already stamped on the proposal
  short-circuits to a pure replay so a redelivered/re-executed approval
  can never double-add the same item.
- This type is deliberately **absent** from `S1_ALLOWED_PROPOSAL_TYPES`
  (`proposals/surface.ts`) — operator/owner-only, same as
  `update_catalog_item`, never reachable from an unauthenticated inbound
  caller.

Notes on the taxonomy-1.2.0 rows:

- `create_invoice_schedule` — the spoken milestone sentence is parsed by a
  deterministic grammar (`invoices/milestone-sentence-parser.ts`), never the
  LLM; an unparseable plan holds in draft with the verbatim sentence preserved
  for the reviewer. Milestone maths mirror `validateMilestones` (integer
  cents, bps, exactly one remainder).
- `respond_to_review` — resolves "that 1-star review" against recent
  `google_reviews` rows (stated star count, else rating ≤ 3, last 14 days):
  zero matches → clarification; several → candidate picker; a pending draft
  already auto-created by the polling worker → "already in your inbox"
  clarification (never a duplicate). Comms class — never auto-approves.
- `create_standing_instruction` — v1 rule: the task handler omits
  `sourceTrustTier`, so the instruction itself ALWAYS lands for human review
  even though the type is capture-class. On approval the execution handler
  inserts a `standing_instructions` row (source `proposal`, UB-A1 table).

B1.18 — `update_brand_voice` (taxonomy 1.5.0):

- **Action class is `manual`, not `capture`.** Brand voice is the tenant's
  locked outbound identity — a wrong extraction poisons every future
  customer message, so it is structurally excluded from auto-approval:
  `decideInitialStatus`'s only auto-approve branch requires
  `sourceTrustTier === 'autonomous' AND` action class `=== 'capture'`, which a
  `manual`-class type can never satisfy at any trust tier or confidence.
- **Reuses the versioned write path, never re-implements it.** The execution
  handler calls `updateBrandVoice`
  (`tenants/brand/brand-voice-service.ts`) — the SAME TOCTOU-safe
  read→cool-down-check→merge→version-bump the Brand-Voice Configurator
  sheet's `PUT /api/settings/brand-voice` uses. A cool-down violation
  surfaces as an honest failed-execution reason (`brand_voice_cooldown: …`),
  never a silent skip.
- **Lock stays tap-only (Part F decision F-2).** The payload
  (`proposals/contracts/brand-voice.ts`) has NO field capable of expressing
  `brand_voice_locked` — a spoken "lock my brand voice" cannot set that
  column through this proposal type no matter how it classifies. Pinned by
  a regression test (`test/ai/tasks/brand-voice-task.test.ts`).
- **Nothing spoken is dropped.** The six `brandVoiceSchema` fields
  (register, opening_lines, signoff, banned_phrases, persona_name, pronoun)
  are reused verbatim from the form surface; an additive `freeText` field
  carries any instruction the extraction pass couldn't map to a field, and
  a total extraction failure falls back to the verbatim transcript — same
  fallback shape as `create_standing_instruction`.

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
| "Book this caller for Thursday" | `create_booking` | capture | deferred (customer-call FSM path) |
| _(none — minted after entity resolution, not spoken)_ | `adopt_entity_alias` | manual | U4: alias-learning lifecycle mints this when an operator resolves an ambiguous reference; owner-only approval, never voice-reachable |
| _(none — conversational onboarding, not the voice intent classifier)_ | `onboarding_tenant_settings`, `onboarding_service_category`, `onboarding_estimate_template`, `onboarding_team_member`, `onboarding_schedule` | capture | B1.19: emitted by the onboarding FSM (`ai/orchestration/onboarding-conversation.ts`), a separate conversation surface from the voice intent classifier — never mapped through `INTENT_TO_PROPOSAL_TYPE`, so by design there is no spoken on-ramp for these. Execution handlers registered in `proposals/execution/onboarding-handlers.ts`; `onboarding_team_member` always reports `handler_not_wired` (no persistence target — see that file's doc comment). |
| _(none — minted internally as a companion/fallback, never a top-level classifier intent)_ | `callback` | capture | Task 14 (2026-08-07 tradesperson plan): `CallbackExecutionHandler` (`proposals/execution/callback-handler.ts`) — deliberately dep-free, registered unconditionally, always `isFullyWired()`. Fixes the pre-existing bug where an approved `callback` proposal had NO execution handler at all and threw `HANDLER_NOT_FOUND`, retrying into terminal `execution_failed`. A no-op-plus-audit is the correct semantic, not a gap: `callback` mutates nothing (surface.ts), its payload is already durably captured on the proposal row at DRAFT time — 4 production files / 5 `createProposal`/`buildProposal` call sites / 7 total content branches resolving to `proposalType: 'callback'` (see `proposals/execution/callback-handler.ts`'s class doc for the counting rule): negotiation-task.ts (2 direct calls, ALLOW branch + the enriched/default branch), complaint-task.ts (1 direct call, companion owner-followup), create-voice-turn-processor.ts (1 call, live-call negotiation FSM path, 2 of 3 evaluation-outcome branches), and sms/negotiation/inbound-negotiation-handler.ts (1 call, inbound-SMS negotiation guardrail, 2 of 3 branches — the only site stamping `callerPhone`); text-mode-driver.ts's after-hours branch also mints one but is the VQ-007 voice-quality harness, excluded from every count above (production after-hours is routes/telephony.ts's `afterHours` branch, which sends the caller to voicemail TwiML and drafts no `callback` proposal) — and the separate `call_me_back_tasks` operational-task system (voice/call-me-back/call-me-back.ts) is created directly by its own independent call sites (warm-transfer failure, E1 safety follow-up, patched-through voicemail) — none of which is gated on a `callback` proposal's approval. `callback` IS S1-reachable (the after-hours caller path, surface.ts's allowlist) even though it has no `INTENT_TO_PROPOSAL_TYPE` on-ramp. |

(`create_invoice_schedule` and `review_response_proposal` graduated to
section A in taxonomy 1.2.0 — U2/U3 of the agent build wave. `update_catalog_item`
graduated to section A in taxonomy 1.7.0 — Tradesperson wave 1, Task 2: the
"intentionally never voice-reachable" note that used to sit here was
reconsidered by that plan's locked scope decisions — see the "Notes on the
Tradesperson wave 1, Task 2 row" above for the resulting price-only
contract-compatibility caveats.)

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
`lookup_catalog`, `lookup_day_overview`, `lookup_digest`, `lookup_pending_items`,
`lookup_materials`, `lookup_crew_schedule`, `lookup_timesheets`, `lookup_my_day`,
`lookup_job_profit`
— 20 `lookup_*` intents total — routed to read-only skills, never to a
proposal (correct by design). The count is incidental, not load-bearing:
every consumer (`isLookupIntent`, `intent-classifier.ts`) gates on the
`lookup_` string prefix, not an enumeration, so a new lookup intent is
covered automatically without touching this list or any dispatch code —
only this doc's enumeration needs a manual update to stay complete.

**`lookup_materials` (Task 9, 2026-08-07 tradesperson plan):** reads back
Task 8's pending `material_items` shopping list
(`ai/skills/lookup-materials.ts`), optionally scoped to one job via the
same `JOB_REF_INTENTS` resolution `add_material` uses — an unresolved
spoken job reference refuses honestly rather than silently widening to
the whole tenant list (spec-review MAJOR A). **No permission gate** —
unlike `lookup_leads`/`lookup_catalog`, there is deliberately no entry in
`LOOKUP_REQUIRED_PERMISSION` (`workers/voice-lookup-answer.ts`): any
authenticated operator, technician included, may hear the shopping list.
There is no date/"for tomorrow" query filter — Task 8's
`MaterialItemListOptions` has no `neededBy` option, and Task 9 does not
extend that contract — so the classifier taxonomy does not advertise
date-scoped phrasing; instead, each item's captured `neededBy` (when
present) is spoken directly, so the operator can tell which of the
(possibly unfiltered) items are time-sensitive. The fetch itself is
bounded (`limit`, at most 6 rows) rather than loading the tenant's whole
pending set — see the Task 9 notes above for the full rationale.

**`lookup_crew_schedule` / `lookup_timesheets` / `lookup_my_day` (Task 10,
2026-08-07 tradesperson plan):** three more read-only lookup-skill family
members — no proposal types, no migrations.

- **Permission posture is the deliberate split this task exists to
  demonstrate.** `lookup_crew_schedule` (owner asks who is free / where a
  crew member is on a given day or window) and `lookup_timesheets` (owner
  asks logged hours per crew member for the current tenant-local week) are
  owner-extended (`OWNER_EXTENDED_LOOKUP_INTENT_TYPES`, requiring
  `extendedIntents === true`, exactly like `lookup_day_overview`) **and**
  permission-gated (`reports:view`, `LOOKUP_REQUIRED_PERMISSION`) — a
  technician's own recorded ask for either gets the refusal, never data.
  `lookup_my_day` (the SPEAKER asks about their own schedule today) is
  deliberately in **neither** set — available to ANY technician — because
  it is strictly self-scoped to the resolved SPEAKER's own day, so
  self-scoping IS this intent's entire access-control story (mirrors the
  precedent `lookup_materials` set for "no permission gate" lookups, one
  level stricter: `lookup_materials` widens to the whole tenant's list when
  unscoped, which is fine for a shopping list; `lookup_my_day` must never
  widen past the ONE resolved technician, so it takes a required, already-
  resolved `technicianId`, never an optional one).
- **An unresolved crew-member name refuses honestly, never widens to the
  whole crew.** Both `lookup_crew_schedule` and `lookup_timesheets` join
  `TECHNICIAN_REF_INTENTS` (entity-resolution.ts) — the same technician
  resolution `reassign_appointment`/`add_crew_member`/`remove_crew_member`
  already get — so a named crew member
  (`extractedEntities.targetTechnicianName`) resolves to a verified
  `technicianId` before either skill runs. When a name was spoken but
  didn't resolve, `workers/voice-lookup-answer.ts` refuses by name
  ("I couldn't find a crew member matching …") rather than silently
  falling back to everyone's schedule or everyone's hours — the
  spec-review MAJOR A precedent (`lookup_materials`), applied with MORE
  force here: a named PERSON who didn't resolve leaking to "everyone" is a
  materially worse disclosure than an unscoped shopping list.
- **`lookup_my_day`'s speaker resolution is its access control.** The
  SPEAKER is resolved to a canonical technician via
  `dispatch/en-route-voice.ts`'s `resolveCanonicalTechnician` (now
  exported, reused rather than duplicated) — the SAME resolution
  `en_route` uses for "on my way". When the speaker cannot be resolved to
  a technician, the turn FAILS (`{ kind: 'failed', error: 'could not match
  you to a technician' }`) — it never falls back to an unscoped or
  whole-crew day.
- **Day/window resolution reuses the booking path's own resolver.**
  `lookup_crew_schedule` resolves a spoken day/window
  (`extractedEntities.dateTimeDescription`) via the SAME
  `resolveDateTime` (U4, `ai/scheduling/resolve-datetime.ts`) the booking
  path uses; an unparseable or absent phrase defaults to TODAY, and the
  spoken summary always names the day actually being reported (never lets
  a defaulted day pass as the one asked about). `lookup_timesheets` only
  supports the CURRENT tenant-local week — mirrors `lookup_materials`'s
  "for tomorrow is not a filter" precedent — so the taxonomy only
  advertises "this week" phrasing; a real "last week" query is a genuine
  but separate extension, not done here.
- **Bounded fetch, technician-per-appointment via `job.assignedTechnicianId`.**
  All three skills mirror `lookup-day-overview.ts`'s established pattern
  rather than a second `AssignmentRepository.findByTechnician` fetch
  (which has no date bound — an unbounded per-technician scan across the
  tenant's whole assignment history just to answer "are you free today",
  the exact class of bug I4 fixed for `lookup_materials`). Appointments
  are bounded to the resolved day (`AppointmentRepository.findByDateRange`);
  jobs are bounded either to one technician's own jobs
  (`JobRepository.findByTenant({ technicianId })`, when one is named or
  resolved) or a generous but bounded tenant-wide page (`limit: 200`, the
  same cap `lookup-day-overview.ts` uses) otherwise. `lookup_timesheets`
  reuses `TimeEntryService.weeklyHoursByUser` verbatim — the SAME
  aggregation `GET /api/time-entries?weekOf=` already uses — rather than
  re-implementing weekly rollup math.

## F) Direct status acts — audited directly, never a proposal (B5.5, Part F decision F-3)

`en_route` ("on my way") is neither read-only (E, above) nor proposal-driving
(A, above) — it's a technician acting DIRECTLY. A5.2's invariant governs
**AI-proposed** actions; a technician saying "on my way" is the human acting
themselves, the same precedent PRD B10.10 already blesses for the owner.
Both the voice leg and the SMS-keyword leg call the exact same audited act
the shipped app en-route button already executes
(`dispatch/routes.ts triggerEnRoute` → `appointment.en_route_triggered`
audit event, tech actor, + the existing branded ETA SMS via
`DelayNotificationCoordinator.enqueueEnRouteNotice`) — never a drafted
proposal a human has to tap.

| Spoken/texted example | Intent / trigger | What fires | Persistence proof |
|---|---|---|---|
| "On my way to the Garcia job" | `en_route` (voice) | `triggerEnRoute` (same act as the app button) | integration (`integration/en-route-voice.test.ts`) |
| "Heading to my next one now" | `en_route` (voice, bare — resolves to the tech's next upcoming appointment today) | `triggerEnRoute` | integration (`integration/en-route-voice.test.ts`) |
| "OMW" / "on my way" texted from a registered tech phone | SMS keyword (joins `TECH_STATUS_KEYWORDS`) | `triggerEnRoute` | handler-suite |

Because misclassification risk is real on the voice leg (unlike a tap), a
low-confidence `en_route` classification gates to clarification instead of
firing — the standard `CLASSIFIER_CONFIDENCE_THRESHOLD` floor in
`ai/orchestration/intent-classifier.ts` covers this generically, pinned by a
dedicated regression test for this intent. Resolution is speaker-scoped: the
voice leg resolves the appointment within the ACTING technician's OWN
assignments only (`dispatch/en-route-voice.ts resolveEnRouteAppointment`) —
a technician's "on my way" can never target another tech's appointment. A
named job resolves to that appointment; a bare "on my way" resolves to the
tech's next upcoming appointment today; two candidates clarify; zero yields
an explicit "no upcoming appointment" answer (never silent).

`en_route` is intentionally absent from `INTENT_TO_PROPOSAL_TYPE` — see the
comment block in `proposals/voice-intent-map.ts` (next to the `lookup_*`
exclusion) — so the intent-map drift test reads its absence as deliberate,
not a gap. No new `JobStatus` value was introduced for this.

---

**`lookups` (added at final verification, 2026-08-07 tradesperson plan):**
read-only lookup-skill intents. They never create a proposal (no
`proposalType`/`actionClass` — `intentToProposalType(...)` returns
`'voice_clarification'` for every member, by design; see the `lookup_*`
exclusion comment in `proposals/voice-intent-map.ts`), so they cannot join
`speakable` above. Listed here purely so `packages/web`'s VoiceBar
discoverability examples (`voice-examples.ts`) can reference a lookup
(`lookup_crew_schedule`) without inventing a second, undocumented pinning
mechanism — `voice-examples.catalog.test.ts` accepts an example intent from
either `speakable` or `lookups`.

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
    { "intent": "batch_invoice", "proposalType": "batch_invoice", "actionClass": "capture" },
    { "intent": "create_customer", "proposalType": "create_customer", "actionClass": "capture" },
    { "intent": "create_job", "proposalType": "create_job", "actionClass": "capture" },
    { "intent": "update_job", "proposalType": "update_job", "actionClass": "capture" },
    { "intent": "reschedule_appointment", "proposalType": "reschedule_appointment", "actionClass": "capture" },
    { "intent": "cancel_appointment", "proposalType": "cancel_appointment", "actionClass": "irreversible" },
    { "intent": "reassign_appointment", "proposalType": "reassign_appointment", "actionClass": "capture" },
    { "intent": "add_crew_member", "proposalType": "add_crew_member", "actionClass": "capture" },
    { "intent": "remove_crew_member", "proposalType": "remove_crew_member", "actionClass": "capture" },
    { "intent": "add_note", "proposalType": "add_note", "actionClass": "capture" },
    { "intent": "send_invoice", "proposalType": "send_invoice", "actionClass": "comms" },
    { "intent": "send_estimate", "proposalType": "send_estimate", "actionClass": "comms" },
    { "intent": "send_estimate_nudge", "proposalType": "send_estimate_nudge", "actionClass": "comms" },
    { "intent": "send_payment_reminder", "proposalType": "send_payment_reminder", "actionClass": "comms" },
    { "intent": "apply_late_fee", "proposalType": "apply_late_fee", "actionClass": "money" },
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
    { "intent": "request_feedback", "proposalType": "request_feedback", "actionClass": "comms" },
    { "intent": "create_invoice_schedule", "proposalType": "create_invoice_schedule", "actionClass": "capture" },
    { "intent": "respond_to_review", "proposalType": "review_response_proposal", "actionClass": "comms" },
    { "intent": "create_standing_instruction", "proposalType": "create_standing_instruction", "actionClass": "capture" },
    { "intent": "update_brand_voice", "proposalType": "update_brand_voice", "actionClass": "manual" },
    { "intent": "schedule_inspection", "proposalType": "create_appointment", "actionClass": "capture" },
    { "intent": "log_permit", "proposalType": "add_note", "actionClass": "capture" },
    { "intent": "log_warranty_claim", "proposalType": "create_job", "actionClass": "capture" },
    { "intent": "update_catalog_item", "proposalType": "update_catalog_item", "actionClass": "capture" },
    { "intent": "record_refund", "proposalType": "record_refund", "actionClass": "money" },
    { "intent": "apply_credit", "proposalType": "apply_credit", "actionClass": "money" },
    { "intent": "send_customer_message", "proposalType": "send_customer_message", "actionClass": "comms" },
    { "intent": "create_change_order", "proposalType": "create_change_order", "actionClass": "capture" },
    { "intent": "create_service_agreement", "proposalType": "create_service_agreement", "actionClass": "capture" },
    { "intent": "add_material", "proposalType": "add_material", "actionClass": "capture" },
    { "intent": "log_mileage", "proposalType": "log_expense", "actionClass": "capture" },
    { "intent": "add_catalog_item", "proposalType": "add_catalog_item", "actionClass": "capture" }
  ],
  "lookups": [
    "lookup_account_summary",
    "lookup_agreements",
    "lookup_appointments",
    "lookup_availability",
    "lookup_balance",
    "lookup_catalog",
    "lookup_crew_schedule",
    "lookup_customer",
    "lookup_day_overview",
    "lookup_digest",
    "lookup_estimates",
    "lookup_invoices",
    "lookup_job_profit",
    "lookup_jobs",
    "lookup_leads",
    "lookup_materials",
    "lookup_my_day",
    "lookup_pending_items",
    "lookup_revenue",
    "lookup_timesheets"
  ],
  "handlerNoOnramp": [
    "create_booking",
    "adopt_entity_alias",
    "onboarding_tenant_settings",
    "onboarding_service_category",
    "onboarding_estimate_template",
    "onboarding_team_member",
    "onboarding_schedule",
    "callback"
  ],
  "gated": ["approve_proposal", "reject_proposal", "edit_proposal"]
}
```
<!-- END machine-readable: voice-action-catalog -->
