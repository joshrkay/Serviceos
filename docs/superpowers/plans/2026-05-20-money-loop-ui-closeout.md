# Money Loop UI Close-Out Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire owner-facing estimate→invoice and mark-paid flows to real APIs, improve inbox/nav discoverability, and add regression tests so the money loop matches §6/§3 launch spec.

**Architecture:** Surgical changes to existing `packages/web` sheets and pages; reuse `apiFetch` / `useApiClient` patterns from `pages/invoices/InvoiceDetail.tsx`. No new API routes unless inbox review needs `GET /api/proposals/:id` (already exists).

**Tech Stack:** React, TypeScript, Vitest, Playwright, Express API (existing contracts)

**Spec:** `docs/superpowers/specs/2026-05-20-money-loop-ui-closeout-design.md`

---

## File map

| File | Responsibility |
|------|----------------|
| `packages/web/src/components/estimates/ConvertToInvoiceSheet.tsx` | POST invoice from estimate |
| `packages/web/src/components/estimates/EstimatesPage.tsx` | Pass `jobId`, API line items; remove mock calc import |
| `packages/web/src/components/invoices/InvoicesPage.tsx` | Wire `MarkPaidSheet`; fix send customer source |
| `packages/web/src/components/inbox/InboxPage.tsx` | Review sheet for money proposal types |
| `packages/web/src/components/layout/Shell.tsx` | Nav: Inbox + Money |
| `packages/web/src/lib/lineItems.ts` (new) | Shared UI→API line item mapper (cents) |

---

## Phase 1 — Wire owner money actions

### Task 1: Shared line-item mapper

**Files:**
- Create: `packages/web/src/lib/lineItems.ts`
- Test: `packages/web/src/lib/lineItems.test.ts`

- [ ] **Step 1:** Add `uiLineItemsToApiPayload(lines)` returning `createInvoiceSchema`-compatible items with `id`, `sortOrder`, `category`, integer cents totals
- [ ] **Step 2:** Unit test quantity × unitPriceCents = totalCents
- [ ] **Step 3:** Commit `feat(web): shared UI line items to API cents payload`

### Task 2: Convert estimate → invoice

**Files:**
- Modify: `packages/web/src/components/estimates/ConvertToInvoiceSheet.tsx`
- Modify: `packages/web/src/components/estimates/EstimatesPage.tsx` (~827–1054)

- [ ] **Step 1:** Replace `setTimeout` with `apiFetch('POST', '/api/invoices', { jobId, estimateId, lineItems, discountCents, taxRateBps })`
- [ ] **Step 2:** Require `jobId`; show error state if missing
- [ ] **Step 3:** On 201, `navigate(/invoices/${id})` via callback prop
- [ ] **Step 4:** Add Vitest with mocked `apiFetch` asserting POST body shape
- [ ] **Step 5:** Commit `feat(web): wire estimate to invoice conversion to API`

### Task 3: Mark invoice as paid

**Files:**
- Modify: `packages/web/src/components/invoices/InvoicesPage.tsx` (`MarkPaidSheet`, detail `onPaid`)

- [ ] **Step 1:** POST `/api/payments` with `amountCents: inv.amountDueCents`, mapped method enum
- [ ] **Step 2:** On success call `refetch()` instead of only `transitionInvoice({ status: 'paid' })`
- [ ] **Step 3:** Vitest mock fetch for mark-paid handler
- [ ] **Step 4:** Commit `feat(web): wire mark-as-paid to payments API`

### Task 4: Remove mock customers from send sheets

**Files:**
- Modify: `packages/web/src/components/estimates/EstimatesPage.tsx` (`SendEstimateSheet`)
- Modify: `packages/web/src/components/invoices/InvoicesPage.tsx` (`SendPaymentSheet`)

- [ ] **Step 1:** Use customer phone/email from API estimate/invoice or enriched job customer
- [ ] **Step 2:** Delete `import { customers } from mock-data` where unused
- [ ] **Step 3:** Commit `fix(web): use API customer contact on money send sheets`

---

## Phase 2 — Inbox review for money proposals

### Task 5: Inbox review sheet

**Files:**
- Create: `packages/web/src/components/inbox/InboxProposalReviewSheet.tsx`
- Modify: `packages/web/src/components/inbox/InboxPage.tsx`
- Reuse: `packages/web/src/components/invoices/InvoiceProposalReview.tsx`

- [ ] **Step 1:** Fetch `GET /api/proposals/:id` on Review click
- [ ] **Step 2:** Render type-specific summary for `draft_invoice`, `issue_invoice`, `record_payment`, `draft_estimate` (line items + totals in cents)
- [ ] **Step 3:** Approve/reject from sheet; refresh inbox list
- [ ] **Step 4:** Commit `feat(web): inbox review sheet for money proposals`

---

## Phase 3 — Nav and home links

### Task 6: Shell navigation

**Files:**
- Modify: `packages/web/src/components/layout/Shell.tsx`

- [ ] **Step 1:** Add `{ to: '/inbox', label: 'Inbox', icon: Bell }` and `{ to: '/reports/money', label: 'Money', icon: TrendingUp }` to `supervisor` and `tech` nav arrays
- [ ] **Step 2:** Commit `feat(web): expose inbox and money dashboard in nav`

### Task 7: Home deep links (optional same PR)

**Files:**
- Modify: `packages/web/src/components/home/HomePage.tsx`

- [ ] **Step 1:** Link pending estimate/invoice cards to `/estimates/:id` and `/invoices/:id`
- [ ] **Step 2:** Commit `feat(web): home deep links to money entities`

---

## Phase 4 — Verification

### Task 8: API build gate

- [ ] **Step 1:** Run `cd packages/api && npx tsc --project tsconfig.build.json --noEmit`
- [ ] **Step 2:** Run web unit tests for touched files

### Task 9: E2E (follow-up PR acceptable)

**Files:**
- Modify or create under `e2e/journeys/`

- [ ] **Step 1:** Journey: create estimate → approve → convert via UI → invoice list shows link
- [ ] **Step 2:** Journey: mark paid via UI → status paid

---

## Dispatch order

```text
Phase 1 (Tasks 1–4) → ship first PR
Phase 2 (Task 5)     → second PR or same if small
Phase 3 (Tasks 6–7)  → can merge with Phase 1
Phase 4 (Tasks 8–9)  → before launch flag
```

Pre-requisites for production: P0-023 (Pg repos), P0-033 (Clerk) per `wave-b-money-loop.md`.
