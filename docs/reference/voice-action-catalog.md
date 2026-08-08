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

These 44 actions can be spoken, drafted as a proposal, approved, and executed.
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
`lookup_catalog`, `lookup_day_overview`, `lookup_digest`, `lookup_pending_items`
— routed to read-only skills, never to a proposal (correct by design).

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
    { "intent": "create_change_order", "proposalType": "create_change_order", "actionClass": "capture" }
  ],
  "handlerNoOnramp": [
    "create_booking",
    "adopt_entity_alias",
    "onboarding_tenant_settings",
    "onboarding_service_category",
    "onboarding_estimate_template",
    "onboarding_team_member",
    "onboarding_schedule"
  ],
  "gated": ["approve_proposal", "reject_proposal", "edit_proposal"]
}
```
<!-- END machine-readable: voice-action-catalog -->
