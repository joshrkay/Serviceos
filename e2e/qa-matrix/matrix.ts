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
];

export function findRow(id: string): MatrixRow | undefined {
  return MATRIX.find((r) => r.id === id);
}
