# QA Matrix Report

## Run metadata

- Timestamp: 2026-05-14T08:53:56.873Z
- Env: http://localhost:5173 (API: http://localhost:3000)
- Branch: claude/assess-voice-config-a52Li
- Commit: 70487492f436b40eccbf65a9fac269449f7101c3
- Tenants: A=6338b503-441d-4df1-8ee1-53442fc5fda5, B=43c4d4bd-adcf-4ffd-85bd-d72979b00311

## Summary — 7 pass · 7 partial · 7 fail · 0 n/a

| ID | Module | Feature | Verdict | Notes |
|----|--------|---------|---------|-------|
| EST-01 | EST | Create draft estimate | **PASS** |  |
| EST-02 | EST | Validation errors | **PASS** |  |
| EST-03 | EST | Edit draft | **PARTIAL** | Product exposes PUT only. Matrix accepts PATCH or PUT per plan. |
| EST-04 | EST | Estimate total correctness | **PASS** |  |
| EST-05 | EST | Convert estimate to invoice | **PARTIAL** | No dedicated /:id/convert endpoint. POST /api/invoices { estimateId } links correctly. |
| EST-06 | EST | Tenant isolation | **PASS** |  |
| INV-01 | INV | Create invoice | **PASS** |  |
| INV-02 | INV | List/filter invoices | **PASS** |  |
| INV-03 | INV | Send invoice | **PARTIAL** | Matches implementation: status 'open' + issued_at. Matrix 'sent' / sent_at terminology does not match product schema. No email/SMS delivery. |
| INV-04 | INV | Payment link generation | **FAIL** | No payment-link HTTP endpoint responded. StripePaymentLinkProvider is implemented but not mounted on a route. |
| INV-05 | INV | Mark paid via webhook | **FAIL** | Stripe webhook responded 500; invoice status remained 'open'. Stripe webhook route is not mounted and no auto status transition exists. |
| INV-06 | INV | Idempotent payment handling | **PARTIAL** | First=500, second=500, payments rows=0. Webhook route likely not mounted; idempotency logic cannot be exercised end-to-end. |
| INV-07 | INV | Overdue lifecycle | **FAIL** | No 'overdue' status in the invoices schema; no cron/on-read logic to transition past-due invoices. Feature is not implemented. |
| AST-01 | AST | Create customer via assistant intent | **PARTIAL** | Assistant replied about customer creation but no proposal type for create_customer is exposed via /api/assistant/chat. |
| AST-02 | AST | Create estimate via assistant | **PARTIAL** | Assistant replied but no Estimate proposal in response. Recent estimates in DB: 0. This may mean the LLM fallback path is active (no provider creds). |
| AST-03 | AST | Revise estimate via assistant | **PARTIAL** | Assistant replied but no Estimate revision proposal surfaced via /api/assistant/chat. |
| AST-04 | AST | Create/send invoice via assistant | **FAIL** | Assistant did not return an Invoice proposal. |
| AST-05 | AST | Payment status query via assistant | **FAIL** | No payment-status query capability. Intent classifier has no query intents. |
| AST-06 | AST | Failure handling + recovery | **PASS** |  |
| AST-07 | AST | Multi-step orchestration (customer→estimate→invoice) | **FAIL** | Assistant returned a single proposal (type=Customer) but did not chain customer→estimate→invoice. No orchestration support exists. |
| AST-08 | AST | Proposal execution claim lock (multi-instance) | **FAIL** | no manifest (test did not run or crashed) |

## Per-row detail

### EST-01 — Create draft estimate  **PASS**

- **Pass criteria:** Same estimate id appears in API response, UI list, and DB row with status=draft
- Evidence:
  - API: [API POST /api/estimates → 201](artifacts/EST-01/api/01-create.json)
  - DB: [DB 01-row → 1 row(s)](artifacts/EST-01/db/01-row.json)
  - UI: [UI 01-list-before-before](artifacts/EST-01/ui/01-list-before-before.png)
  - UI: [UI 01-list-before-after](artifacts/EST-01/ui/01-list-before-after.png)
  - UI: [UI 01-list-after](artifacts/EST-01/ui/01-list-after.png)

### EST-02 — Validation errors  **PASS**

- **Pass criteria:** Invalid payload returns 400, UI blocks submit, no row persisted
- Note: Validated 400 API rejection; UI-side blocking not scripted.
- Evidence:
  - API: [API POST /api/estimates → 400](artifacts/EST-02/api/02-invalid.json)
  - DB: [DB 02-no-row → 1 row(s)](artifacts/EST-02/db/02-no-row.json)
  - UI: [UI 02-list-before](artifacts/EST-02/ui/02-list-before.png)
  - UI: [UI 02-list-after](artifacts/EST-02/ui/02-list-after.png)

### EST-03 — Edit draft  **PARTIAL**

- **Pass criteria:** PUT updates fields and updated_at, UI reflects new values after refresh
- **Pre-run expectation:** partial — PUT only, no PATCH. Matrix accepts either per plan.
- **Failure reason:** Product exposes PUT only. Matrix accepts PATCH or PUT per plan.
- Evidence:
  - API: [API POST /api/estimates → 201](artifacts/EST-03/api/03-create.json)
  - API: [API PUT /api/estimates/2b25585c-ef34-4b20-b508-39a7cd4e41b9 → 200](artifacts/EST-03/api/03-put.json)
  - DB: [DB 03-row → 1 row(s)](artifacts/EST-03/db/03-row.json)
  - UI: [UI 03-detail-before](artifacts/EST-03/ui/03-detail-before.png)
  - UI: [UI 03-detail-after](artifacts/EST-03/ui/03-detail-after.png)

### EST-04 — Estimate total correctness  **PASS**

- **Pass criteria:** API total, UI total, and DB total_cents all match calculateDocumentTotals()
- Evidence:
  - API: [API POST /api/estimates → 201](artifacts/EST-04/api/04-create.json)
  - DB: [DB 04-row → 1 row(s)](artifacts/EST-04/db/04-row.json)
  - UI: [UI 04-detail-before](artifacts/EST-04/ui/04-detail-before.png)
  - UI: [UI 04-detail-after](artifacts/EST-04/ui/04-detail-after.png)

### EST-05 — Convert estimate to invoice  **PARTIAL**

- **Pass criteria:** POST /api/invoices with estimateId creates invoice linked via estimate_id FK
- **Pre-run expectation:** partial — No dedicated /:id/convert endpoint. Uses POST /api/invoices { estimateId }.
- **Failure reason:** No dedicated /:id/convert endpoint. POST /api/invoices { estimateId } links correctly.
- Evidence:
  - API: [API POST /api/estimates → 201](artifacts/EST-05/api/05-create-estimate.json)
  - API: [API POST /api/estimates/dc9a568a-118c-45ad-b623-5b339bd26c72/transition → 200](artifacts/EST-05/api/05-transition-ready_for_review.json)
  - API: [API POST /api/estimates/dc9a568a-118c-45ad-b623-5b339bd26c72/transition → 200](artifacts/EST-05/api/05-transition-sent.json)
  - API: [API POST /api/estimates/dc9a568a-118c-45ad-b623-5b339bd26c72/transition → 200](artifacts/EST-05/api/05-transition-accepted.json)
  - API: [API POST /api/invoices → 201](artifacts/EST-05/api/05-create-invoice.json)
  - DB: [DB 05-invoice-link → 1 row(s)](artifacts/EST-05/db/05-invoice-link.json)
  - UI: [UI 05-invoice-ui-before](artifacts/EST-05/ui/05-invoice-ui-before.png)
  - UI: [UI 05-invoice-ui-after](artifacts/EST-05/ui/05-invoice-ui-after.png)

### EST-06 — Tenant isolation  **PASS**

- **Pass criteria:** Tenant B GET on Tenant A's estimate returns 404; DB without tenant GUC returns 0 rows
- Evidence:
  - API: [API POST /api/estimates → 201](artifacts/EST-06/api/06-a-create.json)
  - API: [API GET /api/estimates/5f0290d2-b279-4547-9f58-612ea3d9af65 → 404](artifacts/EST-06/api/06-b-read.json)
  - DB: [DB 06-rls-wrong-tenant → 0 row(s)](artifacts/EST-06/db/06-rls-wrong-tenant.json)
  - DB: [DB 06-rls-as-a → 1 row(s)](artifacts/EST-06/db/06-rls-as-a.json)
  - DB: [DB 06-rls-as-b → 0 row(s)](artifacts/EST-06/db/06-rls-as-b.json)
  - UI: [UI 06-b-list-before](artifacts/EST-06/ui/06-b-list-before.png)
  - UI: [UI 06-b-list-after](artifacts/EST-06/ui/06-b-list-after.png)

### INV-01 — Create invoice  **PASS**

- **Pass criteria:** POST /api/invoices returns 201, row exists in DB, UI detail page loads
- Evidence:
  - API: [API POST /api/invoices → 201](artifacts/INV-01/api/01-create.json)
  - DB: [DB 01-row → 1 row(s)](artifacts/INV-01/db/01-row.json)
  - UI: [UI 01-detail-before](artifacts/INV-01/ui/01-detail-before.png)
  - UI: [UI 01-detail-after](artifacts/INV-01/ui/01-detail-after.png)

### INV-02 — List/filter invoices  **PASS**

- **Pass criteria:** GET /api/invoices returns filtered subsets matching UI and DB counts
- **Pre-run expectation:** fail — No GET /api/invoices list endpoint implemented.
- Note: API 200 and DB counts captured. Row flipped to pass — verify UI separately.
- Note: Counts by status: [{"status":"draft","n":24},{"status":"open","n":12}]
- Evidence:
  - API: [API GET /api/invoices?status=draft → 200](artifacts/INV-02/api/02-list.json)
  - DB: [DB 02-db-counts → 2 row(s)](artifacts/INV-02/db/02-db-counts.json)
  - UI: [UI 02-list-ui-before](artifacts/INV-02/ui/02-list-ui-before.png)
  - UI: [UI 02-list-ui-after](artifacts/INV-02/ui/02-list-ui-after.png)

### INV-03 — Send invoice  **PARTIAL**

- **Pass criteria:** Issue endpoint transitions status draft→open, issued_at set, UI shows issued
- **Pre-run expectation:** partial — Schema uses 'open' + issued_at (not 'sent'/sent_at). No email delivery.
- **Failure reason:** Matches implementation: status 'open' + issued_at. Matrix 'sent' / sent_at terminology does not match product schema. No email/SMS delivery.
- Evidence:
  - API: [API POST /api/invoices → 201](artifacts/INV-03/api/03-create.json)
  - API: [API POST /api/invoices/06e4216c-f40e-4a58-a409-54a94515c5de/issue → 200](artifacts/INV-03/api/03-issue.json)
  - DB: [DB 03-row → 1 row(s)](artifacts/INV-03/db/03-row.json)
  - UI: [UI 03-detail-before](artifacts/INV-03/ui/03-detail-before.png)
  - UI: [UI 03-detail-after](artifacts/INV-03/ui/03-detail-after.png)

### INV-04 — Payment link generation  **FAIL**

- **Pass criteria:** HTTP endpoint returns Stripe payment link URL, payment_link_url persisted
- **Pre-run expectation:** fail — StripePaymentLinkProvider exists but is not wired to an HTTP route.
- **Failure reason:** No payment-link HTTP endpoint responded. StripePaymentLinkProvider is implemented but not mounted on a route.
- Evidence:
  - API: [API POST /api/invoices → 201](artifacts/INV-04/api/04-create.json)
  - API: [API POST /api/invoices/5e5e768a-3431-4893-a18d-24e02a0ae132/payment-link → 404](artifacts/INV-04/api/04-post--api-invoices-5e5e768a-3431-4893-a18d-24e02a0ae132-payment-link.json)
  - API: [API GET /api/invoices/5e5e768a-3431-4893-a18d-24e02a0ae132/payment-link → 404](artifacts/INV-04/api/04-get--api-invoices-5e5e768a-3431-4893-a18d-24e02a0ae132-payment-link.json)
  - API: [API POST /api/payments/link → 404](artifacts/INV-04/api/04-post--api-payments-link.json)
  - UI: [UI 04-detail-before](artifacts/INV-04/ui/04-detail-before.png)
  - UI: [UI 04-detail-after](artifacts/INV-04/ui/04-detail-after.png)

### INV-05 — Mark paid via webhook  **FAIL**

- **Pass criteria:** Stripe webhook flips invoice to paid with amount_paid_cents set
- **Pre-run expectation:** fail — Stripe webhook handler exists but is not mounted on a route, no status transition.
- **Failure reason:** Stripe webhook responded 500; invoice status remained 'open'. Stripe webhook route is not mounted and no auto status transition exists.
- Evidence:
  - API: [API POST /api/invoices → 201](artifacts/INV-05/api/05-create.json)
  - API: [API POST /api/invoices/d8d8c85f-1077-4aaa-99fc-b4d9df8b18d7/issue → 200](artifacts/INV-05/api/05-issue.json)
  - API: [API POST /webhooks/stripe → 500](artifacts/INV-05/api/05-webhook.json)
  - DB: [DB 05-row → 1 row(s)](artifacts/INV-05/db/05-row.json)
  - UI: [UI 05-detail-before](artifacts/INV-05/ui/05-detail-before.png)
  - UI: [UI 05-detail-after](artifacts/INV-05/ui/05-detail-after.png)

### INV-06 — Idempotent payment handling  **PARTIAL**

- **Pass criteria:** Second identical webhook is a no-op; only one payment row exists
- **Pre-run expectation:** partial — Idempotency logic exists but relies on in-memory repo and no Stripe route mounted.
- **Failure reason:** First=500, second=500, payments rows=0. Webhook route likely not mounted; idempotency logic cannot be exercised end-to-end.
- Evidence:
  - API: [API POST /api/invoices → 201](artifacts/INV-06/api/06-create.json)
  - API: [API POST /webhooks/stripe → 500](artifacts/INV-06/api/06-webhook-first.json)
  - API: [API POST /webhooks/stripe → 500](artifacts/INV-06/api/06-webhook-second.json)
  - DB: [DB 06-payments → 1 row(s)](artifacts/INV-06/db/06-payments.json)
  - UI: [UI 06-detail-before](artifacts/INV-06/ui/06-detail-before.png)
  - UI: [UI 06-detail-after](artifacts/INV-06/ui/06-detail-after.png)

### INV-07 — Overdue lifecycle  **FAIL**

- **Pass criteria:** Past-due unpaid invoice transitions to 'overdue' status; UI shows aging badge
- **Pre-run expectation:** fail — No 'overdue' enum value, no cron or on-read computation.
- **Failure reason:** No 'overdue' status in the invoices schema; no cron/on-read logic to transition past-due invoices. Feature is not implemented.
- Evidence:
  - API: [API POST /api/invoices → 201](artifacts/INV-07/api/07-create.json)
  - API: [API POST /api/invoices/d7aa9787-0036-4f2b-a15a-fc4eca5df618/transition → 400](artifacts/INV-07/api/07-transition-overdue.json)
  - DB: [DB 07-check-overdue → 0 row(s)](artifacts/INV-07/db/07-check-overdue.json)
  - UI: [UI 07-detail-before](artifacts/INV-07/ui/07-detail-before.png)
  - UI: [UI 07-detail-after](artifacts/INV-07/ui/07-detail-after.png)

### AST-01 — Create customer via assistant intent  **PARTIAL**

- **Pass criteria:** Assistant chat returns create_customer proposal; approval creates row
- **Pre-run expectation:** fail — Intent classifier maps customer-creation utterances to 'unknown'.
- **Failure reason:** Assistant replied about customer creation but no proposal type for create_customer is exposed via /api/assistant/chat.
- Evidence:
  - API: [API POST /api/assistant/chat → 200](artifacts/AST-01/api/01-chat.json)
  - DB: [DB 01-customer-check → 0 row(s)](artifacts/AST-01/db/01-customer-check.json)
  - UI: [UI 01-chat-before](artifacts/AST-01/ui/01-chat-before.png)
  - UI: [UI 01-chat-after](artifacts/AST-01/ui/01-chat-after.png)

### AST-02 — Create estimate via assistant  **PARTIAL**

- **Pass criteria:** Assistant returns draft_estimate proposal; approval persists estimate
- **Failure reason:** Assistant replied but no Estimate proposal in response. Recent estimates in DB: 0. This may mean the LLM fallback path is active (no provider creds).
- Evidence:
  - API: [API POST /api/assistant/chat → 200](artifacts/AST-02/api/02-chat.json)
  - DB: [DB 02-recent-estimates → 0 row(s)](artifacts/AST-02/db/02-recent-estimates.json)
  - UI: [UI 02-chat-before](artifacts/AST-02/ui/02-chat-before.png)
  - UI: [UI 02-chat-after](artifacts/AST-02/ui/02-chat-after.png)

### AST-03 — Revise estimate via assistant  **PARTIAL**

- **Pass criteria:** Assistant returns update_estimate proposal; line items revised in DB
- **Failure reason:** Assistant replied but no Estimate revision proposal surfaced via /api/assistant/chat.
- Evidence:
  - API: [API POST /api/estimates → 201](artifacts/AST-03/api/03-seed.json)
  - API: [API POST /api/assistant/chat → 200](artifacts/AST-03/api/03-chat.json)
  - DB: [DB 03-row → 1 row(s)](artifacts/AST-03/db/03-row.json)
  - UI: [UI 03-detail-before](artifacts/AST-03/ui/03-detail-before.png)
  - UI: [UI 03-detail-after](artifacts/AST-03/ui/03-detail-after.png)

### AST-04 — Create/send invoice via assistant  **FAIL**

- **Pass criteria:** Assistant drafts invoice and triggers send; DB shows issued invoice
- **Pre-run expectation:** partial — Draft works; no send_invoice proposal type yet.
- **Failure reason:** Assistant did not return an Invoice proposal.
- Evidence:
  - API: [API POST /api/assistant/chat → 200](artifacts/AST-04/api/04-chat.json)
  - DB: [DB 04-recent-invoices → 0 row(s)](artifacts/AST-04/db/04-recent-invoices.json)
  - UI: [UI 04-chat-before](artifacts/AST-04/ui/04-chat-before.png)
  - UI: [UI 04-chat-after](artifacts/AST-04/ui/04-chat-after.png)

### AST-05 — Payment status query via assistant  **FAIL**

- **Pass criteria:** Assistant returns factually correct paid/unpaid summary for a customer
- **Pre-run expectation:** fail — No query intents in classifier; read-only proposals not implemented.
- **Failure reason:** No payment-status query capability. Intent classifier has no query intents.
- Evidence:
  - API: [API POST /api/assistant/chat → 200](artifacts/AST-05/api/05-chat.json)
  - DB: [DB 05-unpaid-truth → 34 row(s)](artifacts/AST-05/db/05-unpaid-truth.json)
  - UI: [UI 05-chat-before](artifacts/AST-05/ui/05-chat-before.png)
  - UI: [UI 05-chat-after](artifacts/AST-05/ui/05-chat-after.png)

### AST-06 — Failure handling + recovery  **PASS**

- **Pass criteria:** Invalid assistant input returns clear error, UI shows actionable message, no bad rows
- **Pre-run expectation:** partial — Error path returns fallback message but no retry/clarification UX.
- Note: Invalid request returned clear error and no downstream rows were created.
- Evidence:
  - DB: [DB 06-baseline → 1 row(s)](artifacts/AST-06/db/06-baseline.json)
  - API: [API POST /api/assistant/chat → 400](artifacts/AST-06/api/06-bad-input.json)
  - DB: [DB 06-no-new-rows → 1 row(s)](artifacts/AST-06/db/06-no-new-rows.json)
  - UI: [UI 06-error-before](artifacts/AST-06/ui/06-error-before.png)
  - UI: [UI 06-error-after](artifacts/AST-06/ui/06-error-after.png)

### AST-07 — Multi-step orchestration (customer→estimate→invoice)  **FAIL**

- **Pass criteria:** Single conversation chains three creations linked by FK
- **Pre-run expectation:** fail — No proposal chaining or multi-turn orchestration in codebase.
- **Failure reason:** Assistant returned a single proposal (type=Customer) but did not chain customer→estimate→invoice. No orchestration support exists.
- Evidence:
  - API: [API POST /api/assistant/chat → 200](artifacts/AST-07/api/07-chat.json)
  - DB: [DB 07-chain-check → 0 row(s)](artifacts/AST-07/db/07-chain-check.json)
  - UI: [UI 07-chat-before](artifacts/AST-07/ui/07-chat-before.png)
  - UI: [UI 07-chat-after](artifacts/AST-07/ui/07-chat-after.png)

### AST-08 — Proposal execution claim lock (multi-instance)  **FAIL**

- **Pass criteria:** Parallel execution sweeps claim each approved proposal once; no duplicate side effects
- Evidence: *none captured*

## Backlog (remediation pointers)

- **EST-03** — **PARTIAL** — Product exposes PUT only. Matrix accepts PATCH or PUT per plan.
- **EST-05** — **PARTIAL** — No dedicated /:id/convert endpoint. POST /api/invoices { estimateId } links correctly.
- **INV-03** — **PARTIAL** — Matches implementation: status 'open' + issued_at. Matrix 'sent' / sent_at terminology does not match product schema. No email/SMS delivery.
- **INV-04** — **FAIL** — No payment-link HTTP endpoint responded. StripePaymentLinkProvider is implemented but not mounted on a route.
- **INV-05** — **FAIL** — Stripe webhook responded 500; invoice status remained 'open'. Stripe webhook route is not mounted and no auto status transition exists.
- **INV-06** — **PARTIAL** — First=500, second=500, payments rows=0. Webhook route likely not mounted; idempotency logic cannot be exercised end-to-end.
- **INV-07** — **FAIL** — No 'overdue' status in the invoices schema; no cron/on-read logic to transition past-due invoices. Feature is not implemented.
- **AST-01** — **PARTIAL** — Assistant replied about customer creation but no proposal type for create_customer is exposed via /api/assistant/chat.
- **AST-02** — **PARTIAL** — Assistant replied but no Estimate proposal in response. Recent estimates in DB: 0. This may mean the LLM fallback path is active (no provider creds).
- **AST-03** — **PARTIAL** — Assistant replied but no Estimate revision proposal surfaced via /api/assistant/chat.
- **AST-04** — **FAIL** — Assistant did not return an Invoice proposal.
- **AST-05** — **FAIL** — No payment-status query capability. Intent classifier has no query intents.
- **AST-07** — **FAIL** — Assistant returned a single proposal (type=Customer) but did not chain customer→estimate→invoice. No orchestration support exists.
- **AST-08** — **FAIL** — needs investigation

---
Artifacts root: `artifacts/`