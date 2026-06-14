/**
 * Static catalog of every matrix row. Specs reference rows by id; the report
 * builder uses this as the canonical list when a row never produced a manifest
 * (e.g., test crashed before writing one).
 *
 * NOTE: This catalog now reflects the end-to-end scope (provisioning, customers,
 * estimates variants, billing journey, scheduling, SMS, payments edge, voice,
 * isolation, and public portal). Legacy EST/INV/AST-only coverage is deprecated.
 *
 * `expected` documents the pre-run prediction from Phase-1 exploration.
 * It is NOT the pass criterion — actual pass/fail comes from runtime checks.
 */

export type MatrixModule =
  | 'PROV'
  | 'EST'
  | 'SCH'
  | 'SMS'
  | 'PAY'
  | 'ISO'
  | 'PROP'
  | 'RPT'
  | 'JRN'
  | 'JOB'
  | 'AGR'
  | 'LEAD'
  | 'INV'
  | 'INV-CR'
  | 'CUST'
  | 'FLAG'
  | 'TIME'
  | 'SET'
  | 'NOTE'
  | 'CAT'
  | 'CONV'
  | 'LOC'
  | 'ME'
  | 'MC'
  | 'VOX'
  | 'PORT'
  | 'AST';
export type MatrixExpectation = 'pass' | 'partial' | 'fail' | 'na';

export interface MatrixRow {
  id: string;
  module: MatrixModule;
  feature: string;
  passCriteria: string;
  expected: MatrixExpectation;
  expectedReason?: string;
}

export const MATRIX: MatrixRow[] = [
  // ----- Provisioning / verticals -----
  {
    id: 'PROV-01',
    module: 'PROV',
    feature: 'HVAC tenant provisioned with correct vertical context',
    passCriteria:
      'Onboarding configure({services:["HVAC"]}) activates the hvac pack; GET /api/settings + /api/verticals report hvac; categories/terminology are HVAC-specific',
    expected: 'pass',
  },
  {
    id: 'PROV-02',
    module: 'PROV',
    feature: 'Plumbing tenant provisioned with correct vertical context',
    passCriteria:
      'Onboarding configure({services:["Plumbing"]}) activates the plumbing pack; GET /api/settings + /api/verticals report plumbing; categories/terminology are plumbing-specific and distinct from HVAC',
    expected: 'pass',
  },

  // ----- Customers (in-app + AI voice) -----
  {
    id: 'CUST-01',
    module: 'CUST',
    feature: 'Create customers in-app (both tenants)',
    passCriteria: 'POST /api/customers returns 201; row persists under the right tenant; appears in list',
    expected: 'pass',
  },
  {
    id: 'CUST-02',
    module: 'CUST',
    feature: 'Create customer via AI voice session',
    passCriteria:
      'Voice session input yields a create_customer proposal; approve → executed; new customer row exists with result_entity_id',
    expected: 'pass',
  },

  // ----- Estimates -----
  {
    id: 'EST-01',
    module: 'EST',
    feature: 'Create draft estimate',
    passCriteria:
      'POST /api/estimates returns 201; DB row status=draft with matching totals',
    expected: 'pass',
  },
  {
    id: 'EST-02',
    module: 'EST',
    feature: 'Validation errors on estimate create',
    passCriteria: 'Invalid payload returns 4xx without persisting a row',
    expected: 'pass',
  },
  {
    id: 'EST-03',
    module: 'EST',
    feature: 'Edit draft estimate',
    passCriteria: 'PUT/PATCH updates line items and DB total_cents matches',
    expected: 'pass',
  },
  {
    id: 'EST-04',
    module: 'EST',
    feature: 'Estimate total correctness',
    passCriteria: 'Billing engine totals in API match DB total_cents',
    expected: 'pass',
  },
  {
    id: 'EST-05',
    module: 'EST',
    feature: 'Convert estimate to invoice',
    passCriteria: 'Conversion creates invoice linked to estimate',
    expected: 'partial',
  },
  {
    id: 'EST-06',
    module: 'EST',
    feature: 'Estimate tenant isolation',
    passCriteria: 'Tenant B cannot read Tenant A estimate',
    expected: 'pass',
  },

  // ----- Billing journey (estimate → invoice → payment) -----
  {
    id: 'JRN-01',
    module: 'JRN',
    feature: 'Estimate with mixed line items: create → send → accept',
    passCriteria:
      'Estimate created with labor/material/equipment items; totals match billing engine; status draft→sent→accepted',
    expected: 'pass',
  },
  {
    id: 'JRN-02',
    module: 'JRN',
    feature: 'Three estimates, invoice two → issue → pay → paid',
    passCriteria:
      'Three estimates created (distinct line items); two converted to invoices, issued, fully paid (status=paid, amount_due=0); the third left un-invoiced',
    expected: 'pass',
  },

  // ----- Scheduling (create / reschedule / cancel; incl. voice) -----
  {
    id: 'SCH-01',
    module: 'SCH',
    feature: 'Create appointment + reschedule (API)',
    passCriteria: 'POST /api/appointments creates scheduled; PUT /api/appointments/:id moves the times; version bumps',
    expected: 'pass',
  },
  {
    id: 'SCH-02',
    module: 'SCH',
    feature: 'Schedule appointment by voice (inbound)',
    passCriteria: 'Voice session scheduling utterance → create_appointment proposal → approve → executed appointment',
    expected: 'pass',
  },
  {
    id: 'SCH-03',
    module: 'SCH',
    feature: 'Cancel appointment by voice',
    passCriteria: 'Voice cancel utterance → cancel_appointment proposal → approve → executed; appointment status=canceled',
    expected: 'pass',
  },
  {
    id: 'SCH-04',
    module: 'SCH',
    feature: 'Appointment status lifecycle (confirm → in progress → complete)',
    passCriteria:
      'PUT /api/appointments/:id walks the appointment through confirmed → in_progress → completed; each transition persists to appointments.status in the DB',
    expected: 'pass',
  },
  {
    id: 'SCH-05',
    module: 'SCH',
    feature: 'Running-late delay notice (virtual status)',
    passCriteria:
      'PUT /api/appointments/:id with status=running_late + delayMinutes returns queued=true and does NOT change the stored status (it enqueues a customer delay notice rather than transitioning)',
    expected: 'pass',
  },

  // ----- SMS / notifications -----
  {
    id: 'SMS-01',
    module: 'SMS',
    feature: 'Outbound SMS dispatch records + entity_type CHECK',
    passCriteria:
      'appointment_confirmation dispatch row exists; live message_dispatches entity_type CHECK is captured; reschedule/cancel/payment_receipt inserts succeed (else recorded as a defect)',
    expected: 'partial',
    expectedReason:
      'Migration 092 CHECK allows only estimate/invoice/appointment_confirmation/delay_notice — reschedule/cancel/receipt may be DB-rejected.',
  },
  {
    id: 'SMS-02',
    module: 'SMS',
    feature: 'SMS consent / DNC gating (negative)',
    passCriteria: 'A customer with sms_consent=false produces no SMS dispatch row for a lifecycle event',
    expected: 'pass',
  },

  // ----- Tenant isolation / RLS -----
  {
    id: 'ISO-01',
    module: 'ISO',
    feature: 'Cross-tenant isolation across core entities + RLS',
    passCriteria:
      "Tenant B cannot read Tenant A customer/job/estimate/invoice/conversation/attachments/recording; cross-tenant note write blocked; audit_events hidden under B GUC; no-GUC RLS probe returns 0 rows",
    expected: 'pass',
  },

  // ----- Payments edge cases -----
  {
    id: 'PAY-01',
    module: 'PAY',
    feature: 'Partial → full payment + over-payment guard',
    passCriteria:
      'Partial payment → partially_paid; over-payment (> amount_due) rejected; remainder payment → paid with amount_due=0',
    expected: 'pass',
  },
  {
    id: 'PAY-02',
    module: 'PAY',
    feature: 'Deposit credit auto-applied on first invoice',
    passCriteria:
      "A job with deposit_paid_cents set yields a 'deposit_credit' payment on its first invoice and a reduced amount_due",
    expected: 'partial',
    expectedReason: 'Requires a read-write DB conn to seed the deposit; auto-credit path verified live.',
  },
  {
    id: 'PAY-03',
    module: 'PAY',
    feature: 'Money dashboard reflects paid revenue',
    passCriteria: 'GET /api/reports/money-dashboard shows non-zero revenue after invoices are paid',
    expected: 'pass',
  },
  {
    id: 'PAY-04',
    module: 'PAY',
    feature: 'Overdue invoice money-state',
    passCriteria: "A past-due open invoice drives job money_state to 'overdue' (worker-computed)",
    expected: 'partial',
    expectedReason: 'Worker-driven, no HTTP trigger; needs RW conn to backdate due_date + the overdue sweep running.',
  },

  // ----- Public portal (token-gated, no auth) -----
  {
    id: 'PORT-01',
    module: 'PORT',
    feature: 'Public estimate approval via view token',
    passCriteria:
      'Send estimate → obtain view token → GET /public/estimates/:token (200) → approve → status accepted; malformed token → 400/404',
    expected: 'pass',
  },
  {
    id: 'PORT-02',
    module: 'PORT',
    feature: 'Public invoice view + checkout via view token',
    passCriteria:
      'Send invoice → obtain view token → GET /public/invoices/:token (200) → checkout returns a URL (or 400 if Stripe unconfigured); malformed token → 400/404',
    expected: 'pass',
  },

  // ----- Voice / AI edge cases -----
  {
    id: 'VOX-01',
    module: 'VOX',
    feature: 'Emergency triage fast-path (voice)',
    passCriteria: 'An emergency utterance (no-heat + gas smell) routes the session to escalation rather than a normal booking',
    expected: 'pass',
  },
  {
    id: 'VOX-02',
    module: 'VOX',
    feature: 'Spanish / i18n voice response',
    passCriteria: 'A Spanish utterance yields a Spanish-language response (language detection / switch)',
    expected: 'pass',
  },
  {
    id: 'VOX-03',
    module: 'VOX',
    feature: 'DNC suppression of outbound SMS',
    passCriteria: 'A phone on the tenant DNC list receives no SMS dispatch when an estimate is sent to it',
    expected: 'pass',
  },
  {
    id: 'VOX-04',
    module: 'VOX',
    feature: 'Telephony-only edge cases (documented coverage gap)',
    passCriteria:
      'Records the cases not exercisable in simulated/in-app mode: business-hours enforcement, plan caller-context, phone rate-limiting, tech "out today" SMS, dropped-call recovery, session cost caps',
    expected: 'na',
    expectedReason: 'Require live Twilio (signed webhooks / real call) or non-API config; documented, not driven.',
  },
  {
    id: 'VOX-05',
    module: 'VOX',
    feature: 'Voice-triggered estimate draft creation',
    passCriteria:
      'Voice utterance yields an estimate proposal; approve → executed; estimates row exists with result_entity_id',
    expected: 'pass',
  },
  {
    id: 'VOX-06',
    module: 'VOX',
    feature: 'Voice-triggered estimate send transition',
    passCriteria:
      'Voice utterance to send an estimate yields a send proposal or send action; estimate status becomes sent in DB',
    expected: 'pass',
  },
  {
    id: 'VOX-07',
    module: 'VOX',
    feature: 'Voice-triggered invoice creation from sold work',
    passCriteria:
      'Voice utterance yields create_invoice proposal; approve → executed; invoice row linked to job exists in DB',
    expected: 'pass',
  },
  {
    id: 'VOX-08',
    module: 'VOX',
    feature: 'Voice-triggered invoice issue transition',
    passCriteria:
      'Voice utterance to issue an invoice yields issue proposal or action; invoice status=open with issued_at in DB',
    expected: 'pass',
  },
  {
    id: 'VOX-09',
    module: 'VOX',
    feature: 'Voice session visible in interactions timeline',
    passCriteria:
      'After a voice session with input, GET /api/interactions returns the session id with channel and started_at metadata',
    expected: 'pass',
  },
  {
    id: 'VOX-10',
    module: 'VOX',
    feature: 'Voice session artifacts / DB log linkage',
    passCriteria:
      'voice_sessions row exists for the session id with tenant_id, channel, started_at; proposal rows link to session context when applicable',
    expected: 'pass',
  },
  {
    id: 'VOX-11',
    module: 'VOX',
    feature: 'Voice-created proposal appears in proposal inbox',
    passCriteria:
      'Voice utterance creates a proposal; GET /api/proposals/inbox includes that proposal id for the tenant',
    expected: 'pass',
  },

  // ----- Proposals / human-approval engine -----
  {
    id: 'PROP-01',
    module: 'PROP',
    feature: 'Scheduling proposal creation + approval-state guard',
    passCriteria:
      'POST /api/proposals (remove_crew_member, If-Match version) persists a draft proposal; rejecting a draft is refused with 409 and leaves the row a draft (human-in-the-loop guard)',
    expected: 'pass',
  },
  {
    id: 'PROP-02',
    module: 'PROP',
    feature: 'Proposal inbox prioritization endpoint',
    passCriteria:
      'GET /api/proposals/inbox returns 200 with a well-formed prioritized payload for the tenant (no cross-tenant bleed)',
    expected: 'pass',
  },
  {
    id: 'PROP-03',
    module: 'PROP',
    feature: 'Cross-tenant proposal access denial',
    passCriteria:
      "Tenant B cannot GET a proposal created under Tenant A (403/404); the engine never discloses a foreign-tenant proposal",
    expected: 'pass',
  },
  {
    id: 'PROP-04',
    module: 'PROP',
    feature: 'Time-only reschedule proposal does not 500 (regression)',
    passCriteria:
      'POST /api/proposals reschedule_appointment with no technician in the payload returns 200 (not 500) for an unassigned appointment — feasibility is skipped when no technician resolves',
    expected: 'pass',
  },

  // ----- Reports / analytics -----
  {
    id: 'RPT-01',
    module: 'RPT',
    feature: 'Money dashboard report',
    passCriteria:
      "GET /api/reports/money-dashboard returns 200 with a { data } summary for the tenant month (or 503 NOT_CONFIGURED in an env without the repo)",
    expected: 'pass',
  },
  {
    id: 'RPT-02',
    module: 'RPT',
    feature: 'Revenue-by-source report',
    passCriteria: 'GET /api/reports/revenue-by-source returns 200 with a { data: [] } attribution array scoped to the tenant',
    expected: 'pass',
  },
  {
    id: 'RPT-03',
    module: 'RPT',
    feature: 'Time-given-back report',
    passCriteria:
      'GET /api/reports/time-given-back returns 200 with a { data } summary (or 503 NOT_CONFIGURED when the reporter dep is absent)',
    expected: 'pass',
  },

  // ----- Jobs lifecycle -----
  {
    id: 'JOB-01',
    module: 'JOB',
    feature: 'Job status lifecycle (new → scheduled → in_progress → completed)',
    passCriteria:
      'POST /api/jobs creates a job in `new`; POST /:id/transition walks it scheduled → in_progress → completed, each step persisting the new status in the DB',
    expected: 'pass',
  },
  {
    id: 'JOB-02',
    module: 'JOB',
    feature: 'Invalid job transition rejected',
    passCriteria:
      'A disallowed transition (new → completed) is refused (4xx) and leaves the job in its original status — the lifecycle state machine is enforced server-side',
    expected: 'pass',
  },

  // ----- Service agreements (recurring) -----
  {
    id: 'AGR-01',
    module: 'AGR',
    feature: 'Create recurring service agreement',
    passCriteria:
      'POST /api/agreements persists an active agreement with the recurrence rule, price, and next-run scheduling; GET /:id resolves it with run history',
    expected: 'pass',
  },
  {
    id: 'AGR-02',
    module: 'AGR',
    feature: 'Agreement pause → resume → cancel lifecycle',
    passCriteria:
      'pause sets status=paused, resume returns it to active, cancel sets status=cancelled; each transition is reflected in API + DB and cancel is terminal',
    expected: 'pass',
  },

  // ----- Leads pipeline -----
  {
    id: 'LEAD-01',
    module: 'LEAD',
    feature: 'Lead stage progression + won-guard',
    passCriteria:
      'A lead is advanced new→contacted→qualified→quoted via PATCH (each persisted); a direct PATCH to stage=won is refused (400) — promotion to won must go through convertToCustomer',
    expected: 'pass',
  },
  {
    id: 'LEAD-02',
    module: 'LEAD',
    feature: 'Lead lost with reason',
    passCriteria:
      'POST /api/leads/:id/lose with a reason sets stage=lost and records the lost_reason; the lead is removed from the active pipeline',
    expected: 'pass',
  },

  // ----- Invoice lifecycle (issue / void) -----
  {
    id: 'INV-01',
    module: 'INV',
    feature: 'Invoice issue → void lifecycle',
    passCriteria:
      'POST /api/invoices creates a draft; /:id/issue moves it to open (issuedAt stamped); /:id/transition status=void voids it — each persisted in the DB',
    expected: 'pass',
  },
  {
    id: 'INV-02',
    module: 'INV',
    feature: 'Invalid invoice transition rejected',
    passCriteria:
      'A disallowed transition (draft → void) is refused (4xx) and the invoice stays draft — the invoice state machine is enforced server-side',
    expected: 'pass',
  },

  // ----- Customer archive -----
  {
    id: 'CUST-03',
    module: 'CUST',
    feature: 'Archive customer',
    passCriteria:
      'POST /api/customers/:id/archive sets is_archived=true (archived_at stamped); the customer drops out of the default active list',
    expected: 'pass',
  },

  // ----- Feature flags -----
  {
    id: 'FLAG-01',
    module: 'FLAG',
    feature: 'Feature-flag admin is platform-admin gated',
    passCriteria:
      'A tenant owner is refused (401/403/503) on both GET and PUT against /api/admin/feature-flags — the platform-admin gate blocks tenant-level callers from toggling platform flags',
    expected: 'pass',
  },

  // ----- Time tracking -----
  {
    id: 'TIME-01',
    module: 'TIME',
    feature: 'Technician clock-in → clock-out',
    passCriteria:
      'POST /api/time-entries/clock-in opens an entry (201); POST /clock-out closes it; the DB time_entries row records both timestamps for the tenant',
    expected: 'pass',
  },

  // ----- Tenant settings -----
  {
    id: 'SET-01',
    module: 'SET',
    feature: 'Read + update tenant settings',
    passCriteria:
      'GET /api/settings returns the tenant settings; PUT /api/settings updates a field (e.g. businessName) and a subsequent GET reflects it',
    expected: 'pass',
  },

  // ----- Notes -----
  {
    id: 'NOTE-01',
    module: 'NOTE',
    feature: 'Note CRUD on a job',
    passCriteria:
      'POST /api/notes creates a note on a job; GET lists it; PUT edits the content; DELETE removes it and the list/DB no longer contain it',
    expected: 'pass',
  },

  // ----- Catalog / price book -----
  {
    id: 'CAT-01',
    module: 'CAT',
    feature: 'Catalog item CRUD',
    passCriteria:
      'POST /api/catalog/items creates an item; it appears in the list; PUT updates its price; DELETE archives/removes it from the active list',
    expected: 'pass',
  },

  // ----- Conversations / messages -----
  {
    id: 'CONV-01',
    module: 'CONV',
    feature: 'Conversation + message thread',
    passCriteria:
      'POST /api/conversations creates a thread; POST /:id/messages appends a text message; GET /:id/messages returns it in order',
    expected: 'pass',
  },

  // ----- Service locations -----
  {
    id: 'LOC-01',
    module: 'LOC',
    feature: 'Service location lifecycle',
    passCriteria:
      'POST /api/locations creates a location for a customer; GET /:id returns it; PUT /:id updates a field; POST /:id/archive marks it archived (is_archived=true in the DB)',
    expected: 'pass',
  },

  // ----- Estimate revise (sent → versioned revision) -----
  {
    id: 'EST-R1',
    module: 'EST',
    feature: 'Revise a sent estimate (versioned snapshot)',
    passCriteria:
      'A draft estimate is transitioned to sent, then POST /:id/revise (If-Match=version) bumps version to 2, stamps last_revised_at, and writes a prior-version snapshot row to document_revisions',
    expected: 'pass',
  },

  // ----- Current user (/api/me) -----
  {
    id: 'ME-01',
    module: 'ME',
    feature: 'Current-user profile + mode switch',
    passCriteria:
      'GET /api/me returns the authenticated user_id/tenant_id/role; POST /api/me/mode rejects an invalid mode (400) and accepts a valid one (204), emitting a mode_switched audit event',
    expected: 'pass',
  },

  // ----- Maintenance contracts -----
  {
    id: 'MC-01',
    module: 'MC',
    feature: 'Create + read a maintenance contract',
    passCriteria:
      'POST /api/maintenance-contracts creates an active contract; GET /:id and the list return it; a maintenance_contract.created audit event is recorded',
    expected: 'pass',
  },

  // ----- Golden end-to-end journey -----
  {
    id: 'JRN-03',
    module: 'JRN',
    feature: 'Golden funnel: intake → lead → convert → job → estimate → invoice issued',
    passCriteria:
      'Public intake → lead → convert → location → job → estimate (totals checked) → estimate sent → invoice created+issued (open), each verified in the DB. The delivery/payment tail (SendGrid/Stripe) is attempted; PASS when the delivery leg is accepted, PARTIAL when it is mock/unavailable (no false pass).',
    expected: 'pass',
  },

  // ----- Legacy invoice detail rows (invoices.spec.ts; distinct from INV lifecycle) -----
  {
    id: 'INV-CR-01',
    module: 'INV-CR',
    feature: 'Create invoice (detail spec)',
    passCriteria: 'POST /api/invoices returns 201; DB row status=draft',
    expected: 'pass',
  },
  {
    id: 'INV-CR-02',
    module: 'INV-CR',
    feature: 'List/filter invoices (detail spec)',
    passCriteria: 'GET /api/invoices returns 200 with filter support or documents absence',
    expected: 'partial',
  },
  {
    id: 'INV-03',
    module: 'INV-CR',
    feature: 'Send/issue invoice (detail spec)',
    passCriteria: 'Issue endpoint moves invoice to open with issued_at',
    expected: 'partial',
  },
  {
    id: 'INV-04',
    module: 'INV-CR',
    feature: 'Payment link generation',
    passCriteria: 'Payment link HTTP endpoint returns 200/201',
    expected: 'fail',
  },
  {
    id: 'INV-05',
    module: 'INV-CR',
    feature: 'Mark paid via Stripe webhook',
    passCriteria: 'Webhook transitions invoice to paid',
    expected: 'fail',
  },
  {
    id: 'INV-06',
    module: 'INV-CR',
    feature: 'Idempotent payment handling',
    passCriteria: 'Duplicate webhook deliveries produce at most one payment row',
    expected: 'partial',
  },
  {
    id: 'INV-07',
    module: 'INV-CR',
    feature: 'Overdue lifecycle',
    passCriteria: 'Past-due invoices transition to overdue or document gap',
    expected: 'fail',
  },


  // ----- Assistant (chat intents — added from QA live-run branch; main lacked AST rows) -----
  {
    id: 'AST-01',
    module: 'AST',
    feature: 'Create customer via assistant intent',
    passCriteria:
      'POST /api/assistant/chat with a create-customer ask yields a proposal; approve → executed customer row',
    expected: 'partial',
  },
  {
    id: 'AST-02',
    module: 'AST',
    feature: 'Create estimate via assistant',
    passCriteria: 'Assistant chat drafts an estimate proposal for a job from a natural-language ask',
    expected: 'partial',
  },
  {
    id: 'AST-03',
    module: 'AST',
    feature: 'Revise estimate via assistant',
    passCriteria: 'Assistant chat revises an existing draft estimate (line-item change) via proposal',
    expected: 'partial',
  },
  {
    id: 'AST-04',
    module: 'AST',
    feature: 'Create/send invoice via assistant',
    passCriteria: 'Assistant chat creates and sends an invoice via proposal (delivery leg depends on INV-03)',
    expected: 'partial',
  },
  {
    id: 'AST-05',
    module: 'AST',
    feature: 'Payment status query via assistant',
    passCriteria: 'Assistant chat answers a payment-status query read-only (no proposal created)',
    expected: 'fail',
    expectedReason: 'Read/query intents not implemented — see qa/backlog/AST-05-query-intents.md.',
  },
  {
    id: 'AST-06',
    module: 'AST',
    feature: 'Failure handling + recovery',
    passCriteria: 'Invalid/empty assistant input returns a friendly recoverable error, not a 5xx',
    expected: 'partial',
  },
  {
    id: 'AST-07',
    module: 'AST',
    feature: 'Multi-step orchestration (customer → estimate → invoice)',
    passCriteria:
      'A multi-step ask decomposes into linked proposals (shared chainId); capture-class steps execute after approval windows, money-class steps land ready_for_review — HITL is never bypassed (full auto-executed chains would violate the money-class approval contract)',
    expected: 'fail',
    expectedReason: 'Proposal chaining not implemented — see qa/backlog/AST-07-multi-step-chaining.md.',
  },
];

export function findRow(id: string): MatrixRow | undefined {
  return MATRIX.find((r) => r.id === id);
}
