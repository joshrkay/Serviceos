/**
 * Static catalog of every matrix row. Specs reference rows by id; the report
 * builder uses this as the canonical list when a row never produced a manifest
 * (e.g., test crashed before writing one).
 *
 * `expected` documents the pre-run prediction from the Phase-1 exploration.
 * It is NOT the pass criterion — actual pass/fail comes from runtime checks.
 */

export type MatrixModule =
  | 'EST'
  | 'INV'
  | 'AST'
  | 'PROV'
  | 'CUST'
  | 'JRN'
  | 'SCH'
  | 'SMS'
  | 'PAY'
  | 'VOX'
  | 'ISO'
  | 'PORT';
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
  // ----- Estimates -----
  {
    id: 'EST-01',
    module: 'EST',
    feature: 'Create draft estimate',
    passCriteria: 'Same estimate id appears in API response, UI list, and DB row with status=draft',
    expected: 'pass',
  },
  {
    id: 'EST-02',
    module: 'EST',
    feature: 'Validation errors',
    passCriteria: 'Invalid payload returns 400, UI blocks submit, no row persisted',
    expected: 'pass',
  },
  {
    id: 'EST-03',
    module: 'EST',
    feature: 'Edit draft',
    passCriteria: 'PUT updates fields and updated_at, UI reflects new values after refresh',
    expected: 'partial',
    expectedReason: 'PUT only, no PATCH. Matrix accepts either per plan.',
  },
  {
    id: 'EST-04',
    module: 'EST',
    feature: 'Estimate total correctness',
    passCriteria: 'API total, UI total, and DB total_cents all match calculateDocumentTotals()',
    expected: 'pass',
  },
  {
    id: 'EST-05',
    module: 'EST',
    feature: 'Convert estimate to invoice',
    passCriteria: 'POST /api/invoices with estimateId creates invoice linked via estimate_id FK',
    expected: 'partial',
    expectedReason: 'No dedicated /:id/convert endpoint. Uses POST /api/invoices { estimateId }.',
  },
  {
    id: 'EST-06',
    module: 'EST',
    feature: 'Tenant isolation',
    passCriteria: "Tenant B GET on Tenant A's estimate returns 404; DB without tenant GUC returns 0 rows",
    expected: 'pass',
  },

  // ----- Invoices -----
  {
    id: 'INV-01',
    module: 'INV',
    feature: 'Create invoice',
    passCriteria: 'POST /api/invoices returns 201, row exists in DB, UI detail page loads',
    expected: 'pass',
  },
  {
    id: 'INV-02',
    module: 'INV',
    feature: 'List/filter invoices',
    passCriteria: 'GET /api/invoices returns filtered subsets matching UI and DB counts',
    expected: 'fail',
    expectedReason: 'No GET /api/invoices list endpoint implemented.',
  },
  {
    id: 'INV-03',
    module: 'INV',
    feature: 'Send invoice',
    passCriteria: 'Issue endpoint transitions status draft→open, issued_at set, UI shows issued',
    expected: 'partial',
    expectedReason: "Schema uses 'open' + issued_at (not 'sent'/sent_at). No email delivery.",
  },
  {
    id: 'INV-04',
    module: 'INV',
    feature: 'Payment link generation',
    passCriteria: 'HTTP endpoint returns Stripe payment link URL, payment_link_url persisted',
    expected: 'fail',
    expectedReason: 'StripePaymentLinkProvider exists but is not wired to an HTTP route.',
  },
  {
    id: 'INV-05',
    module: 'INV',
    feature: 'Mark paid via webhook',
    passCriteria: 'Stripe webhook flips invoice to paid with amount_paid_cents set',
    expected: 'fail',
    expectedReason: 'Stripe webhook handler exists but is not mounted on a route, no status transition.',
  },
  {
    id: 'INV-06',
    module: 'INV',
    feature: 'Idempotent payment handling',
    passCriteria: 'Second identical webhook is a no-op; only one payment row exists',
    expected: 'partial',
    expectedReason: 'Idempotency logic exists but relies on in-memory repo and no Stripe route mounted.',
  },
  {
    id: 'INV-07',
    module: 'INV',
    feature: 'Overdue lifecycle',
    passCriteria: "Past-due unpaid invoice transitions to 'overdue' status; UI shows aging badge",
    expected: 'fail',
    expectedReason: "No 'overdue' enum value, no cron or on-read computation.",
  },

  // ----- Assistant (FINAL) -----
  {
    id: 'AST-01',
    module: 'AST',
    feature: 'Create customer via assistant intent',
    passCriteria: 'Assistant chat returns create_customer proposal; approval creates row',
    expected: 'fail',
    expectedReason: "Intent classifier maps customer-creation utterances to 'unknown'.",
  },
  {
    id: 'AST-02',
    module: 'AST',
    feature: 'Create estimate via assistant',
    passCriteria: 'Assistant returns draft_estimate proposal; approval persists estimate',
    expected: 'pass',
  },
  {
    id: 'AST-03',
    module: 'AST',
    feature: 'Revise estimate via assistant',
    passCriteria: 'Assistant returns update_estimate proposal; line items revised in DB',
    expected: 'pass',
  },
  {
    id: 'AST-04',
    module: 'AST',
    feature: 'Create/send invoice via assistant',
    passCriteria: 'Assistant drafts invoice and triggers send; DB shows issued invoice',
    expected: 'partial',
    expectedReason: 'Draft works; no send_invoice proposal type yet.',
  },
  {
    id: 'AST-05',
    module: 'AST',
    feature: 'Payment status query via assistant',
    passCriteria: 'Assistant returns factually correct paid/unpaid summary for a customer',
    expected: 'fail',
    expectedReason: 'No query intents in classifier; read-only proposals not implemented.',
  },
  {
    id: 'AST-06',
    module: 'AST',
    feature: 'Failure handling + recovery',
    passCriteria: 'Invalid assistant input returns clear error, UI shows actionable message, no bad rows',
    expected: 'partial',
    expectedReason: 'Error path returns fallback message but no retry/clarification UX.',
  },
  {
    id: 'AST-07',
    module: 'AST',
    feature: 'Multi-step orchestration (customer→estimate→invoice)',
    passCriteria: 'Single conversation chains three creations linked by FK',
    expected: 'fail',
    expectedReason: 'No proposal chaining or multi-turn orchestration in codebase.',
  },

  {
    id: 'AST-08',
    module: 'AST',
    feature: 'Proposal execution claim lock (multi-instance)',
    passCriteria: 'Parallel execution sweeps claim each approved proposal once; no duplicate side effects',
    expected: 'pass',
  },

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
    expected: 'partial',
    expectedReason: 'Requires AI_PROVIDER_API_KEY + execution worker; classifier may not map the utterance.',
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
    expected: 'partial',
    expectedReason: 'Requires AI_PROVIDER_API_KEY + execution worker.',
  },
  {
    id: 'SCH-03',
    module: 'SCH',
    feature: 'Cancel appointment by voice',
    passCriteria: 'Voice cancel utterance → cancel_appointment proposal → approve → executed; appointment status=canceled',
    expected: 'partial',
    expectedReason: 'No REST cancel; only the voice/AI path emits cancel_appointment. Requires AI + worker.',
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
      "Tenant B token reading Tenant A's customer/job/estimate/invoice returns 403/404; cross-tenant note write blocked; DB without tenant GUC returns 0 rows",
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
    expected: 'partial',
    expectedReason: 'Real-LLM observation; escalation surfaced via session state/side-effects.',
  },
  {
    id: 'VOX-02',
    module: 'VOX',
    feature: 'Spanish / i18n voice response',
    passCriteria: 'A Spanish utterance yields a Spanish-language response (language detection / switch)',
    expected: 'partial',
    expectedReason: 'Real-LLM, soft language assertion; evidence captured for review.',
  },
  {
    id: 'VOX-03',
    module: 'VOX',
    feature: 'DNC suppression of outbound SMS',
    passCriteria: 'A phone on the tenant DNC list receives no SMS dispatch when an estimate is sent to it',
    expected: 'partial',
    expectedReason: 'Needs RW conn to seed DNC + a wired send path; degrades to na if send is unavailable.',
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
];

export function findRow(id: string): MatrixRow | undefined {
  return MATRIX.find((r) => r.id === id);
}
