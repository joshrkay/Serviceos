# Phase 5 — Invoice Intelligence + Payments

> **29 stories** | Reference: AI Service OS Enhanced Execution PRD

---

## Purpose

Extend AI from estimates to invoices and payment readiness. Accelerate time to cash.

## Exit Criteria

Invoice drafts generated, reviewed, approved, executed; payment-ready states; time-to-cash measurable.

## Locked Decisions

| Decision | Choice |
|----------|--------|
| Invoice safety | Drafts are reviewable and approval-based |
| Payment link rule | Stripe link generated only after invoice approval |
| Deposits | Treated as partial payments, not separate objects |
| Learning priority | Line items and wording before autonomous pricing |

## Story Summary

| ID | Title | Size | Layer | AI Build | Human Review | Dependencies |
|----|-------|------|-------|----------|--------------|-------------|
| P5-001 | draft_invoice proposal contract | S | Invoice AI | High | Moderate | P1-011, P2-001, P2-002 |
| P5-002A | Invoice context from job/customer/settings | S | Invoice AI | Medium | Moderate | P1-005, P1-011, P1-017 |
| P5-002B | Technician updates + conversation in invoice context | S | Invoice AI | Medium | Moderate | P3-008, P0-011, P0-012 |
| P5-002C | Optional estimate reference in invoice context | XS | Invoice AI | High | Light | P1-009, P1-011 |
| P5-003A | Invoice draft generation from work context | S | Invoice AI | Medium | Heavy | P5-001, P5-002A, P5-002B |
| P5-003B | Invoice proposal schema validation | S | Invoice AI | High | Moderate | P5-003A |
| P5-003C | Persist invoice proposal with AI provenance | XS | Invoice AI | High | Light | P5-003B, P0-015, P2-001 |
| P5-004A | Invoice proposal review detail UI | S | Billing UI | High | Moderate | P5-003C, P2-004 |
| P5-004B | Inline invoice proposal editing | S | Billing UI | Medium | Heavy | P5-004A, P2-005 |
| P5-004C | Invoice proposal approve / reject actions | S | Billing UI | High | Moderate | P5-004A, P2-005 |
| P5-005 | Deterministic invoice proposal execution | S | Execution | Medium | Heavy | P5-001, P2-010, P1-011 |
| P5-006 | Invoice provenance metadata | S | Learning | High | Light | P1-011, P1-009B |
| P5-007 | Invoice revisions + final approved version | S | Learning | Medium | Moderate | P5-006, P0-017 |
| P5-008 | Structured invoice edit deltas | S | Learning | Medium | Moderate | P5-007, P0-018 |
| P5-009 | Invoice approval outcomes | S | Learning | High | Moderate | P5-006, P0-007 |
| P5-010A | Payment-ready invoice metadata | S | Payments | High | Moderate | P1-011 |
| P5-010B | Payment-link generation contract placeholder | S | Payments | High | Moderate | P5-010A |
| P5-010D | Generate Stripe payment link after invoice approval | S | Payments | Medium | Moderate | P5-010A, P5-005 |
| P5-010E | Stripe webhook ingestion | S | Payments | Medium | Moderate | P0-014, P0-009, P5-010D |
| P5-010F | Invoice state updates from Stripe payments | XS | Payments | High | Moderate | P5-010E, P1-013 |
| P5-011A | Payment recording UI on invoice detail | S | Payments UI | High | Moderate | P1-013, P1-016 |
| P5-011B | Automatic invoice-state updates from payments | S | Payments | Medium | Heavy | P5-011A, P1-013, P5-010F |
| P5-011C | Payment audit + timeline events | XS | Payments | High | Light | P5-011B, P0-007 |
| P5-012A | Invoice quality metric model | S | Analytics | Medium | Moderate | P5-009, P5-008 |
| P5-012B | Invoice proposal outcome analytics records | S | Analytics | Medium | Light | P5-012A |
| P5-013A | Time-to-cash event model | S | Analytics | Medium | Moderate | P1-005, P1-011, P1-013 |
| P5-013B | Capture time-to-cash milestones | S | Analytics | Medium | Light | P5-013A |
| P5-014 | Technician update to invoice opportunity signal | S | Invoice AI | Medium | Moderate | P3-008, P5-002A |
| P5-015 | Invoice-acceleration beta benchmark | S | Analytics | High | Moderate | P5-012A, P5-013B |

---

## Story Specifications

### P5-001 — draft_invoice proposal contract

> **Size:** S | **Layer:** Invoice AI | **AI Build:** High | **Human Review:** Moderate

**Dependencies:** P1-011, P2-001, P2-002

**Allowed files:** `packages/api/src/ai/tasks/**, packages/api/src/invoices/**`

**Build prompt:** Create typed invoice draft proposal payload aligned to invoice schema and shared line items.

**Review prompt:** Review billing completeness and future editability.

**Automated checks:**
```bash
npx tsc --noEmit
npm test -- --grep "P5-001"
```

**Required tests:**
- [ ] Happy path test
- [ ] Validation test — invalid input rejected with clear errors
- [ ] Tenant isolation test — cross-tenant data inaccessible
- [ ] Mock provider test
- [ ] Malformed AI output handled gracefully

---

### P5-002A — Invoice context from job/customer/settings

> **Size:** S | **Layer:** Invoice AI | **AI Build:** Medium | **Human Review:** Moderate

**Dependencies:** P1-005, P1-011, P1-017

**Allowed files:** `packages/api/src/ai/tasks/**, packages/api/src/invoices/**`

**Build prompt:** Assemble invoice draft context from job, customer, location, tenant settings, and numbering defaults.

**Review prompt:** Review whether context is complete but not bloated.

**Automated checks:**
```bash
npx tsc --noEmit
npm test -- --grep "P5-002A"
```

**Required tests:**
- [ ] Happy path test
- [ ] Validation test — invalid input rejected with clear errors
- [ ] Tenant isolation test — cross-tenant data inaccessible
- [ ] Mock provider test
- [ ] Malformed AI output handled gracefully

---

### P5-002B — Technician updates + conversation in invoice context

> **Size:** S | **Layer:** Invoice AI | **AI Build:** Medium | **Human Review:** Moderate

**Dependencies:** P3-008, P0-011, P0-012

**Allowed files:** `packages/api/src/ai/tasks/**, packages/api/src/invoices/**`

**Build prompt:** Add technician transcripts and relevant conversation context to invoice draft assembly.

**Review prompt:** Review noise-vs-signal balance.

**Automated checks:**
```bash
npx tsc --noEmit
npm test -- --grep "P5-002B"
```

**Required tests:**
- [ ] Happy path test
- [ ] Validation test — invalid input rejected with clear errors
- [ ] Tenant isolation test — cross-tenant data inaccessible
- [ ] Mock provider test
- [ ] Malformed AI output handled gracefully

---

### P5-002C — Optional estimate reference in invoice context

> **Size:** XS | **Layer:** Invoice AI | **AI Build:** High | **Human Review:** Light

**Dependencies:** P1-009, P1-011

**Allowed files:** `packages/api/src/ai/tasks/**, packages/api/src/invoices/**`

**Build prompt:** Include approved estimate summary when available.

**Review prompt:** Review optionality and billing safety.

**Automated checks:**
```bash
npx tsc --noEmit
npm test -- --grep "P5-002C"
```

**Required tests:**
- [ ] Happy path test
- [ ] Validation test — invalid input rejected with clear errors
- [ ] Tenant isolation test — cross-tenant data inaccessible
- [ ] Mock provider test
- [ ] Malformed AI output handled gracefully

---

### P5-003A — Invoice draft generation from work context

> **Size:** S | **Layer:** Invoice AI | **AI Build:** Medium | **Human Review:** Heavy

**Dependencies:** P5-001, P5-002A, P5-002B

**Allowed files:** `packages/api/src/ai/tasks/**, packages/api/src/invoices/**`

**Build prompt:** Generate draft_invoice proposals from completed-work context.

**Review prompt:** Review output quality expectations and schema fit.

**Automated checks:**
```bash
npx tsc --noEmit
npm test -- --grep "P5-003A"
```

**Required tests:**
- [ ] Happy path test
- [ ] Validation test — invalid input rejected with clear errors
- [ ] Tenant isolation test — cross-tenant data inaccessible
- [ ] Mock provider test
- [ ] Malformed AI output handled gracefully

---

### P5-003B — Invoice proposal schema validation

> **Size:** S | **Layer:** Invoice AI | **AI Build:** High | **Human Review:** Moderate

**Dependencies:** P5-003A

**Allowed files:** `packages/api/src/ai/tasks/**, packages/api/src/invoices/**`

**Build prompt:** Validate or safely reject malformed AI invoice outputs.

**Review prompt:** Review failure handling and repair behavior.

**Automated checks:**
```bash
npx tsc --noEmit
npm test -- --grep "P5-003B"
```

**Required tests:**
- [ ] Happy path test
- [ ] Validation test — invalid input rejected with clear errors
- [ ] Tenant isolation test — cross-tenant data inaccessible
- [ ] Mock provider test
- [ ] Malformed AI output handled gracefully

---

### P5-003C — Persist invoice proposal with AI provenance

> **Size:** XS | **Layer:** Invoice AI | **AI Build:** High | **Human Review:** Light

**Dependencies:** P5-003B, P0-015, P2-001

**Allowed files:** `packages/api/src/ai/tasks/**, packages/api/src/invoices/**`

**Build prompt:** Store invoice draft proposals with ai_run, prompt_version, and source references.

**Review prompt:** Review traceability completeness.

**Automated checks:**
```bash
npx tsc --noEmit
npm test -- --grep "P5-003C"
```

**Required tests:**
- [ ] Happy path test
- [ ] Validation test — invalid input rejected with clear errors
- [ ] Tenant isolation test — cross-tenant data inaccessible
- [ ] Mock provider test
- [ ] Malformed AI output handled gracefully

---

### P5-004A — Invoice proposal review detail UI

> **Size:** S | **Layer:** Billing UI | **AI Build:** High | **Human Review:** Moderate

**Dependencies:** P5-003C, P2-004

**Allowed files:** `packages/web/src/components/invoices/**`

**Build prompt:** Render invoice proposal line items, totals, explanation, and source context for review.

**Review prompt:** Review readability and trust.

**Automated checks:**
```bash
npx tsc --noEmit
npm test -- --grep "P5-004A"
```

**Required tests:**
- [ ] Happy path test
- [ ] Validation test — invalid input rejected with clear errors
- [ ] Zero amount edge case
- [ ] Rounding boundary test
- [ ] Partial payment arithmetic (if applicable)

---

### P5-004B — Inline invoice proposal editing

> **Size:** S | **Layer:** Billing UI | **AI Build:** Medium | **Human Review:** Heavy

**Dependencies:** P5-004A, P2-005

**Allowed files:** `packages/web/src/components/invoices/**`

**Build prompt:** Allow editing line items, quantities, prices, and notes before approval.

**Review prompt:** Review financial correctness and edit capture.

**Automated checks:**
```bash
npx tsc --noEmit
npm test -- --grep "P5-004B"
```

**Required tests:**
- [ ] Happy path test
- [ ] Validation test — invalid input rejected with clear errors
- [ ] Zero amount edge case
- [ ] Rounding boundary test
- [ ] Partial payment arithmetic (if applicable)

---

### P5-004C — Invoice proposal approve / reject actions

> **Size:** S | **Layer:** Billing UI | **AI Build:** High | **Human Review:** Moderate

**Dependencies:** P5-004A, P2-005

**Allowed files:** `packages/web/src/components/invoices/**`

**Build prompt:** Support approval, rejection, and rejection reasons for invoice proposals.

**Review prompt:** Review lifecycle correctness.

**Automated checks:**
```bash
npx tsc --noEmit
npm test -- --grep "P5-004C"
```

**Required tests:**
- [ ] Happy path test
- [ ] Validation test — invalid input rejected with clear errors
- [ ] Zero amount edge case
- [ ] Rounding boundary test
- [ ] Partial payment arithmetic (if applicable)

---

### P5-005 — Deterministic invoice proposal execution

> **Size:** S | **Layer:** Execution | **AI Build:** Medium | **Human Review:** Heavy

**Dependencies:** P5-001, P2-010, P1-011

**Allowed files:** `packages/api/src/proposals/execution/**`

**Build prompt:** Create or update invoices on approved invoice proposals with provenance and revision linkage.

**Review prompt:** Review create-vs-update semantics and idempotency.

**Automated checks:**
```bash
npx tsc --noEmit
npm test -- --grep "P5-005"
```

**Required tests:**
- [ ] Happy path test
- [ ] Validation test — invalid input rejected with clear errors
- [ ] Tenant isolation test — cross-tenant data inaccessible
- [ ] Invalid transition test
- [ ] Idempotency test

---

### P5-006 — Invoice provenance metadata

> **Size:** S | **Layer:** Learning | **AI Build:** High | **Human Review:** Light

**Dependencies:** P1-011, P1-009B

**Allowed files:** `packages/api/src/estimates/**, packages/api/src/ai/evaluation/**`

**Build prompt:** Track whether invoice came from job, estimate, conversation, or manual creation.

**Review prompt:** Review alignment with estimate provenance.

**Automated checks:**
```bash
npx tsc --noEmit
npm test -- --grep "P5-006"
```

**Required tests:**
- [ ] Happy path test
- [ ] Validation test — invalid input rejected with clear errors

---

### P5-007 — Invoice revisions + final approved version

> **Size:** S | **Layer:** Learning | **AI Build:** Medium | **Human Review:** Moderate

**Dependencies:** P5-006, P0-017

**Allowed files:** `packages/api/src/estimates/**, packages/api/src/ai/evaluation/**`

**Build prompt:** Store invoice revisions and final approved revision.

**Review prompt:** Review revision semantics and retrieval.

**Automated checks:**
```bash
npx tsc --noEmit
npm test -- --grep "P5-007"
```

**Required tests:**
- [ ] Happy path test
- [ ] Validation test — invalid input rejected with clear errors

---

### P5-008 — Structured invoice edit deltas

> **Size:** S | **Layer:** Learning | **AI Build:** Medium | **Human Review:** Moderate

**Dependencies:** P5-007, P0-018

**Allowed files:** `packages/api/src/estimates/**, packages/api/src/ai/evaluation/**`

**Build prompt:** Capture invoice draft-to-final diffs for line items and financial fields.

**Review prompt:** Review learning usefulness and false deltas.

**Automated checks:**
```bash
npx tsc --noEmit
npm test -- --grep "P5-008"
```

**Required tests:**
- [ ] Happy path test
- [ ] Validation test — invalid input rejected with clear errors

---

### P5-009 — Invoice approval outcomes

> **Size:** S | **Layer:** Learning | **AI Build:** High | **Human Review:** Moderate

**Dependencies:** P5-006, P0-007

**Allowed files:** `packages/api/src/estimates/**, packages/api/src/ai/evaluation/**`

**Build prompt:** Store approval/rejection metadata and approved_with_edits flag for invoices.

**Review prompt:** Review whether states map cleanly to billing workflow.

**Automated checks:**
```bash
npx tsc --noEmit
npm test -- --grep "P5-009"
```

**Required tests:**
- [ ] Happy path test
- [ ] Validation test — invalid input rejected with clear errors

---

### P5-010A — Payment-ready invoice metadata

> **Size:** S | **Layer:** Payments | **AI Build:** High | **Human Review:** Moderate

**Dependencies:** P1-011

**Allowed files:** `packages/api/src/payments/**, packages/api/src/invoices/**`

**Build prompt:** Add eligible_for_payment_link, payment_link_status, and readiness metadata to invoices.

**Review prompt:** Review future Stripe compatibility.

**Automated checks:**
```bash
npx tsc --noEmit
npm test -- --grep "P5-010A"
```

**Required tests:**
- [ ] Happy path test
- [ ] Validation test — invalid input rejected with clear errors
- [ ] Tenant isolation test — cross-tenant data inaccessible
- [ ] Zero amount edge case
- [ ] Rounding boundary test
- [ ] Partial payment arithmetic (if applicable)

---

### P5-010B — Payment-link generation contract placeholder

> **Size:** S | **Layer:** Payments | **AI Build:** High | **Human Review:** Moderate

**Dependencies:** P5-010A

**Allowed files:** `packages/api/src/payments/**, packages/api/src/invoices/**`

**Build prompt:** Define provider-agnostic contract for payment-link generation.

**Review prompt:** Review processor separation and future flexibility.

**Automated checks:**
```bash
npx tsc --noEmit
npm test -- --grep "P5-010B"
```

**Required tests:**
- [ ] Happy path test
- [ ] Validation test — invalid input rejected with clear errors
- [ ] Tenant isolation test — cross-tenant data inaccessible
- [ ] Zero amount edge case
- [ ] Rounding boundary test
- [ ] Partial payment arithmetic (if applicable)

---

### P5-010D — Generate Stripe payment link after invoice approval

> **Size:** S | **Layer:** Payments | **AI Build:** Medium | **Human Review:** Moderate

**Dependencies:** P5-010A, P5-005

**Allowed files:** `packages/api/src/payments/**, packages/api/src/invoices/**`

**Build prompt:** Generate Stripe payment link only when invoice is approved; store link id/url and timestamps; enforce idempotency.

**Review prompt:** Review duplicate-link prevention and invoice linkage.

**Automated checks:**
```bash
npx tsc --noEmit
npm test -- --grep "P5-010D"
```

**Required tests:**
- [ ] Happy path test
- [ ] Validation test — invalid input rejected with clear errors
- [ ] Tenant isolation test — cross-tenant data inaccessible
- [ ] Zero amount edge case
- [ ] Rounding boundary test
- [ ] Partial payment arithmetic (if applicable)

---

### P5-010E — Stripe webhook ingestion

> **Size:** S | **Layer:** Payments | **AI Build:** Medium | **Human Review:** Moderate

**Dependencies:** P0-014, P0-009, P5-010D

**Allowed files:** `packages/api/src/payments/**, packages/api/src/invoices/**`

**Build prompt:** Validate Stripe signatures and ingest payment events into payment/invoice state updates.

**Review prompt:** Review idempotency and provider boundary handling.

**Automated checks:**
```bash
npx tsc --noEmit
npm test -- --grep "P5-010E"
```

**Required tests:**
- [ ] Happy path test
- [ ] Validation test — invalid input rejected with clear errors
- [ ] Tenant isolation test — cross-tenant data inaccessible
- [ ] Zero amount edge case
- [ ] Rounding boundary test
- [ ] Partial payment arithmetic (if applicable)

---

### P5-010F — Invoice state updates from Stripe payments

> **Size:** XS | **Layer:** Payments | **AI Build:** High | **Human Review:** Moderate

**Dependencies:** P5-010E, P1-013

**Allowed files:** `packages/api/src/payments/**, packages/api/src/invoices/**`

**Build prompt:** Update unpaid / partially_paid / paid state from Stripe-linked payment events.

**Review prompt:** Review partial-payment correctness.

**Automated checks:**
```bash
npx tsc --noEmit
npm test -- --grep "P5-010F"
```

**Required tests:**
- [ ] Happy path test
- [ ] Validation test — invalid input rejected with clear errors
- [ ] Tenant isolation test — cross-tenant data inaccessible
- [ ] Zero amount edge case
- [ ] Rounding boundary test
- [ ] Partial payment arithmetic (if applicable)

---

### P5-011A — Payment recording UI on invoice detail

> **Size:** S | **Layer:** Payments UI | **AI Build:** High | **Human Review:** Moderate

**Dependencies:** P1-013, P1-016

**Allowed files:** `packages/web/src/components/payments/**`

**Build prompt:** Allow manual recording of full or partial payments from invoice screens.

**Review prompt:** Review usability and overpayment edge cases.

**Automated checks:**
```bash
npx tsc --noEmit
npm test -- --grep "P5-011A"
```

**Required tests:**
- [ ] Happy path test
- [ ] Validation test — invalid input rejected with clear errors

---

### P5-011B — Automatic invoice-state updates from payments

> **Size:** S | **Layer:** Payments | **AI Build:** Medium | **Human Review:** Heavy

**Dependencies:** P5-011A, P1-013, P5-010F

**Allowed files:** `packages/api/src/payments/**, packages/api/src/invoices/**`

**Build prompt:** Update invoice states from manual or Stripe-linked payments.

**Review prompt:** Review reconciliation rules and invalid edge cases.

**Automated checks:**
```bash
npx tsc --noEmit
npm test -- --grep "P5-011B"
```

**Required tests:**
- [ ] Happy path test
- [ ] Validation test — invalid input rejected with clear errors
- [ ] Tenant isolation test — cross-tenant data inaccessible
- [ ] Zero amount edge case
- [ ] Rounding boundary test
- [ ] Partial payment arithmetic (if applicable)

---

### P5-011C — Payment audit + timeline events

> **Size:** XS | **Layer:** Payments | **AI Build:** High | **Human Review:** Light

**Dependencies:** P5-011B, P0-007

**Allowed files:** `packages/api/src/payments/**, packages/api/src/invoices/**`

**Build prompt:** Emit audit/timeline events for payment actions and invoice-state changes.

**Review prompt:** Review traceability coverage.

**Automated checks:**
```bash
npx tsc --noEmit
npm test -- --grep "P5-011C"
```

**Required tests:**
- [ ] Happy path test
- [ ] Validation test — invalid input rejected with clear errors
- [ ] Tenant isolation test — cross-tenant data inaccessible
- [ ] Zero amount edge case
- [ ] Rounding boundary test
- [ ] Partial payment arithmetic (if applicable)

---

### P5-012A — Invoice quality metric model

> **Size:** S | **Layer:** Analytics | **AI Build:** Medium | **Human Review:** Moderate

**Dependencies:** P5-009, P5-008

**Allowed files:** `packages/api/src/*/analytics.**`

**Build prompt:** Define invoice quality metrics such as approval rate, edit burden, and common corrections.

**Review prompt:** Review whether metrics matter to product decisions.

**Automated checks:**
```bash
npx tsc --noEmit
npm test -- --grep "P5-012A"
```

**Required tests:**
- [ ] Happy path test
- [ ] Validation test — invalid input rejected with clear errors

---

### P5-012B — Invoice proposal outcome analytics records

> **Size:** S | **Layer:** Analytics | **AI Build:** Medium | **Human Review:** Light

**Dependencies:** P5-012A

**Allowed files:** `packages/api/src/*/analytics.**`

**Build prompt:** Capture invoice proposal outcomes and edit signals into analytics-ready records.

**Review prompt:** Review queryability and completeness.

**Automated checks:**
```bash
npx tsc --noEmit
npm test -- --grep "P5-012B"
```

**Required tests:**
- [ ] Happy path test
- [ ] Validation test — invalid input rejected with clear errors

---

### P5-013A — Time-to-cash event model

> **Size:** S | **Layer:** Analytics | **AI Build:** Medium | **Human Review:** Moderate

**Dependencies:** P1-005, P1-011, P1-013

**Allowed files:** `packages/api/src/*/analytics.**`

**Build prompt:** Define milestone events from job completion to invoice draft, approval, payment-ready, and payment recorded.

**Review prompt:** Review whether milestones tell the right ROI story.

**Automated checks:**
```bash
npx tsc --noEmit
npm test -- --grep "P5-013A"
```

**Required tests:**
- [ ] Happy path test
- [ ] Validation test — invalid input rejected with clear errors

---

### P5-013B — Capture time-to-cash milestones

> **Size:** S | **Layer:** Analytics | **AI Build:** Medium | **Human Review:** Light

**Dependencies:** P5-013A

**Allowed files:** `packages/api/src/*/analytics.**`

**Build prompt:** Record milestone timestamps from job, invoice, and payment flows.

**Review prompt:** Review completeness and timestamp integrity.

**Automated checks:**
```bash
npx tsc --noEmit
npm test -- --grep "P5-013B"
```

**Required tests:**
- [ ] Happy path test
- [ ] Validation test — invalid input rejected with clear errors

---

### P5-014 — Technician update to invoice opportunity signal

> **Size:** S | **Layer:** Invoice AI | **AI Build:** Medium | **Human Review:** Moderate

**Dependencies:** P3-008, P5-002A

**Allowed files:** `packages/api/src/ai/tasks/**, packages/api/src/invoices/**`

**Build prompt:** Detect when completed-work context should trigger invoice-drafting opportunity.

**Review prompt:** Review false positives and workflow fit.

**Automated checks:**
```bash
npx tsc --noEmit
npm test -- --grep "P5-014"
```

**Required tests:**
- [ ] Happy path test
- [ ] Validation test — invalid input rejected with clear errors
- [ ] Tenant isolation test — cross-tenant data inaccessible
- [ ] Mock provider test
- [ ] Malformed AI output handled gracefully

---

### P5-015 — Invoice-acceleration beta benchmark

> **Size:** S | **Layer:** Analytics | **AI Build:** High | **Human Review:** Moderate

**Dependencies:** P5-012A, P5-013B

**Allowed files:** `packages/api/src/*/analytics.**`

**Build prompt:** Define manual-vs-AI-assisted invoice benchmark and time-to-cash improvement targets.

**Review prompt:** Review whether benchmark reflects customer-perceived value.

**Automated checks:**
```bash
npx tsc --noEmit
npm test -- --grep "P5-015"
```

**Required tests:**
- [ ] Happy path test
- [ ] Validation test — invalid input rejected with clear errors

---
