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
  | 'CUS'
  | 'EST'
  | 'BILL'
  | 'SCH'
  | 'SMS'
  | 'PAY'
  | 'VOICE'
  | 'ISO'
  | 'PORTAL'
  | 'PROP'
  | 'RPT'
  | 'JRN'
  | 'JOB'
  | 'AGR'
  | 'LEAD'
  | 'INV'
  | 'CUST'
  | 'FLAG'
  | 'TIME'
  | 'SET'
  | 'NOTE'
  | 'CAT'
  | 'CONV'
  | 'LEGACY';
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
  // ----- Provisioning -----
  {
    id: 'PROV-01',
    module: 'PROV',
    feature: 'Tenant bootstrap',
    passCriteria:
      'Provision API returns tenantId/environmentId, setup UI shows active workspace, and DB has tenant + default settings rows for tenant_id',
    expected: 'pass',
  },
  {
    id: 'PROV-02',
    module: 'PROV',
    feature: 'Role/permission seed',
    passCriteria:
      'Provision run seeds owner/manager/tech roles, role matrix appears in admin UI, and DB role_permissions rows match seeded policy set',
    expected: 'pass',
  },

  // ----- Customers -----
  {
    id: 'CUS-01',
    module: 'CUS',
    feature: 'Create customer',
    passCriteria:
      'POST create returns customer id, customer detail UI resolves same id, and DB customers row persists canonical name/email/phone fields',
    expected: 'pass',
  },
  {
    id: 'CUS-02',
    module: 'CUS',
    feature: 'Update + dedupe customer',
    passCriteria:
      'PATCH/PUT update returns updated_at advance, UI reflects merged profile, and DB enforces unique dedupe key without duplicate active records',
    expected: 'partial',
  },

  // ----- Estimates variants -----
  {
    id: 'EST-01',
    module: 'EST',
    feature: 'Create draft estimate',
    passCriteria:
      'API create returns estimate id, estimates list UI renders same id/status=draft, and DB estimates row contains identical totals and customer_id',
    expected: 'pass',
  },
  {
    id: 'EST-02',
    module: 'EST',
    feature: 'Variant: option package selection',
    passCriteria:
      'Variant option ids from API persist to estimate options in DB and selected package state is rendered correctly in UI preview/export views',
    expected: 'partial',
  },
  {
    id: 'EST-03',
    module: 'EST',
    feature: 'Variant: tax/discount recalculation',
    passCriteria:
      'Recompute endpoint returns deterministic subtotal/tax/discount/grand_total, UI totals match response, and DB total_cents equals recomputed amount',
    expected: 'pass',
  },

  // ----- Billing journey -----
  {
    id: 'BILL-01',
    module: 'BILL',
    feature: 'Estimate to invoice conversion',
    passCriteria:
      'Conversion creates invoice linked by estimate_id, billing UI shows lifecycle transition, and DB invoice status starts in expected initial state',
    expected: 'pass',
  },
  {
    id: 'BILL-02',
    module: 'BILL',
    feature: 'Issue and deliver invoice',
    passCriteria:
      'Issue/send action records issued timestamp in API payload, UI marks invoice as issued/sent, and DB stores delivery metadata + status transition',
    expected: 'partial',
  },
  {
    id: 'BILL-03',
    module: 'BILL',
    feature: 'Payment application and closeout',
    passCriteria:
      'Payment event marks invoice paid in API/UI, DB amount_paid_cents equals settled amount, and remaining_balance reaches zero with immutable audit row',
    expected: 'partial',
  },

  // ----- Scheduling -----
  {
    id: 'SCH-01',
    module: 'SCH',
    feature: 'Create job from sold work',
    passCriteria:
      'Scheduling API creates job/work order tied to source estimate or invoice, dispatch board UI shows entry, and DB job row stores linkage foreign keys',
    expected: 'pass',
  },
  {
    id: 'SCH-02',
    module: 'SCH',
    feature: 'Reschedule and assignment integrity',
    passCriteria:
      'Reschedule API updates window + assignee, UI calendar repositions once, and DB keeps single current assignment with prior change captured in history',
    expected: 'pass',
  },

  // ----- SMS -----
  {
    id: 'SMS-01',
    module: 'SMS',
    feature: 'Outbound transactional SMS',
    passCriteria:
      'Send endpoint returns provider message id, UI conversation timeline appends outbound event, and DB message log persists status + provider identifiers',
    expected: 'partial',
  },
  {
    id: 'SMS-02',
    module: 'SMS',
    feature: 'Inbound reply threading',
    passCriteria:
      'Inbound webhook attaches reply to correct thread/job in API response, UI thread updates in order, and DB links inbound row by conversation foreign key',
    expected: 'partial',
  },

  // ----- Payments edge -----
  {
    id: 'PAY-01',
    module: 'PAY',
    feature: 'Idempotent webhook handling',
    passCriteria:
      'Duplicate webhook deliveries produce one financial side effect, UI payment activity shows single entry, and DB unique event key prevents duplicates',
    expected: 'partial',
  },
  {
    id: 'PAY-02',
    module: 'PAY',
    feature: 'Failed/partial payment recovery',
    passCriteria:
      'Decline or partial-capture event sets recoverable status via API, UI surfaces retry call-to-action, and DB records failure code with unchanged principal',
    expected: 'partial',
  },

  // ----- Voice extras -----
  {
    id: 'VOICE-01',
    module: 'VOICE',
    feature: 'Call logging sync',
    passCriteria:
      'Voice event ingestion maps call to customer/job context, UI activity feed shows call metadata, and DB call log row stores direction/duration/disposition',
    expected: 'partial',
  },
  {
    id: 'VOICE-02',
    module: 'VOICE',
    feature: 'Voicemail/transcript attachment',
    passCriteria:
      'Transcript or recording URL from provider webhook is retrievable by API, UI renders playback or transcript, and DB stores artifact reference + timestamps',
    expected: 'fail',
  },

  // ----- Isolation -----
  {
    id: 'ISO-01',
    module: 'ISO',
    feature: 'Cross-tenant API denial',
    passCriteria:
      'Tenant B token cannot fetch Tenant A resources (404/403), UI deep-link attempt shows access denied, and DB scoped query returns zero foreign-tenant rows',
    expected: 'pass',
  },
  {
    id: 'ISO-02',
    module: 'ISO',
    feature: 'Cross-tenant background job isolation',
    passCriteria:
      'Async workers process only jobs with matching tenant context, UI audit pages show no bleed-through, and DB job execution log entries remain tenant-pure',
    expected: 'pass',
  },

  // ----- Public portal -----
  {
    id: 'PORTAL-01',
    module: 'PORTAL',
    feature: 'Public estimate/invoice view token access',
    passCriteria:
      'Portal token endpoint resolves document for valid token only, public UI displays sanitized document data, and DB token lookup never exposes internal tenant ids',
    expected: 'partial',
  },
  {
    id: 'PORTAL-02',
    module: 'PORTAL',
    feature: 'Public acceptance/payment intent flow',
    passCriteria:
      'Customer accept/pay action from portal updates API state, internal UI reflects accepted/paid status, and DB writes signed acceptance/payment intent audit rows',
    expected: 'partial',
  },

  // ----- Legacy assumptions (explicitly deprecated) -----
  {
    id: 'LEGACY-ESTINVAST-01',
    module: 'LEGACY',
    feature: 'Legacy EST/INV/AST-only matrix completeness',
    passCriteria:
      'Deprecated: report builder should not use EST/INV/AST-only catalog as completeness baseline for current E2E scope',
    expected: 'na',
    expectedReason: 'Deprecated in favor of multi-domain catalog rows above.',
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

  // ----- Golden end-to-end journey -----
  {
    id: 'JRN-03',
    module: 'JRN',
    feature: 'Golden funnel: intake → lead → convert → job → estimate',
    passCriteria:
      'Public intake creates a lead; convert produces a customer; a location + job are created for it; an estimate persists against the job (totals match) — each leg verified in the DB. Delivery/payment legs are attempted and recorded (partial when Stripe/SendGrid are mock).',
    expected: 'pass',
  },
];

export function findRow(id: string): MatrixRow | undefined {
  return MATRIX.find((r) => r.id === id);
}
