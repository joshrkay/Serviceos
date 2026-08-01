# Phase 7 — Integrations + Beta Hardening

> **18 stories** | Reference: AI Service OS Enhanced Execution PRD

---

## Purpose

Core integrations, support tooling, and reliability for external beta.

## Exit Criteria

Integrations reliable; support teams can diagnose; rollout controlled; degraded modes exist.

## Locked Decisions

| Decision | Choice |
|----------|--------|
| Twilio | Operational SMS first; reminders later |
| Stripe | Payment links only after invoice approval |
| QuickBooks | Manual-trigger one-way invoice sync first |
| Support tooling | Diagnostics-first; no impersonation in beta |
| Rollout | Feature-flagged tenant cohorts |

## Story Summary

| ID | Title | Size | Layer | AI Build | Human Review | Dependencies |
|----|-------|------|-------|----------|--------------|-------------|
| P7-001 | Twilio account connection and config | S | Integration | Medium | Moderate | P0-006, P0-014 |
| P7-002 | Inbound SMS webhook to conversation linkage | S | Integration | Medium | Moderate | P7-001, P0-011 |
| P7-003 | Outbound operational SMS send | S | Integration | Medium | Moderate | P7-001, P0-011 |
| P7-004 | SMS delivery-status updates | S | Integration | Medium | Light | P7-002, P7-003 |
| P7-005 | Stripe payment-link generation service | S | Integration | Medium | Moderate | P5-010A, P5-005 |
| P7-006 | Stripe webhook processing | S | Integration | Medium | Moderate | P0-014, P7-005 |
| P7-007 | QuickBooks connection + sync settings | S | Integration | Medium | Moderate | P0-006 |
| P7-008 | QuickBooks invoice-sync payload contract | S | Integration | High | Moderate | P7-007, P1-011 |
| P7-009 | Manual-trigger invoice sync to QuickBooks | S | Integration | Medium | Heavy | P7-007, P7-008 |
| P7-010 | Retry failed QuickBooks sync and duplicate protection | S | Integration | Medium | Moderate | P7-009, P0-009 |
| P7-011 | Integration health dashboard by tenant | S | Support | High | Moderate | P7-001, P7-005, P7-007 |
| P7-012 | Tenant diagnostics panel | S | Support | High | Moderate | P7-011, P0-008 |
| P7-013 | AI run + proposal lookup for support | S | Support | High | Moderate | P0-015, P2-001, P7-012 |
| P7-014 | Failed webhook and worker-event inspection | S | Support | Medium | Moderate | P0-014, P0-009, P7-012 |
| P7-015 | Tenant-cohort beta feature flags | S | Rollout | High | Light | P0-013, P1-017 |
| P7-016 | Degraded-mode banners and fallback messaging | S | Reliability | Medium | Moderate | P0-013, P0-008, P7-011 |
| P7-017 | Backup/export/recovery foundation | S | Reliability | Medium | Heavy | P0-008, P0-010, P0-011 |
| P7-018 | Beta launch-readiness metrics and checklist | S | Launch | High | Moderate | P2-019, P4-012, P5-015, P6-022A, P7-011 |

---

## Story Specifications

### P7-001 — Twilio account connection and config

> **Size:** S | **Layer:** Integration | **AI Build:** Medium | **Human Review:** Moderate

**Dependencies:** P0-006, P0-014

**Allowed files:** `packages/api/src/integrations/**`

**Build prompt:** Store platform/tenant Twilio configuration and validate connection health.

**Review prompt:** Review secret handling and tenant scoping.

**Automated checks:**
```bash
npx tsc --noEmit
npm test -- --grep "P7-001"
```

**Required tests:**
- [ ] Happy path test
- [ ] Validation test — invalid input rejected with clear errors

---

### P7-002 — Inbound SMS webhook to conversation linkage

> **Size:** S | **Layer:** Integration | **AI Build:** Medium | **Human Review:** Moderate

**Dependencies:** P7-001, P0-011

**Allowed files:** `packages/api/src/integrations/**`

**Build prompt:** Receive inbound SMS, validate webhook, and attach messages to the right conversation/customer context.

**Review prompt:** Review idempotency and message-thread linking.

**Automated checks:**
```bash
npx tsc --noEmit
npm test -- --grep "P7-002"
```

**Required tests:**
- [ ] Happy path test
- [ ] Validation test — invalid input rejected with clear errors

---

### P7-003 — Outbound operational SMS send

> **Size:** S | **Layer:** Integration | **AI Build:** Medium | **Human Review:** Moderate

**Dependencies:** P7-001, P0-011

**Allowed files:** `packages/api/src/integrations/**`

**Build prompt:** Send operational SMS from approved flows and store delivery intent/status placeholder.

**Review prompt:** Review permission safety and content boundaries.

**Automated checks:**
```bash
npx tsc --noEmit
npm test -- --grep "P7-003"
```

**Required tests:**
- [ ] Happy path test
- [ ] Validation test — invalid input rejected with clear errors

---

### P7-004 — SMS delivery-status updates

> **Size:** S | **Layer:** Integration | **AI Build:** Medium | **Human Review:** Light

**Dependencies:** P7-002, P7-003

**Allowed files:** `packages/api/src/integrations/**`

**Build prompt:** Ingest Twilio delivery callbacks and update message state in conversation history.

**Review prompt:** Review whether status transitions are reliable and useful.

**Automated checks:**
```bash
npx tsc --noEmit
npm test -- --grep "P7-004"
```

**Required tests:**
- [ ] Happy path test
- [ ] Validation test — invalid input rejected with clear errors

---

### P7-005 — Stripe payment-link generation service

> **Size:** S | **Layer:** Integration | **AI Build:** Medium | **Human Review:** Moderate

**Dependencies:** P5-010A, P5-005

**Allowed files:** `packages/api/src/integrations/**`

**Build prompt:** Implement payment-link generation service using the approved invoice model and store link metadata.

**Review prompt:** Review idempotency and invoice linkage.

**Automated checks:**
```bash
npx tsc --noEmit
npm test -- --grep "P7-005"
```

**Required tests:**
- [ ] Happy path test
- [ ] Validation test — invalid input rejected with clear errors

---

### P7-006 — Stripe webhook processing

> **Size:** S | **Layer:** Integration | **AI Build:** Medium | **Human Review:** Moderate

**Dependencies:** P0-014, P7-005

**Allowed files:** `packages/api/src/integrations/**`

**Build prompt:** Validate Stripe signatures and convert payment events into payment and invoice-state updates.

**Review prompt:** Review replay safety and processor boundaries.

**Automated checks:**
```bash
npx tsc --noEmit
npm test -- --grep "P7-006"
```

**Required tests:**
- [ ] Happy path test
- [ ] Validation test — invalid input rejected with clear errors

---

### P7-007 — QuickBooks connection + sync settings

> **Size:** S | **Layer:** Integration | **AI Build:** Medium | **Human Review:** Moderate

**Dependencies:** P0-006

**Allowed files:** `packages/api/src/integrations/**`

**Build prompt:** Store QuickBooks connection state and basic invoice-sync settings.

**Review prompt:** Review secrets, status visibility, and tenant safety.

**Automated checks:**
```bash
npx tsc --noEmit
npm test -- --grep "P7-007"
```

**Required tests:**
- [ ] Happy path test
- [ ] Validation test — invalid input rejected with clear errors

---

### P7-008 — QuickBooks invoice-sync payload contract

> **Size:** S | **Layer:** Integration | **AI Build:** High | **Human Review:** Moderate

**Dependencies:** P7-007, P1-011

**Allowed files:** `packages/api/src/integrations/**`

**Build prompt:** Define one-way invoice sync payload contract and field mapping baseline.

**Review prompt:** Review mapping completeness and future compatibility.

**Automated checks:**
```bash
npx tsc --noEmit
npm test -- --grep "P7-008"
```

**Required tests:**
- [ ] Happy path test
- [ ] Validation test — invalid input rejected with clear errors

---

### P7-009 — Manual-trigger invoice sync to QuickBooks

> **Size:** S | **Layer:** Integration | **AI Build:** Medium | **Human Review:** Heavy

**Dependencies:** P7-007, P7-008

**Allowed files:** `packages/api/src/integrations/**`

**Build prompt:** Trigger one-way sync of approved invoices to QuickBooks and record sync result.

**Review prompt:** Review accounting safety and duplicate-sync prevention.

**Automated checks:**
```bash
npx tsc --noEmit
npm test -- --grep "P7-009"
```

**Required tests:**
- [ ] Happy path test
- [ ] Validation test — invalid input rejected with clear errors

---

### P7-010 — Retry failed QuickBooks sync and duplicate protection

> **Size:** S | **Layer:** Integration | **AI Build:** Medium | **Human Review:** Moderate

**Dependencies:** P7-009, P0-009

**Allowed files:** `packages/api/src/integrations/**`

**Build prompt:** Add retry and duplicate-protection behavior for QuickBooks sync jobs.

**Review prompt:** Review idempotency and support visibility.

**Automated checks:**
```bash
npx tsc --noEmit
npm test -- --grep "P7-010"
```

**Required tests:**
- [ ] Happy path test
- [ ] Validation test — invalid input rejected with clear errors

---

### P7-011 — Integration health dashboard by tenant

> **Size:** S | **Layer:** Support | **AI Build:** High | **Human Review:** Moderate

**Dependencies:** P7-001, P7-005, P7-007

**Allowed files:** `packages/web/src/pages/admin/**, packages/api/src/admin/**`

**Build prompt:** Show Twilio, Stripe, and QuickBooks connection and health state by tenant.

**Review prompt:** Review whether the dashboard is actually actionable.

**Automated checks:**
```bash
npx tsc --noEmit
npm test -- --grep "P7-011"
```

**Required tests:**
- [ ] Happy path test
- [ ] Validation test — invalid input rejected with clear errors

---

### P7-012 — Tenant diagnostics panel

> **Size:** S | **Layer:** Support | **AI Build:** High | **Human Review:** Moderate

**Dependencies:** P7-011, P0-008

**Allowed files:** `packages/web/src/pages/admin/**, packages/api/src/admin/**`

**Build prompt:** Create support-facing tenant diagnostics view with feature flags, integration state, recent errors, and key counts.

**Review prompt:** Review least-privilege access and support usefulness.

**Automated checks:**
```bash
npx tsc --noEmit
npm test -- --grep "P7-012"
```

**Required tests:**
- [ ] Happy path test
- [ ] Validation test — invalid input rejected with clear errors

---

### P7-013 — AI run + proposal lookup for support

> **Size:** S | **Layer:** Support | **AI Build:** High | **Human Review:** Moderate

**Dependencies:** P0-015, P2-001, P7-012

**Allowed files:** `packages/web/src/pages/admin/**, packages/api/src/admin/**`

**Build prompt:** Allow support/admin users to inspect AI runs and proposals by tenant and entity.

**Review prompt:** Review privacy boundaries and traceability completeness.

**Automated checks:**
```bash
npx tsc --noEmit
npm test -- --grep "P7-013"
```

**Required tests:**
- [ ] Happy path test
- [ ] Validation test — invalid input rejected with clear errors

---

### P7-014 — Failed webhook and worker-event inspection

> **Size:** S | **Layer:** Support | **AI Build:** Medium | **Human Review:** Moderate

**Dependencies:** P0-014, P0-009, P7-012

**Allowed files:** `packages/web/src/pages/admin/**, packages/api/src/admin/**`

**Build prompt:** Surface failed webhooks and worker jobs with retry state and correlation ids.

**Review prompt:** Review incident usefulness and safety of retry actions.

**Automated checks:**
```bash
npx tsc --noEmit
npm test -- --grep "P7-014"
```

**Required tests:**
- [ ] Happy path test
- [ ] Validation test — invalid input rejected with clear errors

---

### P7-015 — Tenant-cohort beta feature flags

> **Size:** S | **Layer:** Rollout | **AI Build:** High | **Human Review:** Light

**Dependencies:** P0-013, P1-017

**Allowed files:** `packages/api/src/flags/**`

**Build prompt:** Support feature rollout by tenant cohort and internal/external beta segment.

**Review prompt:** Review whether flag model is simple enough to operate.

**Automated checks:**
```bash
npx tsc --noEmit
npm test -- --grep "P7-015"
```

**Required tests:**
- [ ] Happy path test
- [ ] Validation test — invalid input rejected with clear errors

---

### P7-016 — Degraded-mode banners and fallback messaging

> **Size:** S | **Layer:** Reliability | **AI Build:** Medium | **Human Review:** Moderate

**Dependencies:** P0-013, P0-008, P7-011

**Allowed files:** `packages/web/src/components/status/**, packages/api/src/health/**`

**Build prompt:** Show clear banners/fallback states when AI, SMS, payment, or sync features are impaired.

**Review prompt:** Review whether degraded-mode UX preserves trust.

**Automated checks:**
```bash
npx tsc --noEmit
npm test -- --grep "P7-016"
```

**Required tests:**
- [ ] Happy path test
- [ ] Validation test — invalid input rejected with clear errors

---

### P7-017 — Backup/export/recovery foundation

> **Size:** S | **Layer:** Reliability | **AI Build:** Medium | **Human Review:** Heavy

**Dependencies:** P0-008, P0-010, P0-011

**Allowed files:** `packages/web/src/components/status/**, packages/api/src/health/**`

**Build prompt:** Define and implement backup routines, export-ready data access patterns, and recovery checklists for beta.

**Review prompt:** Review operational completeness and restore realism.

**Automated checks:**
```bash
npx tsc --noEmit
npm test -- --grep "P7-017"
```

**Required tests:**
- [ ] Happy path test
- [ ] Validation test — invalid input rejected with clear errors

---

### P7-018 — Beta launch-readiness metrics and checklist

> **Size:** S | **Layer:** Launch | **AI Build:** High | **Human Review:** Moderate

**Dependencies:** P2-019, P4-012, P5-015, P6-022A, P7-011

**Allowed files:** `packages/api/src/admin/**, docs/**`

**Build prompt:** Create beta readiness checklist and reporting hooks for proposal quality, estimate speed, time-to-cash, integration health, and incident rate.

**Review prompt:** Review whether the checklist matches real beta risk.

**Automated checks:**
```bash
npx tsc --noEmit
npm test -- --grep "P7-018"
```

**Required tests:**
- [ ] Happy path test
- [ ] Validation test — invalid input rejected with clear errors

---
