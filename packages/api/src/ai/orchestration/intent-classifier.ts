import { LLMGateway } from '../gateway/gateway';
import { resolveClassifyIntentDeadlineMs } from '../../config/ai-routing';

/**
 * Voice-to-action intent classifier.
 *
 * Takes a voice transcript, returns a structured classification that
 * the voice-action-router uses to dispatch to the right AI task.
 *
 * Phase 1 handled: create_invoice, draft_estimate, create_appointment.
 * Phase 2 adds:    update_invoice (add/remove line item).
 * Phase 3 adds:    issue_invoice (send a drafted invoice to the customer).
 * Phase 4 intents (query_*) still return 'unknown'.
 */

export type IntentType =
  | 'create_invoice'
  | 'draft_estimate'
  | 'create_appointment'
  | 'update_invoice'
  | 'update_estimate'
  | 'issue_invoice'
  // Capture-class batch on-ramp: invoice ALL completed-unbilled jobs at once.
  // On approval the batch_invoice proposal fans out one draft_invoice per job.
  | 'batch_invoice'
  | 'create_customer'
  | 'create_job'
  // B7 (feat: voice-transcript-and-agent-paths) — bounded, safe field edit
  // to an EXISTING job: status/priority/title/description. NOT money, NOT
  // schedule — those keep their own intents.
  | 'update_job'
  | 'reschedule_appointment'
  | 'cancel_appointment'
  | 'reassign_appointment'
  | 'add_crew_member'
  | 'remove_crew_member'
  | 'add_note'
  | 'send_invoice'
  | 'send_estimate'
  | 'send_estimate_nudge'
  | 'send_payment_reminder'
  | 'apply_late_fee'
  | 'record_payment'
  | 'emergency_dispatch'
  // Phase: full-app voice coverage. update_customer / log_expense reuse
  // existing proposal types + execution handlers; convert_lead is a new
  // capability. All three are proposal-driving (operator + inbound).
  | 'update_customer'
  | 'log_expense'
  | 'convert_lead'
  // Phase: full-app voice coverage (wave 2). All proposal-driving.
  | 'confirm_appointment'
  | 'mark_lead_lost'
  | 'add_service_location'
  | 'log_time_entry'
  | 'notify_delay'
  | 'request_feedback'
  // Tradesperson wave 1 (2026-08-07 plan) — alias intents. Each rides an
  // EXISTING proposal type + handler; only classification + extraction differ.
  | 'schedule_inspection'
  | 'log_permit'
  | 'log_warranty_claim'
  // Tradesperson wave 1 — price-book edit by voice; rides WS20's existing proposal type.
  | 'update_catalog_item'
  // Tradesperson wave 1, Task 3 — NEW money-class proposal type: recording a
  // MANUAL refund (cash/check/external card) given back to a customer.
  // Stripe-automated refunds are a deliberate non-goal (see record_refund's
  // execution handler doc comment) — this intent covers only what a
  // tradesperson does by hand outside the payment processor.
  | 'record_refund'
  // Tradesperson wave 1, Task 4 — NEW money-class proposal type: reducing
  // what a customer owes on an ISSUED invoice (goodwill, warranty labor, a
  // price match). Distinct from record_refund: a credit never hands money
  // BACK (it just lowers the balance still owed) — exceeding the amount due
  // is a refund, not a credit, and the execution handler refuses it (see
  // ApplyCreditExecutionHandler's floor guard).
  | 'apply_credit'
  // Tradesperson wave 1, Task 5 — NEW comms-class proposal type: a
  // free-form outbound customer message (status update, part arrival,
  // ETA, thanks). The AI drafts the exact text; the owner ALWAYS approves
  // before a customer sees it. Highest-frequency gap in the 2026-08-07
  // tradesperson plan.
  | 'send_customer_message'
  // Tradesperson wave 1, Task 6 — NEW capture-class proposal type: mid-job
  // scope change the customer asked for. Mints a NEW estimate pinned to the
  // EXISTING job (jobReference is REQUIRED — that's what distinguishes this
  // from draft_estimate, a fresh bid). No money moves at creation; sending
  // the resulting estimate is a later, separate comms-class step
  // (send_estimate) — same capture posture as draft_estimate.
  | 'create_change_order'
  // Task 7 (2026-08-07 tradesperson plan) — NEW capture-class proposal
  // type: signs a customer up to a recurring maintenance plan/membership
  // ("Sign the Garcias up for the annual maintenance plan, 290 a year").
  // Writes a `service_agreements` row (migration 056, already live); no
  // money moves at creation — the agreement's OWN recurring sweep
  // generates jobs/invoices later, and those invoices ride the normal
  // review path.
  | 'create_service_agreement'
  // Task 9 (2026-08-07 tradesperson plan) — NEW capture-class proposal
  // type: adds a row to the voice-captured shopping list (`material_items`,
  // migration 272, Task 8's substrate). No money moves, and it's
  // reversible (the row can be marked purchased or simply ignored) — same
  // posture as `log_expense`.
  | 'add_material'
  // Task 9 (2026-08-07 tradesperson plan) — read-only lookup-skill family
  // member: reads back the pending shopping list, optionally scoped to one
  // job. Never a proposal — routed to the lookup-skill family like every
  // other `lookup_*` intent.
  | 'lookup_materials'
  // Task 10 (2026-08-07 tradesperson plan) — read-only lookup-skill family
  // members. lookup_crew_schedule/lookup_timesheets are owner-extended
  // (OWNER_EXTENDED_LOOKUP_INTENT_TYPES) + permission-gated
  // (LOOKUP_REQUIRED_PERMISSION, reports:view) exactly like
  // lookup_day_overview; a named crew member rides
  // extractedEntities.targetTechnicianName (TECHNICIAN_REF_INTENTS
  // membership — entity-resolution.ts), resolved to a verified
  // technicianId before the skill runs, and an unresolved name is refused
  // rather than silently widened to the whole crew (see
  // ai/skills/lookup-crew-schedule.ts / lookup-timesheets.ts). lookup_my_day
  // is the opposite shape: available to ANY technician (NOT owner-extended,
  // NOT permission-gated) because it is strictly self-scoped to the
  // resolved SPEAKER's own day — see that skill's module doc comment for
  // why self-scoping IS this intent's entire access-control story.
  | 'lookup_crew_schedule'
  | 'lookup_timesheets'
  | 'lookup_my_day'
  // Task 11 (2026-08-07 tradesperson plan) — ALIAS intent onto the
  // EXISTING `log_expense` proposal type/execution handler: a technician
  // logs drive miles for the tax-deduction mileage log ("Log 32 miles to
  // the Patel job"). No new ProposalType, no new execution handler. Extract
  // `mileageMiles` (number, required); jobReference reuses the existing
  // seam (JOB_REF_INTENTS membership — entity-resolution.ts, mirroring
  // log_expense). Quality-review fix (2026-08-09) — `LogExpenseTaskHandler`
  // (ai/tasks/voice-extended-tasks.ts) branches on `context.intent ===
  // 'log_mileage'` (TaskContext.intent), NOT on the presence of
  // `mileageMiles` — the classifier's extraction shape is one GLOBAL
  // template shared by every intent (`entitiesForProposal`,
  // workers/voice-action-router.ts, is a passthrough for every intent
  // except `create_customer`), so the taxonomy above only INSTRUCTS the
  // model to extract `mileageMiles` on this intent; it does not
  // structurally prevent the model from also populating it (or the plain
  // `amount` dollars key) on a different intent's turn. Converts miles ×
  // DEFAULT_MILEAGE_RATE_CENTS_PER_MILE into `amountCents`, forcing
  // `category: 'vehicle'`.
  | 'log_mileage'
  // Task 12 (2026-08-07 tradesperson plan) — NEW capture-class proposal
  // type: an owner adds a price-book entry by voice ("Add a catalog item:
  // smart thermostat install, 385"). The create-side mirror of
  // update_catalog_item: no money moves at creation, only shapes FUTURE
  // drafts (which are themselves reviewed), and it's reversible (archive
  // the item). See AddCatalogItemTaskHandler (ai/tasks/add-catalog-item-
  // task.ts) for the extraction-seam reuse decision and the 0-price
  // legality rationale.
  | 'add_catalog_item'
  // Taxonomy 1.2.0 (agent wave, Track A) — three proposal-driving on-ramps:
  //   create_invoice_schedule    — U2: milestone/progress billing plan for a
  //                                job; the verbatim milestone sentence rides
  //                                extractedEntities.scheduleDescription and a
  //                                deterministic parser (invoices/
  //                                milestone-sentence-parser.ts) turns it into
  //                                typed milestones — never the LLM.
  //   respond_to_review          — U3: owner asks to reply to a customer
  //                                review; the free-text review reference rides
  //                                extractedEntities.reviewReference and is
  //                                resolved against recent google_reviews rows
  //                                (ambiguity → voice_clarification).
  //   create_standing_instruction — UB-A2: "from now on…"/"always…" persistent
  //                                directives; extractedEntities.instructionText
  //                                carries the verbatim rule. The instruction
  //                                itself ALWAYS lands for review (the task
  //                                handler omits sourceTrustTier).
  | 'create_invoice_schedule'
  | 'respond_to_review'
  | 'create_standing_instruction'
  // B1.18 — the owner captures/edits the tenant's brand voice by speaking
  // ("Set my brand voice: friendly, plain-spoken, always sign off 'Thanks —
  // Bob's HVAC'"). PROPOSAL-DRIVING but deliberately `manual` action class
  // (proposals/proposal.ts) — never auto-approves at any trust tier, because
  // a wrong extraction poisons every future outbound message. Scope
  // decision (Part F entry F-2): capture is speakable; LOCKING the brand
  // voice stays tap-only — this intent's payload has no field capable of
  // expressing `brand_voice_locked` (see proposals/contracts/brand-voice.ts).
  | 'update_brand_voice'
  // B5.5 / Part F decision F-3 — a technician announcing they're headed to
  // an appointment ("on my way"). NOT proposal-driving: the router fires
  // the SAME audited direct status act the app en-route button already
  // executes (dispatch/routes.ts triggerEnRoute) — the human is acting
  // directly, the exact precedent PRD B10.10 already blesses. Deliberately
  // absent from INTENT_TO_PROPOSAL_TYPE; see proposals/voice-intent-map.ts
  // for the documented non-proposal registration. jobReference carries a
  // named job ("the Garcia job"); absent ⇒ the tech's next upcoming
  // appointment today. Distinct from notify_delay (the crew is running
  // LATE, not departing now) — a low-confidence classification here still
  // gates to clarification via the standard CLASSIFIER_CONFIDENCE_THRESHOLD
  // floor below, same as every other intent.
  | 'en_route'
  // P11-001: voice lookup-skill family. Read-only intents — the
  // adapter routes these straight to the `lookup_*` skill instead
  // of the proposal-draft path.
  | 'lookup_appointments'
  | 'lookup_invoices'
  | 'lookup_balance'
  | 'lookup_jobs'
  | 'lookup_agreements'
  | 'lookup_account_summary'
  | 'lookup_customer'
  | 'lookup_estimates'
  // Phase: full-app voice coverage — owner/tenant-scoped read-only lookups.
  | 'lookup_availability'
  | 'lookup_leads'
  | 'lookup_revenue'
  | 'lookup_catalog'
  // Phase-2 Track A (RV-010) — owner/operator morning overview ("what's
  // my day look like?"). Read-only, routed to the lookup-skill family.
  // Routable ONLY when the calling surface opts in via
  // `ClassifyContext.extendedIntents` — the prompt section documenting it
  // is a SEPARATE system message appended only then, so every existing
  // call path keeps byte-identical prompt messages (voice-quality
  // cassette hashes / gateway cache keys are unaffected — the RV-071
  // pattern).
  | 'lookup_day_overview'
  // Phase-2 Track A (RV-064) — owner asks for the stored end-of-day
  // digest narrative ("read me my day"). Read-only; same extendedIntents
  // gating as lookup_day_overview.
  | 'lookup_digest'
  // Phase-2 Track A (RV-085) — owner asks what they're waiting on
  // (aging estimates, unpaid invoices, unanswered recovery threads).
  // Read-only; same extendedIntents gating.
  | 'lookup_pending_items'
  // Phase-2 Track A (RV-080) — caller/operator reports dissatisfaction
  // with completed work or service. PROPOSAL-DRIVING (pinned-prefix
  // add_note + callback for owner follow-up — both existing proposal
  // types, dispatched by a dedicated router handler). Same
  // extendedIntents gating as the Track A lookups.
  | 'complaint'
  // N-003 (P2-036) — caller pushes on price, scope, or terms: discount ask,
  // scope-change ("throw it in for free"), refund-as-leverage, "talk to the
  // owner" in a pricing context, or a review/walk-away threat. PROPOSAL-DRIVING
  // and EXTENDED (same extendedIntents gating as complaint): routed to a
  // dedicated guardrail handler that emits an owner callback with a
  // recommendation — the AI never negotiates. extractedEntities.negotiationAsk
  // carries the verbatim ask.
  | 'negotiation'
  // P22-005 (U7) — owner asks whether a specific job made money ("did I make
  // money on the Miller job?"). Owner/tenant-scoped, read-only — routed to the
  // lookup_job_profit skill, which speaks a per-job P&L. The job is referenced
  // free-text in extractedEntities.jobReference and resolved downstream.
  | 'lookup_job_profit'
  // P11-002: caller asks to switch the call language ("english please" /
  // "hablo español"). The adapter consumes this as a signal to flip the
  // session language — it is NOT a proposal-driving intent.
  | 'language_switch'
  // Seamless Handoff: caller explicitly asks to speak with a human.
  // The FSM fast-paths directly to escalating without entity_resolution
  // or intent_confirm.
  | 'operator_request'
  // Caller confirms/agrees to a pending action the agent proposed
  // ("yes", "that's right", "go ahead"). Conversational, non-proposal.
  | 'confirm'
  // RV-071 — owner voice approval channel. Routable ONLY on verified
  // owner sessions (ClassifyContext.ownerSession): the prompt section
  // documenting them is appended only then, and the voice routing layers
  // additionally hard-gate on the session flag (never prompt-only).
  | 'approve_proposal'
  | 'reject_proposal'
  // RV-225 — owner voice edit channel ("change the second line to $200").
  // Same owner-session-only gating as approve/reject: documented to the
  // model exclusively via the appended owner system message, hard-gated
  // by the routing layers on the session flag.
  | 'edit_proposal'
  | 'unknown';

export const SUPPORTED_INTENTS: readonly IntentType[] = [
  'create_invoice',
  'draft_estimate',
  'create_appointment',
  'update_invoice',
  'update_estimate',
  'issue_invoice',
  'batch_invoice',
  'create_customer',
  'create_job',
  'update_job',
  'reschedule_appointment',
  'cancel_appointment',
  'reassign_appointment',
  'add_crew_member',
  'remove_crew_member',
  'add_note',
  'send_invoice',
  'send_estimate',
  'send_estimate_nudge',
  'send_payment_reminder',
  'apply_late_fee',
  'record_payment',
  'emergency_dispatch',
  'update_customer',
  'log_expense',
  'convert_lead',
  'confirm_appointment',
  'mark_lead_lost',
  'add_service_location',
  'log_time_entry',
  'notify_delay',
  'request_feedback',
  'schedule_inspection',
  'log_permit',
  'log_warranty_claim',
  'update_catalog_item',
  'record_refund',
  'apply_credit',
  'send_customer_message',
  'create_change_order',
  'create_service_agreement',
  'add_material',
  'lookup_materials',
  'lookup_crew_schedule',
  'lookup_timesheets',
  'lookup_my_day',
  'log_mileage',
  'add_catalog_item',
  'create_invoice_schedule',
  'respond_to_review',
  'create_standing_instruction',
  'update_brand_voice',
  'en_route',
  'lookup_appointments',
  'lookup_invoices',
  'lookup_balance',
  'lookup_jobs',
  'lookup_agreements',
  'lookup_account_summary',
  'lookup_customer',
  'lookup_estimates',
  'lookup_availability',
  'lookup_leads',
  'lookup_revenue',
  'lookup_catalog',
  'lookup_day_overview',
  'lookup_digest',
  'lookup_pending_items',
  'complaint',
  'negotiation',
  'lookup_job_profit',
  'language_switch',
  'operator_request',
  'confirm',
  'approve_proposal',
  'reject_proposal',
  'edit_proposal',
  'unknown',
] as const;

/**
 * Story 3.4 — versioned intent taxonomy. Every classification is stamped with
 * this version (see `classifyIntent`) so downstream consumers — correction
 * analytics (story 3.9), routing observability, evaluation snapshots — can tell
 * which taxonomy produced an intent and detect drift across deploys.
 *
 * BUMP THIS whenever `SUPPORTED_INTENTS` changes (an intent added, removed, or
 * its meaning materially changed) or a deterministic intent mapping changes.
 * Semantics: MAJOR = an intent removed or its meaning changed (consumers must
 * re-map); MINOR = an intent added or coverage extended (additive,
 * backward-compatible).
 *
 * Changelog:
 *   1.0.0 — initial versioned taxonomy.
 *   1.1.0 — "log inventory" phrasings recognized and mapped to log_expense
 *           (no inventory domain; see isInventoryLoggingPhrasing).
 *   1.2.0 — agent-wave Track A on-ramps (additive): create_invoice_schedule
 *           (U2, milestone billing), respond_to_review (U3, review reply
 *           drafting), create_standing_instruction (UB-A2, persistent
 *           directives). One coordinated bump — see
 *           docs/reference/voice-action-catalog.md.
 *   1.3.0 — B7 (feat: voice-transcript-and-agent-paths): update_job
 *           (additive) — a bounded, safe field edit (status/priority/
 *           title/description) to an existing job, distinct from
 *           create_job / reschedule_appointment / add_note.
 *   1.4.0 — B5.5 (Part F decision F-3): en_route (additive) — a technician
 *           announcing "on my way". Not proposal-driving (see the IntentType
 *           doc comment); a technician's own recorded memo fires the SAME
 *           audited direct status act the app en-route button executes.
 *   1.5.0 — B1.18: update_brand_voice (additive) — the owner captures/edits
 *           the tenant's brand voice by speaking. Proposal-driving,
 *           `manual` action class (never auto-approves at any trust tier).
 *           Locking the brand voice stays tap-only — this intent's payload
 *           structurally cannot express `brand_voice_locked` (Part F
 *           entry F-2).
 *   1.6.0 — Tradesperson wave 1 (2026-08-07 plan), additive: schedule_inspection,
 *           log_permit, log_warranty_claim — alias intents onto existing
 *           proposal types (create_appointment / add_note / create_job
 *           respectively). Handler dispatch is keyed by proposal type, so
 *           these inherit drafting + execution unchanged; only
 *           classification + extraction differ.
 *   1.7.0 — Tradesperson wave 1 (2026-08-07 plan) Task 2, additive:
 *           update_catalog_item — voice on-ramp for WS20's existing
 *           correction-repetition proposal type + execution handler
 *           (price-book edits by voice). New extraction fields
 *           (catalogItemReference / unitPriceCents / catalogItemNewName /
 *           catalogItemNewDescription);
 *           see UpdateCatalogItemTaskHandler (ai/tasks/voice-extended-tasks.ts)
 *           for the payload/contract-compatibility notes.
 *   1.8.0 — Tradesperson wave 1 (2026-08-07 plan) Task 3, additive:
 *           record_refund — a NEW money-class proposal type for recording
 *           MANUAL refunds (cash/check/external card) given back to a
 *           customer. Never auto-approves at any trust tier (D3). New
 *           extraction fields (refundMethod / refundReason /
 *           refundCheckNumber); reuses the existing jobReference/amount
 *           seams for the invoice reference and cents amount, same as
 *           record_payment. Stripe-automated refunds are explicitly out of
 *           scope — see RecordRefundExecutionHandler
 *           (proposals/execution/record-refund-handler.ts) for why.
 *   1.9.0 — Tradesperson wave 1 (2026-08-07 plan) Task 4, additive:
 *           apply_credit — a NEW money-class proposal type that reduces
 *           what a customer owes on an issued invoice (goodwill, warranty
 *           labor, price match). Never auto-approves at any trust tier
 *           (D3). New extraction field (creditReason); reuses the existing
 *           jobReference/amount seams for the invoice reference and cents
 *           amount, same as apply_late_fee/record_refund. Floor-guarded: a
 *           credit may never exceed the invoice's amount due — exceeding
 *           it is a refund (record_refund), not this type's job — see
 *           ApplyCreditExecutionHandler (proposals/execution/
 *           apply-credit-handler.ts).
 *   1.10.0 — Tradesperson wave 1 (2026-08-07 plan) Task 5, additive:
 *           send_customer_message — a NEW comms-class proposal type for a
 *           free-form outbound customer message (status update, part
 *           arrival, ETA, thanks). The AI drafts the exact text; the
 *           owner ALWAYS approves before a customer sees it — never
 *           auto-approves at any trust tier. New extraction fields
 *           (customerMessageBody / customerMessageChannel); reuses the
 *           existing customerName seam for the spoken customer reference
 *           (CUSTOMER_REF_INTENTS membership, same resolution ladder as
 *           update_customer). Routes through the SAME
 *           MessageDeliveryProvider (and TCPA consent/DNC/kill-switch
 *           gates) TwilioDelayNotificationService already uses — see
 *           SendCustomerMessageExecutionHandler (proposals/execution/
 *           send-customer-message-handler.ts).
 *   1.11.0 — Tradesperson wave 1 (2026-08-07 plan) Task 6, additive:
 *           create_change_order — a NEW capture-class proposal type that
 *           mints a NEW estimate pinned to an EXISTING job, flagged
 *           `is_change_order` (migration 271) so reporting can separate
 *           scope-adds from original bids. jobId is REQUIRED on the
 *           contract (that's what distinguishes this from draft_estimate,
 *           whose jobId is optional). No money moves at creation; sending
 *           the resulting estimate is a later, separate comms-class step —
 *           same capture posture as draft_estimate. New extraction field
 *           (changeOrderDescription); reuses the existing jobReference/
 *           amount seams for the job reference and cents amount.
 *           `create_change_order` joined JOB_REF_INTENTS (entity-
 *           resolution.ts) — an unresolved job reference gates the
 *           proposal (missingFields: ['jobId']); see
 *           CreateChangeOrderExecutionHandler (proposals/execution/
 *           create-change-order-handler.ts).
 *   1.12.0 — Task 7 (2026-08-07 tradesperson plan), additive:
 *           create_service_agreement — a NEW capture-class proposal type
 *           that signs a customer up to a recurring maintenance
 *           plan/membership, writing a `service_agreements` row
 *           (migration 056, already live). No money moves at creation —
 *           the agreement's OWN recurring sweep
 *           (agreements/agreement-service.ts runDueAgreements) generates
 *           jobs/invoices later, and those invoices ride the normal
 *           review path. New extraction fields (serviceAgreementName /
 *           serviceAgreementCadence / serviceAgreementStartsOn); reuses
 *           the existing customerName/amount seams for the customer
 *           reference and per-period price. `create_service_agreement`
 *           joined CUSTOMER_REF_INTENTS (entity-resolution.ts) — an
 *           unresolved customer reference gates the proposal
 *           (missingFields: ['customerId']); see
 *           CreateServiceAgreementExecutionHandler (proposals/execution/
 *           create-service-agreement-handler.ts).
 *   1.13.0 — Task 9 (2026-08-07 tradesperson plan), additive: add_material
 *           — a NEW capture-class proposal type that adds a row to the
 *           voice-captured shopping list (`material_items`, migration 272,
 *           Task 8's substrate). No money moves, and it's reversible (the
 *           row can be marked purchased or simply ignored). New extraction
 *           fields (materialDescription / materialQuantity /
 *           materialNeededBy); reuses the existing jobReference/vendor
 *           seams (jobReference via `JOB_REF_INTENTS` membership — see
 *           entity-resolution.ts — and vendor, already carried by
 *           log_expense). lookup_materials — a NEW read-only lookup-skill
 *           family member (additive, same family as lookup_revenue /
 *           lookup_job_profit): reads back the pending shopping list,
 *           optionally scoped to one job via the SAME `JOB_REF_INTENTS`
 *           resolution. NOT added to `INTENT_TO_PROPOSAL_TYPE` (lookup_*
 *           intents never produce a proposal) and deliberately has NO
 *           entry in `LOOKUP_REQUIRED_PERMISSION`
 *           (workers/voice-lookup-answer.ts) — any authenticated operator
 *           may hear the shopping list, unlike the owner-grade reports.
 *           See AddMaterialTaskHandler (ai/tasks/add-material-task.ts) and
 *           executeLookupAnswer's `lookup_materials` case
 *           (workers/voice-lookup-answer.ts) for the extraction/answer
 *           details.
 *   1.14.0 — Task 10 (2026-08-07 tradesperson plan), additive: three
 *           READ-ONLY lookup-skill family members, no proposal types, no
 *           migrations. lookup_crew_schedule (owner asks who is free /
 *           where a crew member is on a given day or window) and
 *           lookup_timesheets (owner asks logged hours per crew member for
 *           the current tenant-local week) are owner-extended
 *           (OWNER_EXTENDED_LOOKUP_INTENT_TYPES) + permission-gated
 *           (LOOKUP_REQUIRED_PERMISSION, reports:view) — same posture as
 *           lookup_day_overview. Both join TECHNICIAN_REF_INTENTS
 *           (entity-resolution.ts) so a named crew member
 *           (extractedEntities.targetTechnicianName) resolves to a
 *           verified technicianId the SAME way reassign_appointment/
 *           add_crew_member/remove_crew_member already do; an unresolved
 *           name is refused by name rather than silently widened to the
 *           whole crew (workers/voice-lookup-answer.ts). lookup_my_day
 *           (the SPEAKER asks about their own schedule today) is
 *           deliberately in NEITHER set — available to any technician,
 *           strictly self-scoped to the resolved speaker's own day via
 *           users/user.ts's resolveCanonicalUser; an unresolvable speaker
 *           fails the turn rather than ever falling back to an unscoped
 *           day. See ai/skills/lookup-crew-schedule.ts, lookup-
 *           timesheets.ts, and lookup-my-day.ts for the full rationale.
 *   1.16.0 — Task 12 (2026-08-07 tradesperson plan), additive:
 *           add_catalog_item — a NEW capture-class proposal type that lets
 *           an owner add a price-book entry by voice ("Add a catalog item:
 *           smart thermostat install, 385"). The create-side mirror of
 *           update_catalog_item (taxonomy 1.7.0): no money moves at
 *           creation, only shapes FUTURE drafts (which are themselves
 *           reviewed), and it's reversible (archive the item). REUSES
 *           update_catalog_item's catalogItemNewName / unitPriceCents /
 *           catalogItemNewDescription extraction fields (their meaning
 *           generalizes cleanly to a create — see
 *           AddCatalogItemTaskHandler's doc comment for the reuse-vs-new
 *           decision); adds one genuinely NEW field, catalogItemUnit. Zero
 *           is a LEGAL unitPriceCents (a free/comp price-book line) —
 *           contract and drafting gate agree on this boundary, unlike the
 *           contract-accepts-0/task-gates-0 contradiction a prior task's
 *           review found for a different type. Joined
 *           CONFIG_WRITING_PROPOSAL_TYPES (proposals/actions.ts) for the
 *           same reason update_catalog_item did: the catalog HTTP routes
 *           require settings:update, which a dispatcher's proposals:approve
 *           does not carry. See AddCatalogItemExecutionHandler
 *           (proposals/execution/add-catalog-item-handler.ts) for the
 *           category/unit default posture.
 *   1.15.0 — Task 11 (2026-08-07 tradesperson plan), additive: log_mileage
 *           — an ALIAS intent onto the EXISTING `log_expense` proposal type
 *           (no new ProposalType, no new execution handler, no migration).
 *           A technician logs drive miles for the tax-deduction mileage
 *           log ("Log 32 miles to the Patel job"). New extraction field
 *           (mileageMiles, a possibly-fractional number, deliberately NOT
 *           the plan's literal suggested name `miles` — a generic key in a
 *           shared entity bag risks collision with a future intent);
 *           reuses the existing jobReference seam (JOB_REF_INTENTS
 *           membership — entity-resolution.ts — mirrors log_expense's own
 *           membership). Quality-review fix (2026-08-09) —
 *           `LogExpenseTaskHandler` (ai/tasks/voice-extended-tasks.ts)
 *           branches on `context.intent === 'log_mileage'` (TaskContext.
 *           intent), not the presence of `mileageMiles`: the classifier's
 *           extraction shape is one global template the taxonomy only
 *           INSTRUCTS per intent, not structurally scopes, so keying on
 *           field presence let a stray field from the OTHER alias hijack
 *           (or get silently dropped by) the wrong branch. Converts miles ×
 *           DEFAULT_MILEAGE_RATE_CENTS_PER_MILE (70¢, the 2026 IRS standard
 *           rate — a constant, not tenant config) into `amountCents`,
 *           forcing `category: 'vehicle'`.
 *   1.17.0 — Follow-up (2026-08-09), additive coverage extension (no new
 *           intent): `lookup_materials` now advertises date-scoped
 *           phrasing again ("what do I need for tomorrow?"), reusing the
 *           EXISTING `dateTimeDescription` extraction slot (the same one
 *           `lookup_crew_schedule` already populates — no new field).
 *           Taxonomy 1.13.0 had REMOVED this phrasing because
 *           `MaterialItemListOptions` had no date filter, so the ask could
 *           only be answered by mentioning `neededBy` per item, not by
 *           narrowing the query — see `lookup-materials.ts`'s module doc
 *           comment. That filter (`neededByBefore`) now exists on BOTH
 *           `MaterialItemRepository` backends, and `lookup-materials.ts`
 *           resolves the phrase via `resolveSpokenDay`
 *           (ai/scheduling/resolve-datetime.ts) exactly like
 *           `lookup_crew_schedule` does — restoring the phrase only once
 *           it was actually wired through, not before.
 */
export const INTENT_TAXONOMY_VERSION = '1.17.0';

/**
 * P11-001: convenience predicate the FSM adapter uses to route
 * `lookup_*` intents to the read-only skill family instead of the
 * proposal-draft pipeline.
 */
export function isLookupIntent(intent: IntentType | undefined | null): boolean {
  return typeof intent === 'string' && intent.startsWith('lookup_');
}

/**
 * Customer-side protection intents: complaint + negotiation.
 * These MUST be available on ordinary customer calls (not only owner
 * sessions). Gated by `ClassifyContext.customerProtectionIntents` (or
 * legacy `extendedIntents` for back-compat). Excluded from owner lookup
 * skill routing.
 */
export const CUSTOMER_PROTECTION_INTENT_TYPES = new Set<IntentType>([
  'complaint',
  'negotiation',
]);

/**
 * Owner/operator extended READ-ONLY lookups (day overview, digest, pending).
 * Require `ClassifyContext.extendedIntents === true` (typically owner line
 * + tenant flag). Never enabled for anonymous customers.
 */
export const OWNER_EXTENDED_LOOKUP_INTENT_TYPES = new Set<IntentType>([
  'lookup_day_overview',
  'lookup_digest',
  'lookup_pending_items',
  // Task 10 (2026-08-07 tradesperson plan) — owner/dispatcher-only crew
  // reports. `lookup_my_day` is deliberately NOT here — see its own doc
  // comment on IntentType.
  'lookup_crew_schedule',
  'lookup_timesheets',
]);

/**
 * Full set of "extended" intents for belt-and-braces routing.
 * Prefer isCustomerProtectionIntent / isOwnerExtendedLookupIntent for
 * new gates — this union remains for legacy checks.
 */
export const EXTENDED_INTENT_TYPES = new Set<IntentType>([
  ...CUSTOMER_PROTECTION_INTENT_TYPES,
  ...OWNER_EXTENDED_LOOKUP_INTENT_TYPES,
]);

/** @deprecated Use OWNER_EXTENDED_LOOKUP_INTENT_TYPES — same set. */
export const OWNER_LOOKUP_INTENT_TYPES = OWNER_EXTENDED_LOOKUP_INTENT_TYPES;

export function isCustomerProtectionIntent(
  intent: IntentType | undefined | null,
): boolean {
  return (
    typeof intent === 'string' &&
    CUSTOMER_PROTECTION_INTENT_TYPES.has(intent as IntentType)
  );
}

export function isOwnerExtendedLookupIntent(
  intent: IntentType | undefined | null,
): boolean {
  return (
    typeof intent === 'string' &&
    OWNER_EXTENDED_LOOKUP_INTENT_TYPES.has(intent as IntentType)
  );
}

export function isExtendedIntent(intent: IntentType | undefined | null): boolean {
  return typeof intent === 'string' && EXTENDED_INTENT_TYPES.has(intent as IntentType);
}

export interface ExtractedEntities {
  customerName?: string;
  jobReference?: string;
  amount?: number; // integer cents
  dateTimeDescription?: string; // raw natural language — downstream task parses
  lineItemDescriptions?: string[];
  // create_customer fields. `displayName` is the new customer's name; it is
  // intentionally distinct from `customerName` (which refers to an EXISTING
  // customer on invoice/estimate/appointment intents). `email` / `phone`
  // are optional — missing fields flow to clarification, not to 'unknown'.
  displayName?: string;
  email?: string;
  phone?: string;
  // create_customer: the service/street address the caller stated as part
  // of signing up ("Add a new customer, Mario Delingo, 412 Oak Street,
  // Scottsdale, 85254"). Free text, verbatim — the customers table has no
  // address column, so this rides on the proposal payload for the approver
  // and is only promoted to a linked service_location row on execution when
  // it parses into a COMPLETE address (street1 + city + state + postalCode),
  // matching the completeness gate used by add_service_location / leads.
  //
  // Deliberately distinct from `serviceAddress` (add_service_location — a
  // new address for an EXISTING customer) and `updatedAddress`
  // (update_customer — a corrected address on an existing record), so a
  // signup can never be mistaken for an edit to somebody else's account.
  address?: string;
  // Scheduling-edit intents (reschedule / cancel / reassign). Either
  // an appointment reference ("tomorrow's 3pm", "the Miller job",
  // "APT-0012") or a newDateTimeDescription for reschedule. Target
  // technician for reassign is a name — the review UI resolves names
  // to IDs since the classifier never touches the DB.
  appointmentReference?: string;
  newDateTimeDescription?: string;
  targetTechnicianName?: string;
  cancellationReason?: string;
  cancellationType?: 'customer_request' | 'technician_unavailable' | 'scheduling_conflict' | 'other';
  // add_note intent. `noteTargetKind` disambiguates whether the note
  // attaches to a job, customer, invoice, estimate, or appointment.
  noteBody?: string;
  noteTargetKind?: 'job' | 'customer' | 'invoice' | 'estimate' | 'appointment';
  // send_invoice intent: channel hints ("email", "sms"). Defaults
  // are resolved by the execution handler when unspecified.
  sendChannel?: 'email' | 'sms';
  // record_payment intent. paymentMethod = cash / check / card / other.
  // paymentReference = check number or memo the operator stated.
  paymentMethod?: 'cash' | 'check' | 'card' | 'other';
  paymentReference?: string;
  // create_job intent: title of the new job.
  jobTitle?: string;
  // update_customer intent. These hold the NEW values the caller wants
  // written to an EXISTING customer record (resolved via customerName or
  // the identified caller). Kept distinct from create_customer's
  // displayName/email/phone so a "change my number" command can never be
  // mistaken for a new-customer signup.
  updatedName?: string;
  updatedEmail?: string;
  updatedPhone?: string;
  updatedAddress?: string;
  // log_expense intent. amount (existing field) carries the cents value.
  expenseDescription?: string;
  expenseCategory?:
    | 'materials'
    | 'fuel'
    | 'tools'
    | 'subcontractor'
    | 'vehicle'
    | 'insurance'
    | 'office'
    | 'other';
  vendor?: string;
  // Task 11 (2026-08-07 tradesperson plan) — log_mileage intent (aliases
  // log_expense). Miles driven, possibly fractional (an odometer reading).
  // The parser only drops a non-finite value (NaN/Infinity — see
  // `Number.isFinite` in the parse allowlist below); unlike
  // materialQuantity it is NOT additionally filtered to `> 0` or rounded
  // here — a required field with domain bounds (positive, ≤ MAX_MILEAGE_
  // MILES) gets validated at the HANDLER, same posture as
  // `LogExpenseTaskHandler`'s own `amount` gate, so a spoken 0/negative/
  // out-of-range value reaches the handler and gates on `amountCents` for
  // an accurate reason instead of silently vanishing here and looking like
  // "no miles stated at all".
  mileageMiles?: number;
  // convert_lead intent: free-text reference to the lead being converted
  // (caller name or "the Johnson lead"). The execution handler resolves
  // it to a concrete leadId.
  leadReference?: string;
  // mark_lead_lost: why the lead was lost ("went with a competitor").
  lostReason?: string;
  // add_service_location: freeform address the caller stated. The
  // execution handler / review UI parses it into street/city/state/zip.
  serviceAddress?: string;
  // log_time_entry: which kind of time is being logged.
  timeEntryType?: 'job' | 'drive' | 'break' | 'admin';
  // log_time_entry: a COMPLETED amount of worked time stated after the
  // fact ("put me down for two hours"), in whole MINUTES — the unit
  // time_entries.duration_minutes stores. Absent on a plain clock-in.
  durationMinutes?: number;
  // notify_delay: how many minutes late the crew is running.
  delayMinutes?: number;
  // RV-071 — approve_proposal / reject_proposal (owner sessions only):
  // the owner's words identifying WHICH pending proposal ("the Henderson
  // estimate", "the second one", "the $450 invoice"). Resolved downstream
  // by the pendingProposals entity-resolver source — never trusted as an id.
  proposalReference?: string;
  // RV-225 — edit_proposal (owner sessions only): the owner's words
  // describing WHAT to change ("change the second line to $200"). Fed to
  // the shared edit interpreter (proposals/edit-interpreter.ts), whose
  // delta is Zod-validated by editProposal — never trusted as a payload.
  editInstruction?: string;
  // N-003 (P2-036) — negotiation: the customer's verbatim ask ("can you knock
  // $50 off?", "throw in the trip fee", "refund or I'll leave a 1-star"). The
  // guardrail handler refines it into a specific ask type deterministically.
  negotiationAsk?: string;
  // create_invoice_schedule (U2): the VERBATIM milestone/billing-plan sentence
  // ("50% deposit, rest on completion"). Flat string by design —
  // sanitizeExtractedEntities drops nested objects, so the deterministic
  // milestone-sentence-parser (never the LLM) turns this into typed milestones.
  scheduleDescription?: string;
  // respond_to_review (U3): the owner's words identifying WHICH review ("the
  // 1-star from yesterday"). Resolved downstream against recent
  // google_reviews rows — never trusted as an id.
  reviewReference?: string;
  // create_standing_instruction (UB-A2): the verbatim persistent directive
  // ("from now on always add a $79 diagnostic fee to AC calls").
  instructionText?: string;
  // create_standing_instruction: the intent the rule applies to, when the
  // speaker scoped it (e.g. "on invoices" → create_invoice). Free text — the
  // task handler normalizes it into the structured scope.
  scopeIntentHint?: string;
  // B1.18 — update_brand_voice: the VERBATIM spoken brand-voice instruction
  // ("friendly, plain-spoken, no slang, always sign off 'Thanks — Bob's
  // HVAC'"). Flat string by design, mirroring instructionText/
  // scheduleDescription — the task handler's own (separate) LLM pass maps it
  // onto the six brandVoiceSchema fields + a freeText catch-all; the
  // classifier itself never emits structured tone fields.
  brandVoiceInstruction?: string;
  // Tradesperson wave 1, Task 2 — update_catalog_item: the spoken catalog
  // (price-book) entry name the caller wants to edit. Free text; the task
  // handler resolves it against the tenant's catalog via
  // resolveLineItemToCatalog (ai/resolution/catalog-resolver.ts) — never
  // trusted as an id.
  catalogItemReference?: string;
  // update_catalog_item: the NEW unit price, in integer cents, when the
  // caller stated one ("raise it to 89 dollars" → 8900).
  unitPriceCents?: number;
  // update_catalog_item: a requested NEW name for the catalog item
  // ("rename 'AC tune-up' to 'AC seasonal service'" → "AC seasonal
  // service"). Captured for the review card; see
  // UpdateCatalogItemTaskHandler's doc comment for why a rename cannot be
  // auto-applied through this proposal type today. Qualified (not bare
  // `name`) so it can never be confused with `updatedName`
  // (update_customer) — a weaker classifier emitting the wrong one would
  // otherwise silently drop the rename.
  catalogItemNewName?: string;
  // update_catalog_item: a requested NEW description for the catalog item.
  // Same capture-only caveat and qualified-name rationale as
  // `catalogItemNewName` above.
  catalogItemNewDescription?: string;
  // Task 12 (2026-08-07 tradesperson plan) — add_catalog_item: the unit of
  // measure for a NEW price-book entry ("copper pipe, per pound"). No
  // existing ExtractedEntities field carries a catalog unit of measure, so
  // this is a genuinely new field (unlike catalogItemNewName/
  // catalogItemNewDescription/unitPriceCents, which add_catalog_item
  // REUSES from update_catalog_item — see AddCatalogItemTaskHandler's doc
  // comment). Mirrors catalog-item.ts's CatalogUnit vocabulary; validated
  // against CATALOG_UNITS at parse time (below) like every other bounded
  // enum field, so an out-of-vocabulary value never reaches the task
  // handler as if it were a real unit.
  catalogItemUnit?: 'each' | 'hour' | 'sq ft' | 'per lb' | 'per gal';
  // Tradesperson wave 1, Task 3 — record_refund: how the MANUAL refund was
  // given back (cash / check / a swiped card outside Stripe / other).
  // Qualified (not bare `method`) so it can never be confused with a future
  // unrelated `method` field on another intent — house precedent from
  // `catalogItemNewName`/`expenseDescription`. Defaults to 'cash' downstream
  // when unstated.
  refundMethod?: 'cash' | 'check' | 'card_external' | 'other';
  // record_refund: why the refund was given, verbatim ("the recharge didn't
  // hold", "part was under warranty"). Optional — rides `payload.reason`.
  refundReason?: string;
  // record_refund: the check number, when the refund method is 'check' and
  // the caller stated one ("check 2044"). Optional passthrough field.
  refundCheckNumber?: string;
  // Tradesperson wave 1, Task 4 — apply_credit: why the credit was given
  // ("repeat leak", "part was under warranty", "price match"). Qualified
  // (not bare `reason`) per house precedent (refundReason,
  // catalogItemNewName) — folded into the appended line's description by
  // ApplyCreditTaskHandler; optional, never fabricated when unstated.
  creditReason?: string;
  // Tradesperson wave 1, Task 5 — send_customer_message: the free-form
  // customer-facing text/email body to send, cleaned up but faithful to
  // what the operator said. Required on the contract; gates on the flat
  // payload key `body` when absent (see SendCustomerMessageTaskHandler).
  customerMessageBody?: string;
  // send_customer_message: which channel to send on. Defaults to 'sms'
  // downstream when unstated. Qualified (not bare `channel`) per house
  // precedent (refundMethod / catalogItemNewName).
  customerMessageChannel?: 'sms' | 'email';
  // Tradesperson wave 1, Task 6 — create_change_order: the added work the
  // customer asked for mid-job ("a second zone", "replace the flue liner
  // too"), verbatim. Qualified (not bare `description`) per house
  // precedent (expenseDescription / refundReason) — the drafting task turns
  // this into the change order's title + single line item description.
  // jobReference (existing field) carries the spoken job reference; amount
  // (existing field) carries the stated cents, when spoken.
  changeOrderDescription?: string;
  // Task 7 — create_service_agreement: the spoken name of the plan/
  // membership ("annual maintenance plan", "29-a-month membership").
  // Qualified (not bare `name`) per house precedent
  // (catalogItemNewName/refundReason) — folds directly onto the
  // contract's `name` field.
  serviceAgreementName?: string;
  // create_service_agreement: how often the plan recurs, normalized by the
  // classifier onto one of these 4 tokens (synonyms like "semiannual" or
  // "yearly" map onto twice_a_year/annual respectively — never emitted
  // verbatim). The task handler maps each token to an RRULE string
  // deterministically; an absent/invalid value gates
  // missingFields: ['recurrenceRule'].
  serviceAgreementCadence?: 'monthly' | 'quarterly' | 'twice_a_year' | 'annual';
  // create_service_agreement: the spoken plan start date/phrase
  // ("starting September", "October 1st"), verbatim — the task handler
  // parses it best-effort (chrono-node, tenant-timezone anchored) and
  // falls back to the first of next month when unstated or unparseable.
  serviceAgreementStartsOn?: string;
  // Task 9 (2026-08-07 tradesperson plan) — add_material: what the caller
  // wants added to the shopping list, verbatim ("three boxes of half-inch
  // PEX", "a flue liner kit"). Qualified (not bare `description`) per house
  // precedent (expenseDescription / changeOrderDescription) — the flat
  // gate key downstream is still the contract's own `description`.
  materialDescription?: string;
  // add_material: how many, when the caller stated a count ("three boxes",
  // "two heaters"). Defaults to 1 downstream when unstated. Qualified (not
  // bare `quantity`) per house precedent (unitPriceCents / durationMinutes).
  materialQuantity?: number;
  // add_material: when the material is needed by, verbatim ("before
  // Thursday", "by next week") — the task handler parses it best-effort
  // (chrono-node, tenant-timezone anchored); an unparseable phrase is
  // simply omitted, never gated (purely informational). Qualified (not
  // bare `neededBy`) per house precedent (serviceAgreementStartsOn).
  materialNeededBy?: string;
}

/**
 * When `intentType === 'unknown'` the router emits a
 * voice_clarification proposal instead of silently dropping.
 * `unknownReason` tells the router (and the UI) WHY routing failed
 * so the clarification message can be phrased usefully.
 *
 *   - 'empty_transcript'  — nothing to classify
 *   - 'parse_failed'      — classifier output wasn't valid JSON
 *   - 'unknown_intent'    — classifier picked 'unknown' at any confidence
 *   - 'low_confidence'    — classifier picked a real intent, but < 0.6
 *
 * `lowConfidenceIntent` is populated only on 'low_confidence': it is
 * the intent the classifier leaned toward so the clarification card
 * can offer it as a "did you mean?" suggestion.
 */
export type UnknownReason =
  | 'empty_transcript'
  | 'parse_failed'
  | 'unknown_intent'
  | 'low_confidence';

export interface IntentClassification {
  intentType: IntentType;
  confidence: number; // 0-1
  reasoning?: string;
  extractedEntities?: ExtractedEntities;
  unknownReason?: UnknownReason;
  lowConfidenceIntent?: IntentType;
  /**
   * Enum-typed fields the LLM returned with a value outside the
   * allowed set (e.g., `cancellationType: "weather"` when only
   * customer_request / technician_unavailable / scheduling_conflict /
   * other are valid). Preserved here so the router can emit a
   * structured warn log instead of silently dropping the field —
   * helps diagnose LLM prompting drift without blocking the
   * pipeline. Empty / undefined when every enum is valid.
   */
  invalidEnumFields?: Array<{ field: string; value: unknown }>;
  /**
   * Token usage from the underlying LLM call, surfaced so callers
   * (e.g., the calling-agent adapter) can feed the SessionCostTracker
   * and enforce per-session caps. Omitted when the classifier
   * short-circuits without an LLM call.
   */
  tokenUsage?: { input: number; output: number };
  /**
   * Id of the persisted `ai_runs` row for the underlying LLM classify call
   * (from `LLMResponse.aiRunId`). Surfaced so the voice path can thread a
   * REAL run id into the FSM `intent_classified` event → `create_proposal`
   * side-effect payload, letting the resulting proposal satisfy
   * `proposals.ai_run_id`'s FK with an actual row instead of null. Omitted
   * when the classifier short-circuits without an LLM call (empty transcript,
   * deterministic phrase match) or when no AiRunRepository is wired.
   */
  aiRunId?: string;
  /**
   * Story 3.4 — the intent-taxonomy version that produced this classification
   * (`INTENT_TAXONOMY_VERSION`). Stamped on every result by `classifyIntent`;
   * lets observability / correction analytics detect taxonomy drift.
   */
  taxonomyVersion?: string;
}

export interface ClassifyContext {
  tenantId: string;
  /**
   * Optional vertical-aware prompt section produced by
   * `formatVerticalForCallerPrompt(pack)` in
   * `packages/api/src/verticals/context-assembly.ts`. When supplied,
   * it is appended to the system prompt as a tenant-scoped Context
   * Block — the LLM gets the tenant's actual equipment terminology
   * and service categories so callers saying "my heater is broken"
   * map to the right canonical entity instead of a hallucinated one.
   * Closes §3B from `docs/remaining-features.md`. Optional so callers
   * that don't have a pack loaded (e.g. operator UI flows where
   * tenants may not have onboarded a vertical yet) can omit it.
   *
   * §3D extension: the resolver now also includes the pack's
   * `intakeQuestions` block in this same string when present.
   */
  verticalPromptSection?: string;
  /**
   * Optional caller-plan / membership context produced by
   * `formatCallerPlanForPrompt(ctx)` in
   * `packages/api/src/ai/orchestration/caller-plan-context.ts`.
   * Closes §3C — when a customer with an active maintenance plan
   * calls in, the agent acknowledges the plan in its replies and
   * routes with priority. Optional: when caller is unknown or has
   * no active plan the section is omitted.
   */
  planPromptSection?: string;
  /**
   * True when the inbound caller has already been resolved to an
   * existing customer (e.g. by caller-ID). Suppresses the deterministic
   * "sign up" → create_customer override: an established customer who
   * says "can I sign up?" should be recognized, not enrolled again as a
   * duplicate. Identity-unaware callers keep the create_customer
   * short-circuit (P18-001).
   */
  callerIsExistingCustomer?: boolean;
  /**
   * RV-071 — true ONLY when the session was established as a verified
   * owner line (RV-070's `CallingAgentContext.ownerSession`). Appends the
   * owner-approval prompt section (approve_proposal / reject_proposal) as
   * a SEPARATE system message — non-owner calls keep byte-identical
   * prompt messages, so voice-quality cassette hashes (and gateway cache
   * keys) are unaffected. The prompt is a hint, not the gate: routing
   * layers enforce the ownerSession check independently.
   */
  ownerSession?: boolean;
  /**
   * Phase-2 Track A (RV-010/064/085) — opt-in for OWNER extended read-only
   * lookups (lookup_day_overview, lookup_digest, lookup_pending_items;
   * Task 10 adds lookup_crew_schedule/lookup_timesheets — lookup_my_day is
   * NOT gated here, see its IntentType doc comment). When true,
   * EXTENDED_INTENTS_PROMPT_SECTION is appended and the deterministic
   * phrase matcher short-circuits day/digest/pending phrasings (crew
   * schedule/timesheets extract entities, so they are deliberately NOT
   * phrase-matched — see EXTENDED_INTENT_PHRASES's own rule). Complaint/
   * negotiation are NOT gated here — see customerProtectionIntents.
   */
  extendedIntents?: boolean;
  /**
   * Customer protection intents (complaint, negotiation). When true,
   * CUSTOMER_PROTECTION_PROMPT_SECTION is appended so haggling and
   * dissatisfaction route to guardrails on ordinary customer calls.
   * Telephony always sets this; legacy surfaces may omit (false).
   * `extendedIntents: true` also unlocks these for back-compat (assistant).
   */
  customerProtectionIntents?: boolean;
}

/**
 * Below this threshold the classifier returns 'unknown' regardless of
 * the LLM's self-reported intent. Picked at 0.6 — low enough to catch
 * obvious commands, high enough to send ambiguous transcripts to
 * clarification rather than executing the wrong action.
 */
export const CLASSIFIER_CONFIDENCE_THRESHOLD = 0.6;

/**
 * Sign-up phrasings must clear the FSM intent gate (TAU_INT = 0.75 in
 * customer-calling transitions). When the LLM returns create_customer in
 * the [0.6, 0.75) band we still bump confidence so voice does not reprompt
 * on an unambiguous new-customer request.
 */
export const SIGNUP_INTENT_ACT_THRESHOLD = 0.75;

// Exported (not just module-private) so the live-eval cost preflight
// (packages/voice-eval/live-support.ts EST_SYSTEM_PROMPT_TOKENS) can be pinned
// against the real prompt size in a test — see
// packages/api/test/voice-quality/voice-eval-live.test.ts. Never trim this
// export back to unexported without checking that test doesn't need it.
//
// Spec-review note (2026-08-08) — the schedule_inspection block's
// "Inspection — " jobTitle prefix reaches the final summary differently per
// surface (e5031cdd's commit message overstated this as one guaranteed
// rewrite). Memo-worker path (CreateAppointmentAITaskHandler,
// create-appointment-task.ts): jobTitle is only ambient "Known entities"
// JSON in the handler's own second LLM call — not a field it is told to
// read. FSM live-call/in-app paths (buildVoiceProposalPayload,
// proposals/voice-payload.ts): jobTitle promotes verbatim into
// payload.jobTitle, which CreateAppointmentExecutionHandler's SCH-02
// fallback (proposals/execution/handlers.ts) reads deterministically.
// Don't assume a future alias gets this for free on every surface.
export const SYSTEM_PROMPT = `You are an intent classifier for a field service operating system.
Given a voice transcript from a field service operator, decide which action they intend to take.

Supported intents (return exactly ONE):
- "create_invoice"      — user wants to draft a NEW invoice for work completed.
                           Extract lineItemDescriptions (one short entry per
                           distinct piece of work billed — an invoice with no
                           line items cannot be created), amount (stated total,
                           integer cents), customerName, and jobReference when
                           a job is referenced. Never invent lines; one
                           described job is ONE line.
                           Examples: "Create an invoice for Acme for 450 dollars"
                                     "Invoice the Smith job for the completed
                                      furnace repair, $350 total" →
                                      lineItemDescriptions ["completed furnace repair"]
- "draft_estimate"      — user wants to draft a new estimate/quote before work starts.
                           Example: "Draft an estimate for the Johnson water heater"
- "create_appointment"  — user wants to schedule a new appointment or follow-up.
                           Extract jobTitle (a short name for the new work
                           being scheduled), dateTimeDescription (when they
                           want it scheduled), and customerName if a specific
                           customer is named.
                           Example: "Schedule a follow-up for Mrs Lee next Tuesday at 2pm"
- "update_invoice"      — user wants to ADD or REMOVE a line item on an EXISTING
                           draft invoice. Requires an explicit invoice reference
                           (number or customer name).
                           Examples: "Add a trip fee to invoice INV-0042"
                                     "Remove the diagnostic from the Smith invoice"
- "update_estimate"     — user wants to ADD or REMOVE a line item on an EXISTING
                           draft estimate. Requires an explicit estimate reference
                           (number or customer name).
                           Examples: "Add a site visit to estimate EST-0001"
                                     "Remove the old heater from the Johnson estimate"
- "issue_invoice"       — user wants to ISSUE/FINALIZE an existing DRAFT
                           invoice: make it official and payable (draft → open,
                           issued and due dates stamped). Issue = make official;
                           send = deliver (see send_invoice). First-time
                           "send/get the bill out" phrasings imply issuing.
                           May reference the invoice explicitly by
                           number or customer name, or implicitly ("the one we
                           just drafted", "that invoice", "the Acme invoice").
                           Examples: "Issue invoice 1024"
                                     "Issue the Acme invoice"
                                     "Finalize the Smith invoice"
                                     "Make the Jones invoice official"
                                     "Send out the bill for the Acme job"
                                     "Send the invoice we just drafted"
- "batch_invoice"       — user wants to invoice ALL their completed jobs that
                           haven't been invoiced yet, in one go (a batch). On
                           approval each job gets its own draft invoice to
                           review. No entities to extract.
                           Examples: "Invoice all my completed jobs"
                                     "Bill everything that's done"
                                     "Send out invoices for all finished jobs"
- "unknown"             — anything else: genuinely ambiguous transcripts,
                           or commands without a clear target. Note that
                           read-only queries ("when is my next appointment",
                           "how much do I owe") now have dedicated
                           lookup_* intents below — only fall through to
                           "unknown" when no lookup intent matches.
- "create_customer"     — user wants to create a NEW customer record in the CRM,
                           OR an inbound CALLER is signing up as a new customer
                           themselves ("I'd like to sign up", "I'm a new
                           customer", "first time calling, please add me").
                           This is the highest-leak intent on inbound calls —
                           if the caller is not already in the system and
                           wants to become a customer, classify as
                           create_customer with high confidence.
                           Trigger phrasings include "create/add/new customer",
                           "sign up", "set up an account", "become a customer",
                           "first time calling", "add me to your system",
                           and any natural caller-side phrasing for
                           establishing a new account.
                           Extract the customer's displayName plus any stated
                           email, phone, or address. When only the name is given
                           (or even no name at all — the caller-id phone is
                           captured upstream), still classify as create_customer
                           so the downstream flow can ask a clarifying question
                           — do NOT fall back to "unknown" just because
                           email/phone or even displayName are missing.
                           When the speaker states a street address as part of
                           the signup ("..., 412 Oak Street, Scottsdale, 85254",
                           "She's over at 1207 Riverbell Drive", "He's at 34
                           Quarry Street"), put it VERBATIM in "address" — do
                           NOT drop it and do NOT reclassify as
                           add_service_location. A NEW customer stating their
                           own address is still create_customer; the address is
                           an entity on that intent, not a competing intent.
                           Examples: "Create a new customer named Alex"
                                     "Add customer Acme Corp, email alex@acme.com"
                                     "New customer: Sarah, phone 555-0100"
                                     "Add a customer called Jordan Lee"
                                     "Create customer Maria Gomez at maria@gomez.co"
                                     "Add a new customer, Mario Delingo, 412 Oak Street, Scottsdale, 85254."
                                        → displayName "Mario Delingo", address "412 Oak Street, Scottsdale, 85254"
                                     "Add Jimmy Hartlett as a new customer. He's at 34 Quarry Street."
                                        → displayName "Jimmy Hartlett", address "34 Quarry Street"
                                     "I'd like to sign up as a new customer"
                                     "I'm a new customer"
                                     "Can you set up an account for me?"
                                     "I want to become a customer"
                                     "First time calling, please add me"
                                     "Quisiera registrarme como nuevo cliente"
                                     "Soy un cliente nuevo"
- "create_job"          — user wants to open a NEW job record (distinct from
                           scheduling an appointment). Extract customerName
                           and jobTitle.
                           Examples: "Start a new job for Bob's water heater"
                                     "Create a job for Smith plumbing — kitchen drain"
- "update_job"          — user wants to change a SAFE field on an EXISTING
                           job: its status, priority, or title/description.
                           NOT money (estimates/invoices/pricing — those are
                           update_estimate/update_invoice) and NOT the
                           appointment/visit time (that's
                           reschedule_appointment). A freeform annotation
                           that doesn't change a tracked field is add_note,
                           not this. Extract jobReference (the job number or
                           customer/job descriptor).
                           Examples: "Mark the Henderson job in progress"
                                     "Change JOB-0012's priority to urgent"
                                     "Rename the Smith job to water heater replacement"
                                     "Set the Davis job back to scheduled"
                           NOT update_job: "Start a new job for Bob's water
                           heater" (create_job — no existing job referenced);
                           "Move the Miller job to Thursday at 2pm"
                           (reschedule_appointment — a time, not a job
                           field); "Add a trip fee to the Smith invoice"
                           (update_invoice — money).
- "reschedule_appointment" — user wants to move an EXISTING appointment to a
                           different time. Extract appointmentReference
                           (the old slot or the job/customer identifier)
                           and newDateTimeDescription (the new time).
                           Examples: "Move the Miller job to Thursday at 2pm"
                                     "Push tomorrow's 10am to 3pm"
                                     "Reschedule the Davis appointment to next Monday"
- "cancel_appointment"  — user wants to CANCEL an existing appointment.
                           Extract appointmentReference and, when stated,
                           cancellationReason. This is irreversible — never
                           auto-execute.
                           Examples: "Cancel tomorrow's 3pm, the customer called out"
                                     "Kill the Johnson appointment"
                                     "Cancel the Wilson job — weather closed us down"
- "reassign_appointment" — user wants an EXISTING appointment's PRIMARY
                           technician REPLACED by someone else — the named
                           person becomes the (sole) one doing the work; who
                           was on it before comes off. Extract
                           appointmentReference and targetTechnicianName.
                           "Assign NAME to JOB" is a replace, not an add — the
                           verb "assign" hands the whole job to that person.
                           "instead of" / "instead of me" is an explicit
                           replacement signal. Examples:
                                     "Give Tuesday's Davis job to Mike"
                                     "Reassign the 2pm to Sarah"
                                     "Assign Carlos to the Johnson job"
                                     "Put Carlos on the Garcia job instead of me"
- "add_crew_member"     — user wants to ADD a second/helper technician
                           ALONGSIDE the existing one on an EXISTING
                           appointment — an ATTACH, not a replace: the
                           primary tech stays on, the named person joins as
                           help. "Add NAME to JOB" (no replacement language)
                           is this, not reassign_appointment. Extract
                           appointmentReference and targetTechnicianName.
                           Examples: "Add Carlos to the Garcia appointment"
                                     "Put Mike on Tuesday's Davis job too"
- "remove_crew_member"  — user wants to REMOVE a helper/crew technician from an
                           appointment (never the primary — that is a reassign).
                           Extract appointmentReference and targetTechnicianName.
                           Examples: "Take Carlos off Tuesday's job"
                                     "Drop Mike from the Davis appointment"
- "add_note"            — user wants to attach a note to an existing record.
                           Extract noteTargetKind (job / customer / invoice /
                           estimate / appointment) and noteBody.
                           An observation, instruction or finding with NO
                           stated amount of worked time. If the sentence
                           states how long the work took ("two hours"), it
                           is log_time_entry, not add_note.
                           Examples: "Note on the Rodriguez job: customer
                                      wants a call before we arrive"
                                     "Add a note to Smith's file: prefers SMS"
                                     "Add a note that I found flue liner corrosion"
- "send_invoice"        — user wants to SEND/DELIVER an existing invoice to a
                           customer (email or SMS). Send = deliver to the
                           customer; issue = make official/payable (see
                           issue_invoice). Prefer send_invoice when a delivery
                           channel or recipient is named, or the invoice is
                           already issued ("resend", "email it again"). This is
                           a customer comms action — never auto-execute, always
                           require a screen-tap approval. Extract the
                           invoice reference and sendChannel.
                           Examples: "Send invoice INV-0042 to Sarah"
                                     "Email the Jones invoice"
                                     "Text the Miller invoice to them"
                                     "Resend the Acme invoice by email"
- "send_estimate"       — user wants to SEND an existing estimate to a
                           customer (email or SMS). This is a customer
                           comms action — never auto-execute, always
                           require a screen-tap approval. Extract the
                           estimate number or description into jobReference
                           (the shared reference field used to look up
                           estimates/invoices/jobs), and sendChannel (email
                           or sms).
                           Examples: "Send estimate EST-0042 to Sarah"
                                     "Email the Jones estimate"
                                     "Text the Miller estimate to them"
- "send_estimate_nudge" — user wants to FOLLOW UP on / re-send an estimate
                           ALREADY sent to a customer (a reminder, not a first
                           send — prefer send_estimate for the first send).
                           Customer comms — never auto-execute. Extract the
                           estimate reference.
                           Examples: "Nudge the Khan estimate again"
                                     "Follow up on the Jones quote"
                                     "Remind Sarah about her estimate"
- "send_payment_reminder" — user wants to send an overdue-payment REMINDER to a
                           customer about an unpaid/overdue invoice (on demand,
                           separate from the automatic dunning cadence).
                           Customer comms — never auto-execute. Extract the
                           invoice reference.
                           Examples: "Send a payment reminder on the Smith invoice"
                                     "Remind the Jones customer their invoice is overdue"
                                     "Chase the unpaid Acme invoice"
- "apply_late_fee"      — user wants to add a LATE FEE to an overdue invoice.
                           Money action — never auto-execute; the owner approves
                           the amount. Extract the invoice reference and, if the
                           owner stated one, the fee amount (otherwise leave it
                           for the review card — never invent a charge).
                           Examples: "Add a $25 late fee to the Smith invoice"
                                     "Charge a late fee on the overdue Jones invoice"
- "record_payment"      — user wants to log a PAYMENT received against an
                           invoice. This is money-moving — never
                           auto-execute, always require a screen-tap
                           approval. Extract amount (integer cents),
                           paymentMethod, paymentReference (check #),
                           and the invoice / customer it applies to.
                           Examples: "Mark the Jones invoice paid, 450 cash"
                                     "Record a check for 200 from Smith, check 1042"
                                     "Rodriguez paid the invoice in full"
- "emergency_dispatch"  — caller describes a life-safety or property-
                           emergency situation requiring IMMEDIATE
                           response: no heat/cool in extreme weather, gas
                           smell, burning smell, smoke, sparks, flooding,
                           burst pipe, sewage backup, no water. Skip normal
                           intent confirmation — escalate directly to
                           on-call dispatcher. Never auto-execute.
                           Examples: "There's a gas smell coming from the furnace"
                                     "My pipes burst and water is everywhere"
                                     "No heat and it's 10 degrees outside"
                                     "I smell burning from my AC unit"
- "update_customer"     — user wants to CHANGE the contact details on an
                           EXISTING customer record (phone, email, name,
                           address). Distinct from create_customer — this
                           edits a record that already exists. Put the
                           customer being edited in customerName and the
                           NEW values in updatedName / updatedEmail /
                           updatedPhone / updatedAddress.
                           Examples: "Update Sarah's phone to 555-0182"
                                     "Change the email on the Acme account to ops@acme.com"
                                     "My new number is 555-0143" (inbound caller)
                                     "Fix the spelling of Jordan's last name to Lee"
- "log_expense"         — owner/technician logs a business expense for a
                           job or the business. Capture-class, moves no
                           money. Extract amount (integer cents),
                           expenseCategory (materials/fuel/tools/
                           subcontractor/vehicle/insurance/office/other),
                           vendor, expenseDescription, and the job it
                           applies to (jobReference).
                           Examples: "Log 240 dollars at the supply house for the Johnson job"
                                     "Add a 55 dollar fuel expense"
                                     "Record 1200 to the subcontractor for the Miller install"
- "convert_lead"        — user wants to CONVERT an existing lead into a
                           customer (the lead said yes / booked). Extract
                           leadReference (the lead's name or descriptor).
                           Examples: "Convert the Johnson lead to a customer"
                                     "Turn that new lead into a customer"
                                     "The Davis lead signed — convert them"
- "confirm_appointment" — user wants to mark an EXISTING scheduled
                           appointment as confirmed (the customer
                           confirmed they'll be there). Extract
                           appointmentReference.
                           Examples: "Confirm tomorrow's 2pm appointment"
                                     "Mark the Miller appointment confirmed"
                                     "The customer confirmed Tuesday's visit"
- "mark_lead_lost"      — user wants to mark an existing lead as LOST
                           (they won't convert). Extract leadReference and
                           lostReason when stated.
                           Examples: "Mark the Johnson lead as lost"
                                     "We lost the Davis lead, went with a competitor"
                                     "Close out that lead — they're not interested"
- "add_service_location" — user wants to ADD a new service address to an
                           existing customer. Extract customerName and the
                           full serviceAddress as stated.
                           Examples: "Add a service location for Sarah at 412 Oak Street"
                                     "New address for the Acme account: 88 Industrial Way, Denver CO"
                                     "Add a second property for Jordan — 12 Pine Lane"
- "log_time_entry"      — technician wants to record work time — EITHER to
                           START tracking it (clock in) OR to record an
                           already-COMPLETED amount of time after the fact.
                           Extract jobReference, timeEntryType (job / drive
                           / break / admin), and — whenever a fixed amount
                           of time is stated — durationMinutes, in whole
                           MINUTES ("two hours" = 120, "an hour and a half"
                           = 90, "forty five minutes" = 45).
                           CORRECTIONS: when the speaker states a duration
                           and then corrects it ("two hours not one hour",
                           "this took two hours, did not take one hour"),
                           keep ONLY the corrected value — durationMinutes
                           is 120, never 60 and never both.
                           NOT add_note: a stated amount of WORKED TIME is
                           log_time_entry even when phrased as "put down" /
                           "write down" / "make a note". Use add_note only
                           when the content is an observation carrying no
                           worked duration ("add a note that I found flue
                           liner corrosion").
                           Examples: "Clock me in on the Miller job"
                                     "Start my drive time"
                                     "Log time on the Rodriguez install"
                                     "Put me down for two hours on this one"
                                     "Put down that this was two hours"
                                     "Put down that this was two hours not one hour for this one"
                                     "Log two hours on the Miller job"
                                     "This took two hours"
                                     "This took two hours, did not take one hour"
- "notify_delay"        — user wants to tell a customer the crew is
                           running late. Customer-facing comms — never
                           auto-execute. Extract appointmentReference and
                           delayMinutes when stated.
                           Examples: "Let the 10am know we're running 30 minutes behind"
                                     "Tell the Miller job we're delayed about an hour"
                                     "Text the customer that we'll be 20 minutes late"
                           NOT en_route: a stated LATE amount of time is
                           notify_delay even when the technician is also
                           about to leave — "I'm running 20 minutes late" is
                           notify_delay, never en_route.
- "en_route"            — a TECHNICIAN announces they are DEPARTING NOW for
                           an appointment ("on my way", "heading out",
                           "leaving now") — not a delay, not a schedule
                           change. Extract jobReference ONLY when a specific
                           job/customer is named; omit it for a bare "on my
                           way" (the next upcoming appointment today).
                           Examples: "On my way to the Garcia job"
                                     "Heading to my next one now"
                                     "I'm leaving for the Patel install"
                                     "En route to the 2pm"
                           NOT en_route: "I'm running 20 minutes late" (a
                           stated delay, not a departure — notify_delay);
                           "Move the Garcia job to Thursday" (a schedule
                           change — reschedule_appointment).
- "request_feedback"    — user wants to send a post-job feedback / review
                           request to a customer. Customer-facing comms —
                           never auto-execute. Extract the jobReference or
                           customerName.
                           Examples: "Send a feedback request for the Johnson job"
                                     "Ask Sarah to leave a review"
                                     "Request feedback on the completed Miller work"
- "schedule_inspection"  — owner/technician books a permit/code inspection
                           visit on a job. Extract customerName, jobReference
                           (when an existing job is named, e.g. "the Patel
                           job"), jobTitle, and dateTimeDescription. The
                           inspection itself belongs in jobTitle, prefixed
                           "Inspection — " plus the type (rough-in/final/
                           other), e.g. jobTitle: "Inspection — rough-in".
                           No separate inspectionType/requestedDate/
                           requestedTime fields exist.
                           Examples: "Schedule the rough-in inspection for Thursday"
                                     "Book the final inspection on the Patel job Friday morning"
- "log_permit"           — owner/technician records a permit number/status
                           against a job. Maps to an add_note whose noteBody
                           MUST begin "PERMIT: " followed by the permit number
                           and any status the speaker gave — put that full
                           "PERMIT: ..." text in noteBody. Extract jobReference.
                           No separate permitNumber field exists.
                           Examples: "Log permit 2024-1187 on the Patel job"
                                     "Note the electrical permit was approved for the Hendersons"
- "log_warranty_claim"   — a warranty callback on past work. Maps to
                           create_job. Put "Warranty — " plus the failure
                           description into jobTitle — create_job's own
                           title field (e.g. jobTitle: "Warranty — water
                           heater pilot won't stay lit"). Extract
                           customerName. No separate problemDescription
                           field exists.
                           Examples: "Log a warranty callback for the Hendersons' water heater"
                                     "The Garcia compressor we installed failed — warranty job"
- "update_catalog_item"  — owner changes a price-book (catalog) entry:
                           price, name, or description. Capture-class; only
                           shapes FUTURE drafts. Extract catalogItemReference
                           (spoken name) and the new unitPriceCents (integer
                           cents) or new catalogItemNewName/
                           catalogItemNewDescription.
                           Examples: "Raise the diagnostic fee to 89 dollars"
                                     "Change the water heater install price to 1450"
                                     "Rename 'AC tune-up' to 'AC seasonal service'"
- "record_refund"        — owner records money given BACK to a customer
                           (cash/check/external card refund). Money-class,
                           never auto-approves. Distinct from record_payment
                           (money coming IN). Extract jobReference (the
                           invoice the refund applies to — same field
                           record_payment uses), amount (integer cents),
                           refundMethod, refundReason, refundCheckNumber
                           when spoken. This is ONLY for a refund the owner
                           gave by hand — never a Stripe-processed refund.
                           Examples: "Refund the Smiths 100 dollars on their invoice"
                                     "Give the Garcias back 250, the part was under warranty"
                                     "Record a 75 dollar check refund to Jones, check 2044"
- "apply_credit"         — owner reduces what a customer owes on an issued
                           invoice (goodwill, warranty labor, price match).
                           Money-class, never auto-approves. Extract
                           jobReference (the spoken invoice/customer ref),
                           amount (integer cents), creditReason.
                           Examples: "Knock 50 dollars off the Henderson invoice"
                                     "Apply a 100 dollar credit to Jones for the callback"
                                     "Credit the Garcias 75 — we were late"
- "send_customer_message" — owner/technician sends the customer a free-form
                           text or email (status update, part arrival, ETA,
                           thanks). Comms-class: the AI drafts the exact
                           message; the owner approves before send. Extract
                           customerName, customerMessageChannel (sms unless
                           email stated), and customerMessageBody (the
                           content to send, cleaned up but faithful).
                           Examples: "Text the Hendersons the part arrived, we can come Thursday"
                                     "Email the Garcias that the inspection passed"
                                     "Let Maria know we're finished and the gate is locked"
- "create_change_order"  — mid-job scope change the customer asked for:
                           drafts a NEW estimate tied to the EXISTING job.
                           Extract jobReference (required), the added work
                           description (changeOrderDescription), and amount
                           if spoken (integer cents).
                           Examples: "The Garcias want a second zone — change order for 1800"
                                     "Add a change order on the Patel job: replace the flue liner too"
                                     "Customer added three more outlets — write it up"
- "create_service_agreement" — owner signs a customer up for a recurring
                           maintenance plan/membership. Extract customerName,
                           serviceAgreementName, serviceAgreementCadence —
                           exactly one of monthly, quarterly, twice_a_year,
                           or annual (map "semiannual"/"every six months" to
                           twice_a_year and "yearly" to annual; NEVER emit
                           the words "twice a year" with spaces — the field
                           value must be the literal token twice_a_year) —
                           amount (integer cents per period), and
                           serviceAgreementStartsOn if spoken.
                           Examples: "Sign the Garcias up for the annual maintenance plan, 290 a year"
                                     "Put Maria on the 29-a-month membership starting September"
                                     "Quarterly filter service for the Patels, 79 per visit"
- "add_material"         — owner/technician adds parts/materials to the
                           shopping list, optionally tied to a job and
                           vendor. Extract materialDescription (required),
                           materialQuantity, jobReference, vendor,
                           materialNeededBy.
                           Examples: "Add three boxes of half-inch PEX to the shopping list"
                                     "We need a flue liner kit for the Patel job"
                                     "Pick up two 40-gallon heaters at Ferguson before Thursday"
- "create_invoice_schedule" — user wants to set up a MILESTONE / PROGRESS
                           billing plan for a job: a deposit up front and the
                           rest later, or a percentage split across stages.
                           Extract jobReference (the job or customer the plan
                           is for), put the VERBATIM milestone sentence in
                           scheduleDescription (do NOT compute amounts or
                           restate it), and amount (integer cents) only when
                           an explicit job total is stated. Distinct from
                           create_invoice (one bill now) and update_invoice
                           (edit an existing bill).
                           Examples: "Set up 50% deposit, 50% on completion for the Hendersons"
                                     "Bill the Garcia install 30/30/40"
                                     "Take a $500 deposit up front on the Miller job, rest when we finish"
                                     "Progress-bill the Patel remodel — half to start, balance on completion"
- "respond_to_review"   — owner/operator wants to REPLY to a customer review
                           (e.g. a Google review). Put the words identifying
                           WHICH review in reviewReference, verbatim ("the
                           1-star from yesterday", "that review Maria left").
                           Distinct from request_feedback (asking a customer
                           to leave a review).
                           Examples: "Respond to that 1-star review"
                                     "Reply to the bad review from yesterday"
                                     "Answer the review Maria Alvarez left us"
- "create_standing_instruction" — user states a PERSISTENT rule for how the
                           business should run from now on, not a one-off
                           command. Trigger phrasings: "from now on…",
                           "always…", "never…", "whenever…", "every time…".
                           Put the full spoken directive VERBATIM in
                           instructionText, the kind of work it applies to (if
                           stated) in scopeIntentHint, and a stated dollar
                           amount in amount (integer cents).
                           Examples: "From now on always add a $79 diagnostic fee to AC calls"
                                     "Always include a fuel surcharge on invoices"
                                     "Whenever we quote a water heater, include a permit line"
                                     "Never offer weekend slots to new customers"
                           NOT create_standing_instruction: a one-off edit
                           ("add a $79 fee to the Smith invoice" =
                           update_invoice).
- "update_brand_voice"  — the OWNER sets or edits how the AI sounds in
                           outbound customer messages: register/tone,
                           opening lines, sign-off, banned phrases, persona
                           name, or which pronoun the business uses ("we"
                           vs "I"). Put the FULL spoken instruction
                           VERBATIM in brandVoiceInstruction — do not try to
                           split it into fields yourself; a separate pass
                           maps it onto the structured fields. Distinct from
                           create_standing_instruction (a persistent
                           business RULE about pricing/scheduling, not how
                           the AI talks) and from update_customer (edits a
                           CUSTOMER record, not the tenant's own voice).
                           Never classify a request to LOCK/finalize the
                           brand voice any differently — locking is a
                           tap-only action with no voice path; still extract
                           whatever tone instruction was spoken, if any.
                           Examples: "Set my brand voice: friendly,
                                      plain-spoken, no slang, always sign
                                      off 'Thanks — Bob's HVAC'"
                                     "Make our tone more formal and never
                                      say 'no problem'"
                                     "From now on our texts should refer to
                                      the business as 'I', not 'we'"
- "operator_request"   — caller explicitly asks to speak with a person,
                          dispatcher, owner, or asks to leave the AI agent.
                          Skip normal intent confirmation — escalate
                          directly to on-call dispatcher.
                          Examples: "Let me talk to a human"
                                    "I want a real person"
                                    "Can I speak to a person please"
                                    "Transfer me to dispatch"
                                    "I don't want to talk to a bot"
                                    "Can I speak with the owner"
                          NOTE: "I want to schedule with a person" is NOT
                          operator_request — the intent is scheduling, not
                          transferring.
- "confirm"            — caller confirms or agrees to a pending action the
                          agent just proposed. Conversational, non-proposal.
                          Examples: "Yes, that's right"
                                    "Go ahead"
                                    "Correct, book it"
                                    "Yep, that works"
- "lookup_appointments" — caller is ASKING about their upcoming
                           appointment(s). Read-only — never moves money
                           or creates records. Routed to the
                           lookup_appointments skill, which speaks the
                           next visit + technician.
                           Examples: "When is my next appointment?"
                                     "What time are you coming on Tuesday?"
                                     "Do I have a service call scheduled?"
                                     "When are y'all coming out?"
                                     "Remind me when my appointment is"
- "lookup_invoices"     — caller is ASKING about invoices on their
                           account. Read-only. The skill returns count
                           + totals + per-invoice info.
                           Examples: "Do I have any invoices outstanding?"
                                     "What invoices do I owe?"
                                     "Can you read me my open invoices?"
                                     "How many bills do I have?"
                                     "What's the latest invoice you sent me?"
- "lookup_balance"      — caller is ASKING for the dollar total they
                           owe right now. Read-only.
                           Examples: "What's my balance?"
                                     "How much do I owe?"
                                     "What do I still owe you guys?"
                                     "Can you tell me my account balance?"
                                     "Total amount due on my account?"
- "lookup_jobs"         — caller is ASKING about their recent or current
                           jobs. Read-only.
                           Examples: "What jobs do I have open?"
                                     "Tell me about my last service call"
                                     "What's the status of my repair?"
                                     "Did you finish the work order?"
                                     "What jobs are on my account?"
- "lookup_agreements"   — caller is ASKING about their service plan /
                           agreement / membership. Read-only.
                           Examples: "When does my service plan run next?"
                                     "Do I still have my maintenance agreement?"
                                     "When's my next maintenance visit?"
                                     "What's on my service contract?"
                                     "Am I still on the membership plan?"
- "language_switch"     — caller asks to switch the call language.
                           Read-only, non-proposal — the adapter flips
                           the session language and acknowledges. Trigger
                           phrasings include "english please", "speak
                           english", "hablo español", "en español".
                           Spanish prompt examples (so the classifier
                           handles bilingual mid-call switches):
                              "Hablo español, por favor"
                              "¿Puedo continuar en español?"
                              "Switch to english please"
                              "I'd rather speak english"
- "lookup_account_summary" — caller asks an open-ended "what's on my
                           account" / "give me an update" question.
                           Read-only. The skill stitches the appointment,
                           balance, and agreement summaries into a
                           two-sentence digest.
                           Examples: "What's on my account?"
                                     "Give me a quick summary"
                                     "Catch me up on my account"
                                     "Where do I stand?"
                                     "Tell me about my account"
- "lookup_customer"     — caller is ASKING about the contact info or
                           CRM record we have on file for them — name,
                           phone, email, communication notes. Read-only.
                           Examples: "Can you confirm my contact info?"
                                     "What number do you have on file?"
                                     "Read me the email you have for me"
                                     "Do you have my correct address?"
                                     "Check what's on my customer record"
- "lookup_estimates"    — caller is ASKING about quotes/estimates on
                           their account — count, totals, status of
                           prior estimates. Read-only.
                           Examples: "What estimates have you sent me?"
                                     "Read me my open quotes"
                                     "Did you send me an estimate yet?"
                                     "What's the status of my quote?"
                                     "How much was that estimate?"
- "lookup_availability" — caller/operator is ASKING what appointment
                           slots are open. Read-only — routed to the
                           lookup_availability skill, which speaks the
                           next open windows.
                           Examples: "What slots do you have open this week?"
                                     "When's your next availability?"
                                     "Do you have anything open Thursday?"
                                     "What times can you come out?"
- "lookup_leads"        — owner/dispatcher is ASKING about the lead
                           pipeline (count of open leads). Read-only.
                           Examples: "How many open leads do we have?"
                                     "What's in the lead pipeline?"
                                     "How many leads are still open?"
- "lookup_revenue"      — owner is ASKING about revenue / money brought
                           in this month, or outstanding receivables.
                           Read-only.
                           Examples: "How much have we brought in this month?"
                                     "What's our revenue so far?"
                                     "How much is still outstanding?"
- "lookup_catalog"      — owner/dispatcher is ASKING what's in the
                           service catalog / price book. Read-only, and
                           OWNER-ONLY at runtime (gated on the recognized
                           owner line; a customer's spoken catalog browse
                           falls back to a human). A CUSTOMER asking what
                           something costs is NOT this — it is a draft_estimate
                           (the estimate path speaks a catalog-grounded price).
                           Examples: "What services do we offer?"
                                     "What's in our catalog?"
                                     "Do we have a catalog item for a water heater?"
- "lookup_job_profit"   — owner is ASKING whether a SPECIFIC job made money:
                           its profit / margin / "did I come out ahead". Always
                           tied to ONE job — put the job reference (customer
                           name, "the Miller job", a JOB- number) in
                           jobReference. Distinct from lookup_revenue, which is
                           the whole month's business-wide revenue. Read-only.
                           Examples: "Did I make money on the Miller job?"
                                     "What's my margin on the Johnson install?"
                                     "How'd we do on the Smith water heater?"
                                     "Did the Davis job turn a profit?"
                                     "What did I clear on JOB-0042?"
- "lookup_materials"     — read back the pending shopping list, optionally
                           for one job or scoped to a stated day ("what do
                           I need for tomorrow?"). Extract jobReference
                           when a job is named, and dateTimeDescription
                           (verbatim) when the caller scopes the ask to a
                           day — "by Friday", "for tomorrow", "before
                           Thursday". Omit dateTimeDescription when no date
                           was said; never guess one.
                           Examples: "Read me the shopping list"
                                     "What parts do I need?"
                                     "What materials are open on the Patel job?"
                                     "What do I need to grab for tomorrow?"
- "lookup_my_day"        — the SPEAKER asks about their own schedule today.
                           Available to any technician; scoped to the
                           speaker's own assignments only.
                           Examples: "What's my next job?"
                                     "What's on my schedule today?"
                                     "Where am I going after this one?"
- "log_mileage"          — technician logs drive miles (tax deduction).
                           Maps to log_expense, category "vehicle", amount =
                           miles × DEFAULT_MILEAGE_RATE_CENTS_PER_MILE (70¢,
                           2026 IRS standard rate — constant, not config).
                           Extract mileageMiles (number, required) and
                           jobReference.
                           Examples: "Log 32 miles to the Patel job"
                                     "Put down 18 miles for today's supply run"
- "add_catalog_item"     — owner adds a price-book entry (new service or
                           part with a standard price). Extract name
                           (required, catalogItemNewName), unitPriceCents
                           (required), unit (catalogItemUnit) and
                           description (catalogItemNewDescription) when
                           spoken. Distinct from update_catalog_item: this
                           is a brand-new entry, never an edit to an
                           existing one — no catalogItemReference.
                           Examples: "Add a catalog item: smart thermostat install, 385"
                                     "New price-book entry — sump pump replacement, 1200"
- "unknown"             — anything else: ambiguous transcripts, or edit
                           commands without a clear reference.

Distinctions that matter:
- "create an invoice/estimate" vs "add to invoice/estimate" — the word
  "add/remove/update" plus a reference to an EXISTING invoice or estimate
  = update_invoice or update_estimate. Any phrasing starting a NEW one
  = create_invoice or draft_estimate.
- "send/issue/deliver an invoice" is never create_invoice. Within the pair:
  issue_invoice = make a DRAFT invoice official and payable ("issue",
  "finalize", "make official", "send out the bill" for the first time);
  send_invoice = deliver/redeliver to the customer over a channel ("email
  the invoice", "text it to them", "resend"). When a channel or recipient
  is named, prefer send_invoice; bare "issue/finalize" = issue_invoice.
- Invoice vs estimate — the operator usually says which. When they say
  "invoice" or use an "INV-" prefix, use the invoice intent; when they say
  "estimate/quote" or "EST-", use the estimate intent. When genuinely
  ambiguous, prefer "unknown".
- For issue_invoice, put the invoice number or reference in jobReference.
  If the user says "the one we just drafted" with no explicit ID, omit
  jobReference — the router resolves it from conversation context.
- "add customer <name>" = create_customer (CRM record).
  "add a <thing> to <existing invoice/estimate>" = update_invoice/update_estimate.
  When "add" refers to a line item, money, or an existing document, it is
  NOT create_customer even if a customer name appears in the sentence.
- "lookup_appointments" vs "lookup_my_day" (spec-review addendum,
  2026-08-09): both can sound like "what's on my schedule" out of context,
  but they answer for DIFFERENT people. lookup_appointments is the
  CUSTOMER asking about a booking THEY are waiting on ("when are y'all
  coming out?", "what time is my appointment?") — the caller is not doing
  the work, they are having work done TO them. lookup_my_day is a
  TECHNICIAN or crew member asking about their OWN day of work to perform
  ("what's my next job?", "where am I going after this one?") — the
  caller IS the one doing the work. When the phrasing gives no other
  signal, a caller asking about "MY appointment" (singular, something
  scheduled for them) is lookup_appointments; a caller asking about "MY
  schedule/day/jobs" (plural work to do) is lookup_my_day.

Return valid JSON with exactly this shape (no prose, no markdown fences):
{
  "intentType": "<one of the values above>",
  "confidence": <number between 0 and 1>,
  "reasoning": "<one sentence explaining the classification>",
  "extractedEntities": {
    "customerName": "<string, optional — existing-customer reference on invoice/estimate/appointment>",
    "jobReference": "<string, optional>",
    "amount": <integer cents, optional>,
    "dateTimeDescription": "<verbatim date/time phrase from transcript, optional>",
    "lineItemDescriptions": ["<string>", ...],
    "displayName": "<string, optional — NEW customer's name on create_customer>",
    "email": "<string, optional — NEW customer's email on create_customer>",
    "phone": "<string, optional — NEW customer's phone on create_customer>",
    "address": "<string, optional — NEW customer's street address, verbatim, on create_customer>",
    "appointmentReference": "<string, optional — existing appointment reference>",
    "newDateTimeDescription": "<string, optional — new time for reschedule_appointment>",
    "targetTechnicianName": "<string, optional — target technician on reassign_appointment; also the named crew member on lookup_crew_schedule/lookup_timesheets>",
    "cancellationReason": "<string, optional — free-text reason on cancel_appointment>",
    "cancellationType": "<customer_request|technician_unavailable|scheduling_conflict|other, optional>",
    "noteBody": "<string, optional — the note text on add_note; on log_permit, MUST begin \"PERMIT: \" followed by the permit number/status>",
    "noteTargetKind": "<job|customer|invoice|estimate|appointment, optional>",
    "sendChannel": "<email|sms, optional — on send_invoice>",
    "paymentMethod": "<cash|check|card|other, optional — on record_payment>",
    "paymentReference": "<string, optional — check number or memo on record_payment>",
    "jobTitle": "<string, optional — title of new job on create_job (prefixed \"Warranty — \" plus what failed on log_warranty_claim); also the short name of the new work being scheduled on create_appointment (prefixed \"Inspection — \" plus the type on schedule_inspection)>",
    "updatedName": "<string, optional — new name on update_customer>",
    "updatedEmail": "<string, optional — new email on update_customer>",
    "updatedPhone": "<string, optional — new phone on update_customer>",
    "updatedAddress": "<string, optional — new address on update_customer>",
    "expenseDescription": "<string, optional — what the expense was for on log_expense>",
    "expenseCategory": "<materials|fuel|tools|subcontractor|vehicle|insurance|office|other, optional — on log_expense>",
    "vendor": "<string, optional — who was paid on log_expense, or the supply house on add_material>",
    "leadReference": "<string, optional — the lead being converted/lost on convert_lead/mark_lead_lost>",
    "lostReason": "<string, optional — why the lead was lost on mark_lead_lost>",
    "serviceAddress": "<string, optional — full address on add_service_location>",
    "timeEntryType": "<job|drive|break|admin, optional — on log_time_entry>",
    "durationMinutes": <integer MINUTES of completed work time, optional — on log_time_entry; "two hours" is 120>,
    "delayMinutes": <integer minutes, optional — on notify_delay>,
    "scheduleDescription": "<string, optional — VERBATIM milestone sentence on create_invoice_schedule>",
    "reviewReference": "<string, optional — which review, verbatim, on respond_to_review>",
    "instructionText": "<string, optional — verbatim standing rule on create_standing_instruction>",
    "scopeIntentHint": "<string, optional — what work the standing rule applies to>",
    "brandVoiceInstruction": "<string, optional — VERBATIM spoken tone/sign-off/persona instruction on update_brand_voice>",
    "catalogItemReference": "<string, optional — spoken catalog/price-book entry name on update_catalog_item>",
    "unitPriceCents": <integer cents, optional — the NEW price on update_catalog_item, or the price of the new entry on add_catalog_item>,
    "catalogItemNewName": "<string, optional — the NEW name on update_catalog_item, or the name of the new entry on add_catalog_item>",
    "catalogItemNewDescription": "<string, optional — the NEW description on update_catalog_item, or the description of the new entry on add_catalog_item>",
    "catalogItemUnit": "<each|hour|sq ft|per lb|per gal, optional — unit of measure on add_catalog_item>",
    "refundMethod": "<cash|check|card_external|other, optional — on record_refund>",
    "refundReason": "<string, optional — why the refund was given on record_refund>",
    "refundCheckNumber": "<string, optional — check number on record_refund>",
    "creditReason": "<string, optional — why the credit was given on apply_credit>",
    "customerMessageBody": "<string, optional — the message content to send on send_customer_message, cleaned up but faithful>",
    "customerMessageChannel": "<sms|email, optional — on send_customer_message, defaults to sms>",
    "changeOrderDescription": "<string, optional — the added work, verbatim, on create_change_order>",
    "serviceAgreementName": "<string, optional — the plan/membership name on create_service_agreement>",
    "serviceAgreementCadence": "<monthly|quarterly|twice_a_year|annual, optional — recurring cadence on create_service_agreement>",
    "serviceAgreementStartsOn": "<string, optional — verbatim spoken start date/phrase on create_service_agreement>",
    "materialDescription": "<string, optional — what to add to the shopping list on add_material>",
    "materialQuantity": <integer, optional — how many on add_material, defaults to 1>,
    "materialNeededBy": "<string, optional — verbatim spoken needed-by date/phrase on add_material>",
    "mileageMiles": <number, optional — miles driven on log_mileage; may be fractional>
  }
}

Confidence calibration:
- 0.9+ : unambiguous command, key entities extracted
- 0.7-0.9 : clear command, some entities missing but inferable
- 0.5-0.7 : probable command, significant entity gaps
- below 0.5 : ambiguous — prefer "unknown"

Never invent entities. Extract only what the transcript actually says.`;

/**
 * RV-071 — owner-approval prompt section. Delivered as a SEPARATE system
 * message, appended ONLY when `ClassifyContext.ownerSession` is true, so
 * every non-owner call's prompt stays byte-identical to the pre-RV-071
 * prompt (voice-quality cassettes replay unchanged).
 */
export const OWNER_APPROVAL_PROMPT_SECTION = `Owner-session intents (this caller is the VERIFIED business owner — these intents exist only on this call):
- "approve_proposal" — the owner wants to APPROVE a pending proposal/draft awaiting review.
                        Put the owner's words identifying WHICH proposal in
                        extractedEntities.proposalReference (verbatim phrase).
                        Examples: "Approve the Henderson estimate"
                                  "Approve the second one"
                                  "Go ahead and approve the 450 dollar invoice"
- "reject_proposal"  — the owner wants to REJECT / decline a pending proposal.
                        Extract proposalReference the same way.
                        Examples: "Reject the Acme invoice"
                                  "Decline the Henderson estimate"
                                  "Don't send that estimate — reject it"
- "edit_proposal"    — the owner wants to CHANGE a pending proposal before approving.
                        Extract proposalReference the same way (when the owner
                        names one) and put the owner's change instruction in
                        extractedEntities.editInstruction (verbatim phrase).
                        Examples: "Change the second line to 200 dollars"
                                  "Make the Henderson estimate 450"
                                  "On that invoice, change the labor to two hours"
Notes:
- "approve"/"reject"/"edit" must target a proposal or draft ("the estimate", "the
  invoice", "the second one"). A bare "yes"/"go ahead" answering YOUR question is still "confirm".
- Do not change the JSON output schema; proposalReference and editInstruction are
  just extra optional keys inside extractedEntities.`;

/**
 * Customer protection intents — complaint + negotiation. Appended when
 * `customerProtectionIntents` is true (live telephony for ALL callers) so
 * a haggling or dissatisfied customer never falls through to "unknown".
 * Separate from owner extended lookups to keep non-protection calls
 * free of owner-only lookup taxonomy when only protection is enabled.
 */
export const CUSTOMER_PROTECTION_PROMPT_SECTION = `Customer protection intents (enabled on this call — use when the caller is unhappy or haggling):
- "complaint"            — the caller reports DISSATISFACTION with work or service
                           already delivered: poor workmanship, rude crew,
                           wrong charge, wants to escalate. Extract the
                           complaint text into noteBody, the customer into
                           customerName, and any job into jobReference.
                           Distinct from emergency_dispatch (active
                           danger) and from update_* edits.
                           Examples: "I want to file a complaint about the install"
                                     "Mrs. Patel called furious about the leak coming back"
                                     "I'm really unhappy with the work and I want a refund"
- "negotiation"          — the caller pushes on PRICE, SCOPE, or TERMS to get a
                           better deal: asks for a discount, asks you to throw
                           work in for free, demands a refund as leverage, asks
                           to "talk to the owner/manager" to haggle, or threatens
                           a bad review / to walk away unless you lower the price.
                           Put the caller's verbatim ask in
                           extractedEntities.negotiationAsk (and customerName /
                           jobReference when stated). The agent must NOT negotiate;
                           this routes to the owner.
                           Examples: "Can you knock fifty bucks off that?"
                                     "What's the best price you can do?"
                                     "Throw in the trip fee and you've got a deal"
                                     "Give me a refund or I'll leave a one-star review"
                                     "That's too expensive — any discount for cash?"
Notes:
- complaint vs negotiation: dissatisfaction with delivered work is "complaint"
  (even when it mentions a refund as redress). A demand aimed at getting a
  cheaper price/scope/terms is "negotiation". When both are present, prefer
  "negotiation" only if the PRIMARY ask is a better deal.
- negotiation vs operator_request: "let me talk to the owner" with NO price/scope
  context is operator_request (a transfer). The same phrase used to haggle a
  price is "negotiation".
- Do not change the JSON output schema.`;

/**
 * Owner/operator extended READ-ONLY lookups. Appended ONLY when
 * `extendedIntents` is true (owner session + tenant flag typically).
 * Complaint/negotiation live in CUSTOMER_PROTECTION_PROMPT_SECTION.
 */
export const EXTENDED_INTENTS_PROMPT_SECTION = `Extended operator intents (this surface has opted in — these intents exist only on this call):
- "lookup_day_overview" — the owner/operator asks for a morning overview of
                           their day: schedule, priorities, overnight events,
                           pending approvals. Read-only.
                           Examples: "What's my day look like?"
                                     "Give me my morning overview"
                                     "What's on deck today?"
- "lookup_digest"       — the owner asks to hear their stored end-of-day
                           digest narrative. Read-only.
                           Examples: "Read me my day"
                                     "Read me my daily digest"
                                     "What did the digest say?"
- "lookup_pending_items" — the owner asks what they're WAITING ON from
                           customers: estimates sent but not accepted,
                           unpaid/overdue invoices, unanswered follow-up
                           texts. Read-only.
                           Examples: "What am I waiting on?"
                                     "What's still out there?"
                                     "Which estimates haven't been accepted?"
- "lookup_crew_schedule" — owner asks who is free / where a crew member is
                           on a given day or window. Owner-extended.
                           Examples: "Who's free Thursday afternoon?"
                                     "What's Mike's day look like?"
                                     "Where's Carlos right now?"
- "lookup_timesheets"    — owner asks logged hours per crew member for a
                           period (default: this week). Owner-extended.
                           Examples: "How many hours did Carlos log this week?"
                                     "Give me everyone's hours for the week"
Notes:
- The lookup_* entries above are READ-ONLY intents — never classify a
  command that creates or changes a record as one of them.
- "lookup_day_overview" vs "lookup_my_day" (always available, not shown in
  this section): "what's my day look like?" spoken by the OWNER about
  their OWN cross-crew overview (schedule + priorities + approvals) is
  lookup_day_overview. The SAME phrase asking about ONE named crew
  member's day ("What's Mike's day look like?") is lookup_crew_schedule,
  not lookup_day_overview — lookup_day_overview never takes a
  targetTechnicianName.
- lookup_crew_schedule/lookup_timesheets name a crew member in
  extractedEntities.targetTechnicianName when one is stated, and a day/
  window phrase in extractedEntities.dateTimeDescription when stated
  (lookup_crew_schedule only — lookup_timesheets is always "this week").
  Omit either field when the caller didn't say it; do not guess a name or
  a day.
- Do not change the JSON output schema.`;

interface OwnerOperatorCommandPattern {
  intentType: IntentType;
  pattern: RegExp;
  extract: (match: RegExpExecArray) => ExtractedEntities;
}

/**
 * U2 — narrow, deterministic coverage for the operator corpus commands that
 * repeatedly fail closed when the provider is degraded. These patterns are
 * consulted only on an authenticated owner session. They are anchored and
 * entity-bounded so nearby appointment, account-setup, generic "add", and
 * invoice-creation language still reaches the normal classifier.
 */
const OWNER_OPERATOR_COMMAND_PATTERNS: ReadonlyArray<OwnerOperatorCommandPattern> = [
  {
    intentType: 'lookup_day_overview',
    pattern:
      /^\s*(?:(?:what|which|show me|list)\s+(?:appointments?|jobs?)\s+(?:are\s+)?scheduled\s+(?:for\s+)?today|(?:show me|what(?:'s| is))\s+today(?:'s)?\s+schedule)\s*[?.!]?\s*$/i,
    extract: () => ({}),
  },
  {
    intentType: 'create_customer',
    pattern:
      /^\s*(?:new\s+customer|add\s+(?:a\s+)?customer)\s+([a-z][a-z.'-]*(?:\s+[a-z][a-z.'-]*){0,3})\s*,\s*phone(?:\s+number)?\s*(?::|is)?\s*(\+?[\d(][\d\s().-]{5,20}\d)\s*[.!?]?\s*$/i,
    extract: (match) => ({ displayName: match[1].trim(), phone: match[2].trim() }),
  },
  {
    intentType: 'create_customer',
    pattern:
      /^\s*(?:new\s+customer|add\s+(?:a\s+)?customer)\s+([a-z][a-z.'-]*(?:\s+[a-z][a-z.'-]*){0,3})\s*,\s*email\s*(?::|is)?\s*([a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,})\s*[.!?]?\s*$/i,
    extract: (match) => ({ displayName: match[1].trim(), email: match[2].trim() }),
  },
  {
    intentType: 'update_customer',
    pattern:
      /^\s*(?:update|change|fix)\s+([a-z][a-z .'-]{0,58}?)['’]s\s+phone(?:\s+number)?\s+(?:to|as)\s+(\+?[\d(][\d\s().-]{5,20}\d)\s*[.!?]?\s*$/i,
    extract: (match) => ({ customerName: match[1].trim(), updatedPhone: match[2].trim() }),
  },
  {
    intentType: 'update_customer',
    pattern:
      /^\s*(?:update|change|fix)\s+([a-z][a-z .'-]{0,58}?)['’]s\s+address\s+(?:to|as)\s+(.{3,120}?)\s*[.!?]?\s*$/i,
    extract: (match) => ({ customerName: match[1].trim(), updatedAddress: match[2].trim() }),
  },
  {
    intentType: 'lookup_customer',
    pattern:
      /^\s*(?:look\s+up|lookup)\s+(?:the\s+)?([a-z][a-z .'-]{0,58}?)\s+account\s*[.!?]?\s*$/i,
    extract: (match) => ({ customerName: match[1].trim() }),
  },
  {
    intentType: 'convert_lead',
    pattern:
      /^\s*convert\s+(?:the\s+)?([a-z][a-z .'-]{0,58}?)\s+lead\s+(?:to|into)\s+(?:a\s+)?customer\s*[.!?]?\s*$/i,
    extract: (match) => ({ leadReference: match[1].trim() }),
  },
  {
    intentType: 'create_job',
    pattern:
      /^\s*(?:open|create|start)\s+(?:a\s+)?(?:new\s+)?job\s+for\s+([^,\n]{1,60}?)\s*,\s*([^.!?\n]{2,100}?)\s*[.!?]?\s*$/i,
    extract: (match) => ({ customerName: match[1].trim(), jobTitle: match[2].trim() }),
  },
  {
    intentType: 'update_invoice',
    pattern:
      /^\s*add\s+([a-z0-9][a-z0-9 /&.'-]{0,98}?)\s+to\s+(?:the\s+)?invoice\s+(INV-\d{1,12})\s*[.!?]?\s*$/i,
    extract: (match) => ({
      jobReference: match[2].toUpperCase(),
      lineItemDescriptions: [match[1].trim().replace(/^(?:a|an|the)\s+/i, '')],
    }),
  },
  {
    intentType: 'draft_estimate',
    pattern:
      /^\s*quote\s+([a-z][a-z .'-]{0,58}?)\s+for\s+(?:a\s+)?(.{3,120}?)\s*[.!?]?\s*$/i,
    extract: (match) => ({
      customerName: match[1].trim(),
      jobReference: match[2].trim(),
    }),
  },
  {
    intentType: 'update_invoice',
    pattern:
      /^\s*(?:add\s+)?(?:a\s+)?line\s+item\s+(.{3,80}?)\s+on\s+([a-z][a-z .'-]{0,58}?)['’]s\s+bill\s*[.!?]?\s*$/i,
    extract: (match) => ({
      customerName: match[2].trim(),
      lineItemDescriptions: [match[1].trim()],
    }),
  },
  {
    intentType: 'send_invoice',
    pattern:
      /^\s*(?:sms|text)\s+([a-z][a-z .'-]{0,58}?)\s+(?:the\s+)?invoice\s+link\s*[.!?]?\s*$/i,
    extract: (match) => ({ customerName: match[1].trim() }),
  },
];

function matchOwnerOperatorCommand(transcript: string): IntentClassification | null {
  for (const entry of OWNER_OPERATOR_COMMAND_PATTERNS) {
    const match = entry.pattern.exec(transcript);
    if (!match) continue;
    return {
      intentType: entry.intentType,
      confidence: 0.95,
      reasoning: 'matched deterministic owner operator command',
      extractedEntities: entry.extract(match),
    };
  }
  return null;
}

/**
 * Deterministic short-circuit for the stereotyped extended-intent
 * phrasings (the P18-001 signup-override pattern). Consulted ONLY when
 * `ClassifyContext.extendedIntents` is true, BEFORE the LLM call — a
 * matched phrase routes with zero gateway cost and cannot regress with
 * model drift. Patterns are anchored tight so ordinary commands can
 * never collapse into a lookup.
 *
 * RULE: phrase short-circuits are for ENTITY-FREE READ-ONLY intents
 * only. Any intent that produces entities or drives a proposal (e.g.
 * `complaint`, which extracts noteBody / customerName / jobReference
 * and creates an add_note + callback pair) MUST NOT appear here —
 * the deterministic path returns no extractedEntities, which creates a
 * quality cliff for proposal-driving intents. The LLM prompt section
 * (EXTENDED_INTENTS_PROMPT_SECTION) owns classification + entity
 * extraction for all non-read-only extended intents.
 * Permitted phrase-match intents: lookup_day_overview, lookup_digest,
 * lookup_pending_items.
 */
const EXTENDED_INTENT_PHRASES: ReadonlyArray<{ intent: IntentType; patterns: ReadonlyArray<RegExp> }> = [
  {
    intent: 'lookup_day_overview',
    patterns: [
      /\bwhat(?:'s| is| does)\s+my\s+day\s+look(?:ing)?\s+like\b/i,
      /\b(?:give me |what's )?my morning overview\b/i,
      /\bhow(?:'s| is)\s+my\s+day\s+looking\b/i,
      /^\s*(?:what|which|show me|list)\s+(?:appointments?|jobs?)\s+(?:are\s+)?scheduled\s+(?:for\s+)?today\s*[?.!]?\s*$/i,
      /^\s*(?:show me|what(?:'s| is))\s+today(?:'s)?\s+schedule\s*[?.!]?\s*$/i,
    ],
  },
  {
    intent: 'lookup_digest',
    patterns: [
      /\bread\s+(?:me\s+)?my\s+day\b/i,
      /\b(?:read|give)\s+me\s+(?:my|the)\s+(?:daily\s+)?digest\b/i,
      /\bwhat\s+did\s+the\s+digest\s+say\b/i,
    ],
  },
  {
    intent: 'lookup_pending_items',
    patterns: [
      /\bwhat\s+(?:am\s+i|are\s+we)\s+(?:still\s+)?waiting\s+on\b/i,
      /\bwhat(?:'s| is)\s+(?:still\s+)?(?:out\s+there|outstanding)\s+waiting\b/i,
    ],
  },
];

export function matchExtendedIntentPhrase(transcript: string): IntentType | null {
  if (!transcript) return null;
  for (const entry of EXTENDED_INTENT_PHRASES) {
    if (entry.patterns.some((rx) => rx.test(transcript))) return entry.intent;
  }
  return null;
}

/** RV-071 — predicate the voice routing layers use to gate owner approval intents. */
export function isVoiceApprovalIntent(
  intent: IntentType | string | undefined | null,
): intent is 'approve_proposal' | 'reject_proposal' {
  return intent === 'approve_proposal' || intent === 'reject_proposal';
}

/** RV-225 — predicate the voice routing layers use to gate the owner edit intent. */
export function isVoiceEditIntent(
  intent: IntentType | string | undefined | null,
): intent is 'edit_proposal' {
  return intent === 'edit_proposal';
}

function isSupportedIntent(value: unknown): value is IntentType {
  return typeof value === 'string' && (SUPPORTED_INTENTS as readonly string[]).includes(value);
}

function clamp01(n: number): number {
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

export function parseClassifierJson(content: string): IntentClassification | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;

  if (!isSupportedIntent(obj.intentType)) return null;

  const rawConfidence = typeof obj.confidence === 'number' ? obj.confidence : 0;
  const confidence = clamp01(rawConfidence);

  const result: IntentClassification = {
    intentType: obj.intentType,
    confidence,
  };

  if (typeof obj.reasoning === 'string') {
    result.reasoning = obj.reasoning;
  }

  // Enum-typed fields that the LLM returned with an invalid value
  // are collected here so the router can emit a structured warn log
  // (P1-5). Silent drops hide classifier-prompt drift; loud-but-
  // non-blocking logging gives us visibility without breaking flow.
  const invalidEnumFields: Array<{ field: string; value: unknown }> = [];

  // Allowed-value tables for each enum the classifier may return.
  // Kept close to the extraction loop so they live next to the
  // field names they guard. Adding a new enum means adding one
  // entry here and one line in the extraction block below — no new
  // if/else branch required.
  const CANCELLATION_TYPES = [
    'customer_request',
    'technician_unavailable',
    'scheduling_conflict',
    'other',
  ] as const;
  const NOTE_TARGET_KINDS = [
    'job',
    'customer',
    'invoice',
    'estimate',
    'appointment',
  ] as const;
  const SEND_CHANNELS = ['email', 'sms'] as const;
  const PAYMENT_METHODS = ['cash', 'check', 'card', 'other'] as const;
  const REFUND_METHODS = ['cash', 'check', 'card_external', 'other'] as const;
  const EXPENSE_CATEGORIES = [
    'materials',
    'fuel',
    'tools',
    'subcontractor',
    'vehicle',
    'insurance',
    'office',
    'other',
  ] as const;
  const TIME_ENTRY_TYPES = ['job', 'drive', 'break', 'admin'] as const;
  const SERVICE_AGREEMENT_CADENCES = ['monthly', 'quarterly', 'twice_a_year', 'annual'] as const;
  // Task 12 (2026-08-07 tradesperson plan) — mirrors catalog-item.ts's
  // CatalogUnit vocabulary (duplicated, not imported — see
  // contracts/add-catalog-item.ts's module doc comment for why).
  const CATALOG_UNITS = ['each', 'hour', 'sq ft', 'per lb', 'per gal'] as const;

  /**
   * Validate an LLM-provided value against a fixed allowed-set.
   * Returns the typed value when valid, undefined when absent, and
   * undefined with a recorded invalid-field entry when present-but-
   * out-of-set. Keeps the four enum-check blocks below to a single
   * line each.
   */
  function pickEnum<T extends string>(
    entity: Record<string, unknown>,
    fieldName: string,
    allowed: readonly T[]
  ): T | undefined {
    const value = entity[fieldName];
    if (value === undefined) return undefined;
    if ((allowed as readonly unknown[]).includes(value)) return value as T;
    invalidEnumFields.push({ field: fieldName, value });
    return undefined;
  }

  if (typeof obj.extractedEntities === 'object' && obj.extractedEntities !== null) {
    const ee = obj.extractedEntities as Record<string, unknown>;
    const extracted: ExtractedEntities = {};
    if (typeof ee.customerName === 'string') extracted.customerName = ee.customerName;
    if (typeof ee.jobReference === 'string') extracted.jobReference = ee.jobReference;
    if (typeof ee.amount === 'number') extracted.amount = ee.amount;
    if (typeof ee.dateTimeDescription === 'string') extracted.dateTimeDescription = ee.dateTimeDescription;
    if (Array.isArray(ee.lineItemDescriptions)) {
      extracted.lineItemDescriptions = ee.lineItemDescriptions.filter(
        (s): s is string => typeof s === 'string'
      );
    }
    if (typeof ee.displayName === 'string') extracted.displayName = ee.displayName;
    if (typeof ee.email === 'string') extracted.email = ee.email;
    if (typeof ee.phone === 'string') extracted.phone = ee.phone;
    if (typeof ee.address === 'string') extracted.address = ee.address;
    // Scheduling-edit fields
    if (typeof ee.appointmentReference === 'string') extracted.appointmentReference = ee.appointmentReference;
    if (typeof ee.newDateTimeDescription === 'string') extracted.newDateTimeDescription = ee.newDateTimeDescription;
    if (typeof ee.targetTechnicianName === 'string') extracted.targetTechnicianName = ee.targetTechnicianName;
    if (typeof ee.cancellationReason === 'string') extracted.cancellationReason = ee.cancellationReason;
    const cancellationType = pickEnum(ee, 'cancellationType', CANCELLATION_TYPES);
    if (cancellationType) extracted.cancellationType = cancellationType;
    // add_note fields
    if (typeof ee.noteBody === 'string') extracted.noteBody = ee.noteBody;
    const noteTargetKind = pickEnum(ee, 'noteTargetKind', NOTE_TARGET_KINDS);
    if (noteTargetKind) extracted.noteTargetKind = noteTargetKind;
    // send_invoice fields
    const sendChannel = pickEnum(ee, 'sendChannel', SEND_CHANNELS);
    if (sendChannel) extracted.sendChannel = sendChannel;
    // record_payment fields
    const paymentMethod = pickEnum(ee, 'paymentMethod', PAYMENT_METHODS);
    if (paymentMethod) extracted.paymentMethod = paymentMethod;
    if (typeof ee.paymentReference === 'string') extracted.paymentReference = ee.paymentReference;
    // create_job fields
    if (typeof ee.jobTitle === 'string') extracted.jobTitle = ee.jobTitle;
    // update_customer fields
    if (typeof ee.updatedName === 'string') extracted.updatedName = ee.updatedName;
    if (typeof ee.updatedEmail === 'string') extracted.updatedEmail = ee.updatedEmail;
    if (typeof ee.updatedPhone === 'string') extracted.updatedPhone = ee.updatedPhone;
    if (typeof ee.updatedAddress === 'string') extracted.updatedAddress = ee.updatedAddress;
    // log_expense fields
    if (typeof ee.expenseDescription === 'string') extracted.expenseDescription = ee.expenseDescription;
    const expenseCategory = pickEnum(ee, 'expenseCategory', EXPENSE_CATEGORIES);
    if (expenseCategory) extracted.expenseCategory = expenseCategory;
    if (typeof ee.vendor === 'string') extracted.vendor = ee.vendor;
    // convert_lead fields
    if (typeof ee.leadReference === 'string') extracted.leadReference = ee.leadReference;
    // mark_lead_lost fields
    if (typeof ee.lostReason === 'string') extracted.lostReason = ee.lostReason;
    // add_service_location fields
    if (typeof ee.serviceAddress === 'string') extracted.serviceAddress = ee.serviceAddress;
    // log_time_entry fields
    const timeEntryType = pickEnum(ee, 'timeEntryType', TIME_ENTRY_TYPES);
    if (timeEntryType) extracted.timeEntryType = timeEntryType;
    // A completed duration must be a positive whole number of minutes —
    // the LLM occasionally answers "2" (hours) as a float or a negative,
    // and time_entries.duration_minutes is an INTEGER column.
    if (typeof ee.durationMinutes === 'number' && Number.isFinite(ee.durationMinutes) && ee.durationMinutes > 0) {
      extracted.durationMinutes = Math.round(ee.durationMinutes);
    }
    // notify_delay fields
    if (typeof ee.delayMinutes === 'number') extracted.delayMinutes = ee.delayMinutes;
    // approve_proposal / reject_proposal fields (RV-071)
    if (typeof ee.proposalReference === 'string') extracted.proposalReference = ee.proposalReference;
    // edit_proposal fields (RV-225)
    if (typeof ee.editInstruction === 'string') extracted.editInstruction = ee.editInstruction;
    // negotiation fields (N-003)
    if (typeof ee.negotiationAsk === 'string') extracted.negotiationAsk = ee.negotiationAsk;
    // create_invoice_schedule fields (U2)
    if (typeof ee.scheduleDescription === 'string') extracted.scheduleDescription = ee.scheduleDescription;
    // respond_to_review fields (U3)
    if (typeof ee.reviewReference === 'string') extracted.reviewReference = ee.reviewReference;
    // create_standing_instruction fields (UB-A2)
    if (typeof ee.instructionText === 'string') extracted.instructionText = ee.instructionText;
    if (typeof ee.scopeIntentHint === 'string') extracted.scopeIntentHint = ee.scopeIntentHint;
    // update_brand_voice fields (B1.18)
    if (typeof ee.brandVoiceInstruction === 'string') extracted.brandVoiceInstruction = ee.brandVoiceInstruction;
    // update_catalog_item fields (Tradesperson wave 1, Task 2)
    if (typeof ee.catalogItemReference === 'string') extracted.catalogItemReference = ee.catalogItemReference;
    if (typeof ee.unitPriceCents === 'number') extracted.unitPriceCents = ee.unitPriceCents;
    if (typeof ee.catalogItemNewName === 'string') extracted.catalogItemNewName = ee.catalogItemNewName;
    if (typeof ee.catalogItemNewDescription === 'string')
      extracted.catalogItemNewDescription = ee.catalogItemNewDescription;
    // add_catalog_item fields (Task 12, 2026-08-07 tradesperson plan).
    // catalogItemNewName/catalogItemNewDescription/unitPriceCents are
    // REUSED from update_catalog_item (parsed unconditionally above,
    // regardless of intentType) — only catalogItemUnit is new here.
    const catalogItemUnit = pickEnum(ee, 'catalogItemUnit', CATALOG_UNITS);
    if (catalogItemUnit) extracted.catalogItemUnit = catalogItemUnit;
    // record_refund fields (Tradesperson wave 1, Task 3)
    const refundMethod = pickEnum(ee, 'refundMethod', REFUND_METHODS);
    if (refundMethod) extracted.refundMethod = refundMethod;
    if (typeof ee.refundReason === 'string') extracted.refundReason = ee.refundReason;
    if (typeof ee.refundCheckNumber === 'string') extracted.refundCheckNumber = ee.refundCheckNumber;
    // apply_credit fields (Tradesperson wave 1, Task 4)
    if (typeof ee.creditReason === 'string') extracted.creditReason = ee.creditReason;
    // send_customer_message fields (Tradesperson wave 1, Task 5). Channel
    // reuses SEND_CHANNELS (['email','sms']) — same allowed value set
    // send_invoice's sendChannel already validates against.
    if (typeof ee.customerMessageBody === 'string') extracted.customerMessageBody = ee.customerMessageBody;
    const customerMessageChannel = pickEnum(ee, 'customerMessageChannel', SEND_CHANNELS);
    if (customerMessageChannel) extracted.customerMessageChannel = customerMessageChannel;
    // create_change_order fields (Tradesperson wave 1, Task 6)
    if (typeof ee.changeOrderDescription === 'string') extracted.changeOrderDescription = ee.changeOrderDescription;
    // create_service_agreement fields (Task 7, 2026-08-07 tradesperson plan)
    if (typeof ee.serviceAgreementName === 'string') extracted.serviceAgreementName = ee.serviceAgreementName;
    const serviceAgreementCadence = pickEnum(ee, 'serviceAgreementCadence', SERVICE_AGREEMENT_CADENCES);
    if (serviceAgreementCadence) extracted.serviceAgreementCadence = serviceAgreementCadence;
    if (typeof ee.serviceAgreementStartsOn === 'string')
      extracted.serviceAgreementStartsOn = ee.serviceAgreementStartsOn;
    // add_material fields (Task 9, 2026-08-07 tradesperson plan). jobId is
    // deliberately NOT parsed here — it is a router-injected verified id
    // (see AddMaterialTaskHandler's doc comment), never an LLM-extracted
    // field, so it has no entry in this allowlist. jobReference and vendor
    // already flow through the shared fields above.
    if (typeof ee.materialDescription === 'string') extracted.materialDescription = ee.materialDescription;
    if (
      typeof ee.materialQuantity === 'number' &&
      Number.isFinite(ee.materialQuantity) &&
      ee.materialQuantity > 0
    ) {
      extracted.materialQuantity = Math.round(ee.materialQuantity);
    }
    if (typeof ee.materialNeededBy === 'string') extracted.materialNeededBy = ee.materialNeededBy;
    // log_mileage field (Task 11, 2026-08-07 tradesperson plan). jobReference
    // already flows through the shared field above (JOB_REF_INTENTS
    // membership — entity-resolution.ts). NOT filtered to `> 0` here (unlike
    // materialQuantity) — mileageMiles is a REQUIRED field on this intent
    // (unlike materialQuantity's optional-with-default posture), so an
    // invalid value (0, negative, an STT-garbled huge figure) must still
    // reach LogExpenseTaskHandler, which owns the real domain gate and
    // reports an accurate `amountCents` missingFields entry — dropping it
    // here would make an invalid mileage value indistinguishable from no
    // mileage being stated at all.
    if (typeof ee.mileageMiles === 'number' && Number.isFinite(ee.mileageMiles)) {
      extracted.mileageMiles = ee.mileageMiles;
    }
    if (Object.keys(extracted).length > 0) {
      result.extractedEntities = extracted;
    }
  }

  if (invalidEnumFields.length > 0) {
    result.invalidEnumFields = invalidEnumFields;
  }

  return result;
}

function unknownResult(
  reason: string,
  unknownReason: UnknownReason
): IntentClassification {
  return {
    intentType: 'unknown',
    confidence: 0,
    reasoning: reason,
    unknownReason,
  };
}

/**
 * P18-001: deterministic short-circuit for caller-side sign-up
 * phrasings. The voice-call flow has been losing every inbound
 * non-customer because the LLM was returning 'unknown' for "I'd like
 * to sign up as a new customer" — phrases that are unambiguously a
 * `create_customer` intent. We detect those phrasings up-front with a
 * cheap regex pass; the LLM is still consulted to extract entities
 * (displayName / email / phone) but the intent decision is locked in
 * by the regex so a model regression cannot silently re-introduce the
 * leak. Returns the canonical phrase set the regex matched so the
 * caller can override the LLM's intentType when (and only when) the
 * regex fired.
 *
 * Keeps the bar tight: matches are anchored to whole-word phrasings
 * to avoid false positives (e.g. "I'd like to set up an appointment"
 * must NOT collapse to create_customer).
 *
 * Includes lightweight Spanish phrasings to keep parity with the
 * P11-002 multilingual path — same intent, same confidence.
 */
const CREATE_CUSTOMER_SIGNUP_PATTERNS: ReadonlyArray<RegExp> = [
  /\bsign(?:ing)?\s*up\b(?!.*\bappointment\b)/i,
  /\bnew\s+customer\b/i,
  /\bbecome\s+a\s+customer\b/i,
  // PR #265 review fix: each "account/me" phrasing was firing on
  // adjacent appointment/schedule wording — e.g. "set up an account
  // for my appointment" was being collapsed to create_customer and
  // overriding the LLM's correct create_appointment classification.
  // Negative lookaheads exclude appointment/schedule context, and the
  // generic "add me" was tightened to "add/register me to (your) system"
  // so "add me to the schedule" stays in create_appointment.
  /\bset\s+up\s+(?:an?\s+)?account\b(?!.*\b(?:appointment|schedule)\b)/i,
  /\bopen\s+(?:an?\s+)?account\b(?!.*\b(?:appointment|schedule)\b)/i,
  /\bfirst[-\s]time\s+calling\b/i,
  /\b(?:add|register)\s+me\s+to\s+(?:your\s+)?system\b/i,
  /\bregistrarme\b/i,
  /\bcliente\s+nuevo\b/i,
  /\bnuevo\s+cliente\b/i,
];

export function isCreateCustomerSignupPhrasing(transcript: string): boolean {
  if (!transcript) return false;
  return CREATE_CUSTOMER_SIGNUP_PATTERNS.some((rx) => rx.test(transcript));
}

/**
 * Story 3.4 — "log inventory" is recognized but, per product decision, mapped
 * to expense logging (the app has no inventory/stock domain; recording
 * material/stock intake is an expense). This guard fires ONLY for clear
 * inventory-LOGGING phrasings, never for a stock QUERY ("how much stock is
 * left", "check inventory") — those stay on their own path.
 */
const INVENTORY_LOG_QUERY_GUARD =
  /\b(?:check|how\s+much|how\s+many|what(?:'s|\s+is)|do\s+we\s+have|is\s+there|level|remaining|left|in\s+stock)\b/i;
const INVENTORY_LOGGING_PATTERNS: ReadonlyArray<RegExp> = [
  /\b(?:log|record|enter|add|update|track|adjust)\b[^.?!]{0,40}\b(?:inventory|stock)\b/i,
  /\b(?:inventory|stock)\b[^.?!]{0,24}\b(?:count|log|update|adjustment|intake|received)\b/i,
  /\b(?:received|restocked|bought|purchased|picked\s+up)\b[^.?!]{0,40}\b(?:inventory|stock|materials|supplies|parts)\b/i,
];

export function isInventoryLoggingPhrasing(transcript: string): boolean {
  if (!transcript) return false;
  if (INVENTORY_LOG_QUERY_GUARD.test(transcript)) return false;
  return INVENTORY_LOGGING_PATTERNS.some((rx) => rx.test(transcript));
}

export async function classifyIntent(
  transcript: string,
  context: ClassifyContext,
  gateway: LLMGateway
): Promise<IntentClassification> {
  // Story 3.4 — single choke point that stamps the taxonomy version on every
  // classification, regardless of which of classifyIntentRaw's return paths
  // (short-circuit, override, low-confidence, unknown, success) produced it.
  const result = await classifyIntentRaw(transcript, context, gateway);
  result.taxonomyVersion = INTENT_TAXONOMY_VERSION;
  return result;
}

async function classifyIntentRaw(
  transcript: string,
  context: ClassifyContext,
  gateway: LLMGateway
): Promise<IntentClassification> {
  // Cheap short-circuit: empty / whitespace transcripts never trigger an LLM call.
  if (!transcript || transcript.trim().length === 0) {
    return unknownResult('empty transcript', 'empty_transcript');
  }

  if (context.ownerSession === true) {
    const matched = matchOwnerOperatorCommand(transcript);
    if (matched) return matched;
  }

  // Phase-2 Track A — deterministic owner extended-intent phrasings. Only on
  // opted-in surfaces, BEFORE the LLM call: no gateway cost, no cassette
  // interaction, no model-drift regression for the canonical phrasings.
  if (context.extendedIntents === true) {
    const matched = matchExtendedIntentPhrase(transcript);
    if (matched) {
      return {
        intentType: matched,
        confidence: 0.95,
        reasoning: 'matched deterministic extended-intent phrasing',
      };
    }
  }

  // Compose the system prompt: base classifier rules + (optional)
  // tenant vertical context + (optional) caller plan context. Each
  // optional block is delivered as a separate system message so it
  // doesn't dilute the canonical intent taxonomy and so per-tenant
  // prompt drift can't break the JSON contract enforced by the base
  // prompt.
  const systemMessages: Array<{ role: 'system'; content: string }> = [
    { role: 'system', content: SYSTEM_PROMPT },
  ];
  if (context.verticalPromptSection && context.verticalPromptSection.trim().length > 0) {
    systemMessages.push({
      role: 'system',
      content: `Tenant vertical context (use ONLY for entity recognition; do not change the JSON output schema):\n${context.verticalPromptSection}`,
    });
  }
  if (context.planPromptSection && context.planPromptSection.trim().length > 0) {
    systemMessages.push({
      role: 'system',
      content: `Caller plan context (use to personalize the response; do not change the JSON output schema):\n${context.planPromptSection}`,
    });
  }
  // RV-071 — owner-approval intents are documented to the model ONLY on a
  // recognized owner line (caller-ID match; see approver-identity.ts).
  // Appended last so non-owner calls keep
  // byte-identical messages (cassette hashes / gateway cache keys).
  if (context.ownerSession === true) {
    systemMessages.push({ role: 'system', content: OWNER_APPROVAL_PROMPT_SECTION });
  }
  // Customer protection (complaint/negotiation): live telephony always opts
  // in. Legacy extendedIntents also unlocks protection for back-compat
  // (assistant / opted-in recorder).
  const protectionOn =
    context.customerProtectionIntents === true || context.extendedIntents === true;
  if (protectionOn) {
    systemMessages.push({ role: 'system', content: CUSTOMER_PROTECTION_PROMPT_SECTION });
  }
  // Owner extended READ-ONLY lookups — separate section, owner-flag only.
  if (context.extendedIntents === true) {
    systemMessages.push({ role: 'system', content: EXTENDED_INTENTS_PROMPT_SECTION });
  }

  const response = await gateway.complete({
    taskType: 'classify_intent',
    // The taxonomy prompt is substantially larger than typical lightweight
    // requests. A dedicated budget prevents the in-app voice FSM from
    // misreporting a provider abort as low audio confidence.
    deadlineMs: resolveClassifyIntentDeadlineMs(),
    messages: [
      ...systemMessages,
      { role: 'user', content: transcript },
    ],
    responseFormat: 'json',
    // Top-level tenantId is what the resilience wrappers key on
    // (ProviderTenantQuotaWrapper / CachingGatewayWrapper both read
    // request.tenantId, not metadata.tenantId). Without it every tenant's
    // classify_intent calls collapsed onto the shared SYSTEM_TENANT_ID
    // quota bucket (concurrency 8 for the WHOLE platform) and, were the
    // gateway cache ever enabled, onto a shared cache key (cross-tenant
    // leak of classification + extracted entities).
    tenantId: context.tenantId,
    // Kept in metadata too: some downstream logging/consumers still read
    // tenantId from here (see gateway.ts correlationId/promptVersionId
    // metadata reads for the pattern this follows).
    metadata: { tenantId: context.tenantId },
  });

  const tokenUsage = response.tokenUsage
    ? { input: response.tokenUsage.input, output: response.tokenUsage.output }
    : undefined;
  // The persisted ai_runs id for THIS classify call. Threaded onto every
  // post-gateway return path (mirroring tokenUsage) so the voice path can
  // link the eventual proposal to a REAL ai_runs row. Undefined when no
  // AiRunRepository is wired or the best-effort run create failed.
  const aiRunId = response.aiRunId;

  const parsed = parseClassifierJson(response.content);
  // P18-001: deterministic create_customer fallback. When the
  // transcript carries a clear sign-up phrasing but the LLM returned
  // 'unknown' (or low confidence), force the intent to create_customer
  // so the voice agent never silently drops a non-customer caller.
  // We keep any extracted entities the LLM did manage to pull, and
  // pin confidence to 0.85 — comfortably above CLASSIFIER_CONFIDENCE_THRESHOLD
  // and the FSM's TAU_INT (0.75 in the calling-agent transitions).
  // An already-identified customer cannot "sign up" again — suppress the
  // deterministic create_customer override so they're recognized instead
  // of enrolled as a duplicate.
  const signupOverride =
    isCreateCustomerSignupPhrasing(transcript) && !context.callerIsExistingCustomer;
  if (!parsed) {
    if (signupOverride) {
      const result: IntentClassification = {
        intentType: 'create_customer',
        confidence: 0.85,
        reasoning: 'sign-up phrasing matched deterministic pattern',
      };
      if (tokenUsage) result.tokenUsage = tokenUsage;
      if (aiRunId) result.aiRunId = aiRunId;
      return result;
    }
    const result = unknownResult('could not parse classifier output', 'parse_failed');
    if (tokenUsage) result.tokenUsage = tokenUsage;
    if (aiRunId) result.aiRunId = aiRunId;
    return result;
  }
  if (tokenUsage) parsed.tokenUsage = tokenUsage;
  if (aiRunId) parsed.aiRunId = aiRunId;
  if (
    signupOverride &&
    (parsed.intentType === 'unknown' ||
      parsed.confidence < CLASSIFIER_CONFIDENCE_THRESHOLD ||
      parsed.intentType !== 'create_customer' ||
      (parsed.intentType === 'create_customer' &&
        parsed.confidence < SIGNUP_INTENT_ACT_THRESHOLD))
  ) {
    const overridden: IntentClassification = {
      intentType: 'create_customer',
      confidence: Math.max(0.85, parsed.confidence),
      reasoning: 'sign-up phrasing matched deterministic pattern',
      extractedEntities: parsed.extractedEntities,
    };
    if (tokenUsage) overridden.tokenUsage = tokenUsage;
    if (aiRunId) overridden.aiRunId = aiRunId;
    return overridden;
  }

  // Story 3.4 — "log inventory" maps to expense logging (product decision: no
  // inventory domain exists; material/stock intake is recorded as an expense).
  // Deterministic, post-parse: when the transcript is a clear inventory-LOGGING
  // phrasing (not a stock query) and the LLM did not already land on
  // log_expense, map it to log_expense — preserving any amount/vendor the LLM
  // extracted and defaulting the category to 'materials'. Result is a DRAFT
  // proposal a human approves; nothing is auto-executed. No prompt bytes
  // change, so classify_intent cassettes / cache keys are unaffected.
  if (parsed.intentType !== 'log_expense' && isInventoryLoggingPhrasing(transcript)) {
    const entities: ExtractedEntities = { ...(parsed.extractedEntities ?? {}) };
    if (!entities.expenseCategory) entities.expenseCategory = 'materials';
    const mapped: IntentClassification = {
      intentType: 'log_expense',
      confidence: Math.max(parsed.confidence, 0.8),
      reasoning: 'inventory-logging phrasing mapped to expense (no inventory domain)',
      extractedEntities: entities,
    };
    if (tokenUsage) mapped.tokenUsage = tokenUsage;
    if (aiRunId) mapped.aiRunId = aiRunId;
    return mapped;
  }

  // Final guardrail: low confidence → unknown, even if the LLM picked an intent.
  // We keep the original intent and confidence in the result so the router
  // can emit a clarification proposal that offers the low-confidence intent
  // as a suggestion ("did you mean: create invoice?") instead of dropping.
  if (parsed.confidence < CLASSIFIER_CONFIDENCE_THRESHOLD) {
    const lowConf: IntentClassification = {
      intentType: 'unknown',
      confidence: parsed.confidence,
      reasoning:
        parsed.reasoning ??
        `confidence ${parsed.confidence.toFixed(2)} below threshold (intent: ${parsed.intentType})`,
      extractedEntities: parsed.extractedEntities,
      unknownReason: 'low_confidence',
      lowConfidenceIntent:
        parsed.intentType !== 'unknown' ? parsed.intentType : undefined,
    };
    if (tokenUsage) lowConf.tokenUsage = tokenUsage;
    if (aiRunId) lowConf.aiRunId = aiRunId;
    return lowConf;
  }

  // Classifier picked 'unknown' at adequate confidence — nothing to route.
  // The router will emit a clarification so the operator is never left
  // wondering whether their command was heard.
  if (parsed.intentType === 'unknown') {
    return {
      ...parsed,
      unknownReason: 'unknown_intent',
    };
  }

  return parsed;
}
