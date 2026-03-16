# Phase 1 — Core Business Entities

> **24 stories** | Reference: AI Service OS Enhanced Execution PRD

---

## Purpose

Create the deterministic business entities that the AI layer will read, propose against, and execute safely.

## Exit Criteria

All core entities work end-to-end; estimate provenance and revision hooks exist for future learning.

## Locked Decisions

| Decision | Choice |
|----------|--------|
| Customer model | Customer and service location are separate entities |
| Scheduling | Appointment separate from job; stores scheduled time + arrival window |
| Estimate/invoice | Shared line-item schema; document-level subtotal, discount, tax, total |
| Money | Integer cents everywhere, no floating point |
| Timezone | Store UTC, render in tenant timezone |

## Story Summary

| ID | Title | Size | Layer | AI Build | Human Review | Dependencies |
|----|-------|------|-------|----------|--------------|-------------|
| P1-001 | Customer entity + CRUD | S | Core Entity | High | Moderate | P0-002, P0-004, P0-005, P0-007 |
| P1-002 | Customer communication methods | S | Core Entity | High | Light | P1-001 |
| P1-003 | Service location entity | S | Core Entity | High | Moderate | P1-001 |
| P1-004 | Deterministic duplicate prevention | S | Validation | Medium | Moderate | P1-001, P1-003 |
| P1-005 | Job entity + CRUD | S | Core Entity | High | Moderate | P1-001, P1-003 |
| P1-006 | Job lifecycle and timeline events | S | Workflow | Medium | Moderate | P1-005, P0-007 |
| P1-007 | Appointment entity with schedule + arrival window | S | Scheduling | Medium | Heavy | P1-005 |
| P1-007A | Appointment validation rules | S | Validation | High | Moderate | P1-007 |
| P1-008 | Technician assignment model | S | Scheduling | High | Moderate | P0-003, P1-007 |
| P1-009 | Estimate entity + shared line-item schema | S | Billing | Medium | Heavy | P1-005 |
| P1-009A | Shared line-item validation + calculation engine | S | Billing | Medium | Heavy | P1-009 |
| P1-009B | Estimate provenance metadata | S | Learning | High | Light | P1-009, P0-011, P0-015 |
| P1-009C | Estimate revisions + final approved version | S | Learning | Medium | Moderate | P1-009, P0-017 |
| P1-009D | Structured estimate edit deltas | S | Learning | Medium | Moderate | P1-009C, P0-018 |
| P1-009E | Estimate approval outcomes | S | Learning | High | Moderate | P1-009, P0-007 |
| P1-009F | Estimate learning analytics foundation | S | Learning | Medium | Light | P1-009D, P1-009E |
| P1-010 | Estimate numbering + statuses | S | Billing | High | Moderate | P1-009, P1-017 |
| P1-011 | Invoice entity + balance calculations | S | Billing | Medium | Heavy | P1-005, P1-009 |
| P1-012 | Invoice numbering + due dates + statuses | S | Billing | High | Moderate | P1-011, P1-017 |
| P1-013 | Payment entity + partial payments | S | Billing | Medium | Heavy | P1-011 |
| P1-014 | Conversation linkage to customers and jobs | S | Conversation | High | Light | P0-011, P1-001, P1-005 |
| P1-015 | Internal notes across key entities | S | Usability | High | Light | P1-001, P1-003, P1-005, P1-009, P1-011 |
| P1-016 | Operational list/detail views, filters, and search | S | UI | High | Moderate | P0-003, P1-001, P1-003, P1-005, P1-007, P1-009, P1-011, P1-013 |
| P1-017 | Tenant business settings and numbering preferences | S | Settings | High | Moderate | P0-002 |

---

## Story Specifications

### P1-001 — Customer entity + CRUD

> **Size:** S | **Layer:** Core Entity | **AI Build:** High | **Human Review:** Moderate

**Dependencies:** P0-002, P0-004, P0-005, P0-007

**Allowed files:** `packages/api/src/customers/**`

**Build prompt:** Implement tenant-scoped customer schema, CRUD, archive support, search hooks, and audit events.

**Review prompt:** Review field model, archive semantics, and list/search usability.

**Automated checks:**
```bash
npx tsc --noEmit
npm test -- --grep "P1-001"
```

**Required tests:**
- [ ] Happy path test
- [ ] Validation test — invalid input rejected with clear errors
- [ ] Tenant isolation test — cross-tenant data inaccessible

---

### P1-002 — Customer communication methods

> **Size:** S | **Layer:** Core Entity | **AI Build:** High | **Human Review:** Light

**Dependencies:** P1-001

**Allowed files:** `packages/api/src/customers/**`

**Build prompt:** Add primary/secondary phone, email, preferred channel, consent placeholder, and notes.

**Review prompt:** Review whether the communication model is future-proof but still MVP-simple.

**Automated checks:**
```bash
npx tsc --noEmit
npm test -- --grep "P1-002"
```

**Required tests:**
- [ ] Happy path test
- [ ] Validation test — invalid input rejected with clear errors
- [ ] Tenant isolation test — cross-tenant data inaccessible

---

### P1-003 — Service location entity

> **Size:** S | **Layer:** Core Entity | **AI Build:** High | **Human Review:** Moderate

**Dependencies:** P1-001

**Allowed files:** `packages/api/src/locations/**`

**Build prompt:** Create customer-linked service locations with address fields, access notes, primary/default support, and archive behavior.

**Review prompt:** Review customer-vs-location separation and address shape.

**Automated checks:**
```bash
npx tsc --noEmit
npm test -- --grep "P1-003"
```

**Required tests:**
- [ ] Happy path test
- [ ] Validation test — invalid input rejected with clear errors
- [ ] Tenant isolation test — cross-tenant data inaccessible

---

### P1-004 — Deterministic duplicate prevention

> **Size:** S | **Layer:** Validation | **AI Build:** Medium | **Human Review:** Moderate

**Dependencies:** P1-001, P1-003

**Allowed files:** `packages/api/src/customers/dedup.**, packages/api/src/locations/dedup.**`

**Build prompt:** Warn on likely duplicate customers/locations using normalized phone, email, and address signals; no auto-merge.

**Review prompt:** Review false positives, match strictness, and UX implications.

**Automated checks:**
```bash
npx tsc --noEmit
npm test -- --grep "P1-004"
```

**Required tests:**
- [ ] Happy path test
- [ ] Validation test — invalid input rejected with clear errors

---

### P1-005 — Job entity + CRUD

> **Size:** S | **Layer:** Core Entity | **AI Build:** High | **Human Review:** Moderate

**Dependencies:** P1-001, P1-003

**Allowed files:** `packages/api/src/jobs/**`

**Build prompt:** Create job schema with customer/location linkage, summary/problem fields, status baseline, and audit support.

**Review prompt:** Review whether job semantics match HVAC/plumbing workflows.

**Automated checks:**
```bash
npx tsc --noEmit
npm test -- --grep "P1-005"
```

**Required tests:**
- [ ] Happy path test
- [ ] Validation test — invalid input rejected with clear errors
- [ ] Tenant isolation test — cross-tenant data inaccessible

---

### P1-006 — Job lifecycle and timeline events

> **Size:** S | **Layer:** Workflow | **AI Build:** Medium | **Human Review:** Moderate

**Dependencies:** P1-005, P0-007

**Allowed files:** `packages/api/src/jobs/**`

**Build prompt:** Implement job status transitions, timestamps, and timeline entries.

**Review prompt:** Review transition realism and whether invalid states are blocked clearly.

**Automated checks:**
```bash
npx tsc --noEmit
npm test -- --grep "P1-006"
```

**Required tests:**
- [ ] Happy path test
- [ ] Validation test — invalid input rejected with clear errors

---

### P1-007 — Appointment entity with schedule + arrival window

> **Size:** S | **Layer:** Scheduling | **AI Build:** Medium | **Human Review:** Heavy

**Dependencies:** P1-005

**Allowed files:** `packages/api/src/appointments/**`

**Build prompt:** Create appointment model with scheduled start/end, arrival window start/end, timezone, status, notes, and job linkage.

**Review prompt:** Review time semantics and whether internal vs external time fields are clear.

**Automated checks:**
```bash
npx tsc --noEmit
npm test -- --grep "P1-007"
```

**Required tests:**
- [ ] Happy path test
- [ ] Validation test — invalid input rejected with clear errors
- [ ] Tenant isolation test — cross-tenant data inaccessible

---

### P1-007A — Appointment validation rules

> **Size:** S | **Layer:** Validation | **AI Build:** High | **Human Review:** Moderate

**Dependencies:** P1-007

**Allowed files:** `packages/api/src/appointments/validation.**`

**Build prompt:** Validate mixed time combinations, time ordering, and required scheduling patterns.

**Review prompt:** Review warning-vs-error policy and edge cases.

**Automated checks:**
```bash
npx tsc --noEmit
npm test -- --grep "P1-007A"
```

**Required tests:**
- [ ] Happy path test
- [ ] Validation test — invalid input rejected with clear errors

---

### P1-008 — Technician assignment model

> **Size:** S | **Layer:** Scheduling | **AI Build:** High | **Human Review:** Moderate

**Dependencies:** P0-003, P1-007

**Allowed files:** `packages/api/src/appointments/assignment.**`

**Build prompt:** Use appointment-level assignment as operational truth and optional job-level convenience assignment.

**Review prompt:** Review assignment truth model and technician workload implications.

**Automated checks:**
```bash
npx tsc --noEmit
npm test -- --grep "P1-008"
```

**Required tests:**
- [ ] Happy path test
- [ ] Validation test — invalid input rejected with clear errors
- [ ] Tenant isolation test — cross-tenant data inaccessible

---

### P1-009 — Estimate entity + shared line-item schema

> **Size:** S | **Layer:** Billing | **AI Build:** Medium | **Human Review:** Heavy

**Dependencies:** P1-005

**Allowed files:** `packages/api/src/estimates/**, packages/api/src/invoices/**, packages/api/src/shared/billing-engine.**`

**Build prompt:** Create estimate header, status, shared line items, totals, and job linkage.

**Review prompt:** Review pricing semantics and money-handling correctness.

**Automated checks:**
```bash
npx tsc --noEmit
npm test -- --grep "P1-009"
```

**Required tests:**
- [ ] Happy path test
- [ ] Validation test — invalid input rejected with clear errors
- [ ] Tenant isolation test — cross-tenant data inaccessible
- [ ] Zero amount edge case
- [ ] Rounding boundary test
- [ ] Partial payment arithmetic (if applicable)

---

### P1-009A — Shared line-item validation + calculation engine

> **Size:** S | **Layer:** Billing | **AI Build:** Medium | **Human Review:** Heavy

**Dependencies:** P1-009

**Allowed files:** `packages/api/src/estimates/**, packages/api/src/invoices/**, packages/api/src/shared/billing-engine.**`

**Build prompt:** Implement deterministic subtotal, discount, tax, and total calculation engine for estimates and invoices.

**Review prompt:** Review financial correctness and category fit.

**Automated checks:**
```bash
npx tsc --noEmit
npm test -- --grep "P1-009A"
```

**Required tests:**
- [ ] Happy path test
- [ ] Validation test — invalid input rejected with clear errors
- [ ] Tenant isolation test — cross-tenant data inaccessible
- [ ] Zero amount edge case
- [ ] Rounding boundary test
- [ ] Partial payment arithmetic (if applicable)

---

### P1-009B — Estimate provenance metadata

> **Size:** S | **Layer:** Learning | **AI Build:** High | **Human Review:** Light

**Dependencies:** P1-009, P0-011, P0-015

**Allowed files:** `packages/api/src/estimates/**, packages/api/src/ai/evaluation/**`

**Build prompt:** Store source type, source reference, creator, and conversation linkage for estimates.

**Review prompt:** Review whether source taxonomy is sufficient for later learning.

**Automated checks:**
```bash
npx tsc --noEmit
npm test -- --grep "P1-009B"
```

**Required tests:**
- [ ] Happy path test
- [ ] Validation test — invalid input rejected with clear errors

---

### P1-009C — Estimate revisions + final approved version

> **Size:** S | **Layer:** Learning | **AI Build:** Medium | **Human Review:** Moderate

**Dependencies:** P1-009, P0-017

**Allowed files:** `packages/api/src/estimates/**, packages/api/src/ai/evaluation/**`

**Build prompt:** Link estimates to revision snapshots and mark final approved revision.

**Review prompt:** Review revision semantics and visibility expectations.

**Automated checks:**
```bash
npx tsc --noEmit
npm test -- --grep "P1-009C"
```

**Required tests:**
- [ ] Happy path test
- [ ] Validation test — invalid input rejected with clear errors

---

### P1-009D — Structured estimate edit deltas

> **Size:** S | **Layer:** Learning | **AI Build:** Medium | **Human Review:** Moderate

**Dependencies:** P1-009C, P0-018

**Allowed files:** `packages/api/src/estimates/**, packages/api/src/ai/evaluation/**`

**Build prompt:** Capture line-item adds/removes and changes in wording, quantity, price, category, and order.

**Review prompt:** Review whether the delta taxonomy is useful enough for learning.

**Automated checks:**
```bash
npx tsc --noEmit
npm test -- --grep "P1-009D"
```

**Required tests:**
- [ ] Happy path test
- [ ] Validation test — invalid input rejected with clear errors

---

### P1-009E — Estimate approval outcomes

> **Size:** S | **Layer:** Learning | **AI Build:** High | **Human Review:** Moderate

**Dependencies:** P1-009, P0-007

**Allowed files:** `packages/api/src/estimates/**, packages/api/src/ai/evaluation/**`

**Build prompt:** Store approval status, approved/rejected metadata, rejection reason, and approved_with_edits flag.

**Review prompt:** Review lifecycle semantics and analytics usefulness.

**Automated checks:**
```bash
npx tsc --noEmit
npm test -- --grep "P1-009E"
```

**Required tests:**
- [ ] Happy path test
- [ ] Validation test — invalid input rejected with clear errors

---

### P1-009F — Estimate learning analytics foundation

> **Size:** S | **Layer:** Learning | **AI Build:** Medium | **Human Review:** Light

**Dependencies:** P1-009D, P1-009E

**Allowed files:** `packages/api/src/estimates/**, packages/api/src/ai/evaluation/**`

**Build prompt:** Create analytics-ready structures for approval rate, edit rate, and common correction patterns.

**Review prompt:** Review whether target metrics are actually derivable.

**Automated checks:**
```bash
npx tsc --noEmit
npm test -- --grep "P1-009F"
```

**Required tests:**
- [ ] Happy path test
- [ ] Validation test — invalid input rejected with clear errors

---

### P1-010 — Estimate numbering + statuses

> **Size:** S | **Layer:** Billing | **AI Build:** High | **Human Review:** Moderate

**Dependencies:** P1-009, P1-017

**Allowed files:** `packages/api/src/estimates/**, packages/api/src/invoices/**, packages/api/src/shared/billing-engine.**`

**Build prompt:** Add tenant-scoped numbering and statuses such as draft, ready_for_review, sent, accepted, rejected, expired.

**Review prompt:** Review professionalism and sequence behavior.

**Automated checks:**
```bash
npx tsc --noEmit
npm test -- --grep "P1-010"
```

**Required tests:**
- [ ] Happy path test
- [ ] Validation test — invalid input rejected with clear errors
- [ ] Tenant isolation test — cross-tenant data inaccessible
- [ ] Zero amount edge case
- [ ] Rounding boundary test
- [ ] Partial payment arithmetic (if applicable)

---

### P1-011 — Invoice entity + balance calculations

> **Size:** S | **Layer:** Billing | **AI Build:** Medium | **Human Review:** Heavy

**Dependencies:** P1-005, P1-009

**Allowed files:** `packages/api/src/estimates/**, packages/api/src/invoices/**, packages/api/src/shared/billing-engine.**`

**Build prompt:** Create invoice header, shared line items, amount_paid, amount_due, due date support, and lifecycle scaffold.

**Review prompt:** Review billing trust and separation from estimates.

**Automated checks:**
```bash
npx tsc --noEmit
npm test -- --grep "P1-011"
```

**Required tests:**
- [ ] Happy path test
- [ ] Validation test — invalid input rejected with clear errors
- [ ] Tenant isolation test — cross-tenant data inaccessible
- [ ] Zero amount edge case
- [ ] Rounding boundary test
- [ ] Partial payment arithmetic (if applicable)

---

### P1-012 — Invoice numbering + due dates + statuses

> **Size:** S | **Layer:** Billing | **AI Build:** High | **Human Review:** Moderate

**Dependencies:** P1-011, P1-017

**Allowed files:** `packages/api/src/estimates/**, packages/api/src/invoices/**, packages/api/src/shared/billing-engine.**`

**Build prompt:** Add tenant-scoped numbering, due-date handling, and statuses such as draft, open, partially_paid, paid, void, canceled.

**Review prompt:** Review due-date defaults and state language.

**Automated checks:**
```bash
npx tsc --noEmit
npm test -- --grep "P1-012"
```

**Required tests:**
- [ ] Happy path test
- [ ] Validation test — invalid input rejected with clear errors
- [ ] Tenant isolation test — cross-tenant data inaccessible
- [ ] Zero amount edge case
- [ ] Rounding boundary test
- [ ] Partial payment arithmetic (if applicable)

---

### P1-013 — Payment entity + partial payments

> **Size:** S | **Layer:** Billing | **AI Build:** Medium | **Human Review:** Heavy

**Dependencies:** P1-011

**Allowed files:** `packages/api/src/estimates/**, packages/api/src/invoices/**, packages/api/src/shared/billing-engine.**`

**Build prompt:** Implement payment records linked to invoices with payment method, provider reference, status, and partial-payment support.

**Review prompt:** Review overpayment handling, reconciliation semantics, and payment methods.

**Automated checks:**
```bash
npx tsc --noEmit
npm test -- --grep "P1-013"
```

**Required tests:**
- [ ] Happy path test
- [ ] Validation test — invalid input rejected with clear errors
- [ ] Tenant isolation test — cross-tenant data inaccessible
- [ ] Zero amount edge case
- [ ] Rounding boundary test
- [ ] Partial payment arithmetic (if applicable)

---

### P1-014 — Conversation linkage to customers and jobs

> **Size:** S | **Layer:** Conversation | **AI Build:** High | **Human Review:** Light

**Dependencies:** P0-011, P1-001, P1-005

**Allowed files:** `packages/api/src/conversations/linkage.**`

**Build prompt:** Link conversations to customers/jobs without duplicating message content.

**Review prompt:** Review retrieval usefulness and future estimate linkage.

**Automated checks:**
```bash
npx tsc --noEmit
npm test -- --grep "P1-014"
```

**Required tests:**
- [ ] Happy path test
- [ ] Validation test — invalid input rejected with clear errors

---

### P1-015 — Internal notes across key entities

> **Size:** S | **Layer:** Usability | **AI Build:** High | **Human Review:** Light

**Dependencies:** P1-001, P1-003, P1-005, P1-009, P1-011

**Allowed files:** `packages/api/src/notes/**`

**Build prompt:** Add internal notes for customers, locations, jobs, estimates, and invoices with author/timestamp.

**Review prompt:** Review note visibility rules and distinction from customer-facing messages.

**Automated checks:**
```bash
npx tsc --noEmit
npm test -- --grep "P1-015"
```

**Required tests:**
- [ ] Happy path test
- [ ] Validation test — invalid input rejected with clear errors

---

### P1-016 — Operational list/detail views, filters, and search

> **Size:** S | **Layer:** UI | **AI Build:** High | **Human Review:** Moderate

**Dependencies:** P0-003, P1-001, P1-003, P1-005, P1-007, P1-009, P1-011, P1-013

**Allowed files:** `packages/web/src/pages/**, packages/web/src/components/**, packages/web/src/hooks/**`

**Build prompt:** Create reusable list/detail patterns, deterministic search, and empty/loading/error states for core entities.

**Review prompt:** Review day-to-day usability and whether filters match real workflows.

**Automated checks:**
```bash
npx tsc --noEmit
npm test -- --grep "P1-016"
```

**Required tests:**
- [ ] Happy path test
- [ ] Validation test — invalid input rejected with clear errors

---

### P1-017 — Tenant business settings and numbering preferences

> **Size:** S | **Layer:** Settings | **AI Build:** High | **Human Review:** Moderate

**Dependencies:** P0-002

**Allowed files:** `packages/api/src/settings/**`

**Build prompt:** Create tenant settings for business profile, timezone, prefixes, payment-term placeholder, and terminology preferences.

**Review prompt:** Review settings scope and extensibility.

**Automated checks:**
```bash
npx tsc --noEmit
npm test -- --grep "P1-017"
```

**Required tests:**
- [ ] Happy path test
- [ ] Validation test — invalid input rejected with clear errors

---
