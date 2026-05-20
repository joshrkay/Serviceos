# Money Loop UI Close-Out — Design

**Date:** 2026-05-20  
**Status:** Approved for implementation (user: "continue")  
**Related:** §6 Time-to-Cash, §3 Approval Inbox (`2026-05-14-serviceos-launch-readiness-design.md`), Workstream D (`2026-05-19-solo-owner-launch-design.md`)

---

## 1. Problem

The money loop **backend is launch-viable** (proposals, billing engine, Stripe pay + webhooks, job `moneyState`, `/api/proposals/inbox`, `/api/reports/money-dashboard`). Owner-facing UI still breaks trust on daily paths:

- **Estimate → invoice** (`ConvertToInvoiceSheet`) simulates success with `setTimeout` — no `POST /api/invoices`.
- **Mark as paid** (`MarkPaidSheet`) simulates success — no `POST /api/payments`.
- **Send flows** use hardcoded `customers` from `mock-data.ts`.
- **Approval inbox** (`/inbox`) is approve/reject only — no review for money proposals.
- **Money dashboard** (`/reports/money`) is routed but not in nav.

Customer pay path (`/pay/:id` → Stripe → webhook) is already strong (Wave B).

---

## 2. Goal

A solo HVAC/plumbing owner can complete the loop without fake UI:

**Approved estimate → invoice → send → customer pays OR owner records cash/check → job money-state updates → money dashboard reflects reality.**

All money mutations that change state remain **proposal-first for AI** (D-004); owner-initiated UI actions call authenticated APIs directly (same as existing estimate/invoice CRUD routes).

---

## 3. Non-goals

- P9/P10 full estimate/invoice agents
- `marketing_message` proposal type
- Dispatch board in solo nav
- Refunds, multi-currency
- Replacing inbox with assistant-only approval (inbox remains primary)

---

## 4. Approach (recommended: Surgical wiring → Inbox review → Nav)

### Phase 1 — Trust the owner loop (P0)

| Change | API | UX |
|--------|-----|-----|
| Wire convert sheet | `POST /api/invoices` with `estimateId`, `jobId`, line items (integer cents) | On success navigate to `/invoices/:id` |
| Wire mark-paid sheet | `POST /api/payments` | Refetch invoice; drop redundant fake `transition` if payment API settles status |
| Real customers on send sheets | `GET /api/customers` or job-enriched customer | Remove `mock-data` imports from estimate/invoice send |

### Phase 2 — Approval inbox for money (P1)

| Change | Detail |
|--------|--------|
| Inbox "Review" | For `draft_estimate`, `draft_invoice`, `issue_invoice`, `record_payment`: open sheet with payload summary (reuse `InvoiceProposalReview` patterns) |
| Deep link | After approve, link to created entity when `executionResult` returns ids |

### Phase 3 — Discoverability (P1)

| Change | Detail |
|--------|--------|
| Nav | Add **Inbox** and **Money** to `supervisor` + `tech` nav (Workstream D) |
| Home | Pending money items deep-link to entity detail |

### Phase 4 — Hardening (P2)

- Playwright: approved estimate → convert UI → invoice exists in DB
- Playwright: mark paid → `amountPaidCents` updates

---

## 5. Data contracts (unchanged)

- Money: integer cents via shared billing engine
- `createInvoiceSchema`: `jobId`, optional `estimateId`, `lineItems[]`
- `recordPaymentSchema`: `invoiceId`, `amountCents`, `method` enum

---

## 6. Risks

| Risk | Mitigation |
|------|------------|
| Missing `jobId` on estimate detail | Pass `est.jobId` into convert sheet; block with clear error if absent |
| Mark paid uses UI-computed total not `amountDueCents` | Use API `amountDueCents` for payment amount |
| Double status update (payment + transition) | Prefer payment API outcome; refetch detail |

---

## 7. Success criteria

- [ ] Convert creates invoice linked via `estimate_id` (matches `e2e/qa-matrix/estimates.spec.ts`)
- [ ] Mark paid persists payment and invoice shows Paid
- [ ] No `setTimeout`-only success paths on convert/mark-paid
- [ ] Inbox + Money visible in owner nav
- [ ] `tsc --project tsconfig.build.json --noEmit` clean in `packages/api`
