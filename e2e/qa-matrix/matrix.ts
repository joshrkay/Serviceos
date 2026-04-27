/**
 * Static catalog of every matrix row. Specs reference rows by id; the report
 * builder uses this as the canonical list when a row never produced a manifest
 * (e.g., test crashed before writing one).
 *
 * `expected` documents the pre-run prediction from the Phase-1 exploration.
 * It is NOT the pass criterion — actual pass/fail comes from runtime checks.
 */

export type MatrixModule = 'EST' | 'INV' | 'AST';
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
];

export function findRow(id: string): MatrixRow | undefined {
  return MATRIX.find((r) => r.id === id);
}
