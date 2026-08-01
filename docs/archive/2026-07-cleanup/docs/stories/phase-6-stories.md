# Phase 6 — Dispatch Board + Scheduling

> **27 stories** | Reference: AI Service OS Enhanced Execution PRD

---

## Purpose

Day-of operational layer for dispatchers and technicians.

## Exit Criteria

Dispatchers manage appointments visually; conflicts visible; schedule updates flow through proposals.

## Locked Decisions

| Decision | Choice |
|----------|--------|
| Board model | Appointment-centric day view |
| Multi-appointment | Supported |
| Drag/drop safety | Creates proposal, not direct mutation |
| Availability | Lightweight technician availability only |
| Conflicts | Overlapping active appointments for same tech are blocking |

## Story Summary

| ID | Title | Size | Layer | AI Build | Human Review | Dependencies |
|----|-------|------|-------|----------|--------------|-------------|
| P6-001 | Dispatch board day-view container | S | Dispatch UI | High | Moderate | P1-007, P1-008, P1-016 |
| P6-002 | Appointment card model | S | Dispatch UI | High | Moderate | P1-007, P1-005 |
| P6-003 | Unassigned appointment queue | XS | Dispatch UI | High | Light | P6-001, P6-002 |
| P6-004 | Technician lanes | S | Dispatch UI | High | Light | P6-001, P1-008 |
| P6-005 | Date navigation for day view | XS | Dispatch UI | High | Light | P6-001 |
| P6-006 | Day-scoped dispatch board query | S | API | High | Moderate | P1-007, P1-008, P6-005 |
| P6-007 | Drag-start and drag-target interaction model | S | Dispatch UI | Medium | Moderate | P6-001, P6-002 |
| P6-008 | Convert drag/drop into schedule proposal | S | Dispatch + Proposal | Medium | Heavy | P6-007, P2-001, P2-002 |
| P6-009 | Appointment reassignment proposal type | S | Proposal | High | Moderate | P2-001, P1-007 |
| P6-010 | Appointment reschedule proposal type | S | Proposal | High | Moderate | P2-001, P1-007 |
| P6-011 | Appointment cancellation proposal type | S | Proposal | High | Moderate | P2-001, P1-007 |
| P6-012 | Execution for reassignment proposals | S | Execution | Medium | Heavy | P6-009, P2-010 |
| P6-013 | Execution for reschedule proposals | S | Execution | Medium | Heavy | P6-010, P2-010, P1-007A |
| P6-014 | Execution for cancellation proposals | S | Execution | Medium | Moderate | P6-011, P2-010 |
| P6-015A | Technician working-hours model | S | Availability | High | Moderate | P0-003, P1-008 |
| P6-015B | Technician unavailable-block model | S | Availability | High | Moderate | P6-015A |
| P6-015C | Availability summary in board queries | XS | Availability | High | Light | P6-015A, P6-015B, P6-006 |
| P6-016 | Overlapping-appointment conflict detection | S | Validation | Medium | Heavy | P6-006, P6-015C, P1-007A |
| P6-017 | Availability-block conflict detection | S | Validation | Medium | Moderate | P6-015B, P6-006 |
| P6-018 | Conflict visibility in proposal review | S | Dispatch UI | High | Moderate | P6-016, P2-004 |
| P6-019 | Technician day-of assigned-work view | S | Technician UI | High | Moderate | P1-008, P1-016 |
| P6-020 | Appointment reorder support within lane | S | Dispatch UI | Medium | Moderate | P6-001, P6-007, P6-004 |
| P6-021 | Dispatch board filters | XS | Dispatch UI | High | Light | P6-001 |
| P6-022A | Dispatch metric model | S | Analytics | Medium | Moderate | P6-001 |
| P6-022B | Dispatch analytics event capture | S | Analytics | Medium | Light | P6-022A |
| P6-023 | Stale scheduling proposal invalidation | S | Guardrails | Medium | Moderate | P6-010, P6-012, P6-013 |
| P6-024 | Day-of operational summary strip | XS | Dispatch UI | High | Light | P6-001, P6-006 |

---

## Story Specifications

### P6-001 — Dispatch board day-view container

> **Size:** S | **Layer:** Dispatch UI | **AI Build:** High | **Human Review:** Moderate

**Dependencies:** P1-007, P1-008, P1-016

**Allowed files:** `packages/web/src/pages/dispatch/**, packages/web/src/components/dispatch/**`

**Build prompt:** Build day-view board shell with date context, lanes, queue area, and state handling.

**Review prompt:** Review whether the layout matches real dispatcher mental models.

**Automated checks:**
```bash
npx tsc --noEmit
npm test -- --grep "P6-001"
```

**Required tests:**
- [ ] Happy path test
- [ ] Validation test — invalid input rejected with clear errors

---

### P6-002 — Appointment card model

> **Size:** S | **Layer:** Dispatch UI | **AI Build:** High | **Human Review:** Moderate

**Dependencies:** P1-007, P1-005

**Allowed files:** `packages/web/src/pages/dispatch/**, packages/web/src/components/dispatch/**`

**Build prompt:** Render compact appointment cards with customer, location, job summary, assigned technician, time/arrival window, status, and payment indicator placeholder.

**Review prompt:** Review information density and field priority.

**Automated checks:**
```bash
npx tsc --noEmit
npm test -- --grep "P6-002"
```

**Required tests:**
- [ ] Happy path test
- [ ] Validation test — invalid input rejected with clear errors

---

### P6-003 — Unassigned appointment queue

> **Size:** XS | **Layer:** Dispatch UI | **AI Build:** High | **Human Review:** Light

**Dependencies:** P6-001, P6-002

**Allowed files:** `packages/web/src/pages/dispatch/**, packages/web/src/components/dispatch/**`

**Build prompt:** Render dedicated queue for unassigned appointments.

**Review prompt:** Review visibility of unscheduled work.

**Automated checks:**
```bash
npx tsc --noEmit
npm test -- --grep "P6-003"
```

**Required tests:**
- [ ] Happy path test
- [ ] Validation test — invalid input rejected with clear errors

---

### P6-004 — Technician lanes

> **Size:** S | **Layer:** Dispatch UI | **AI Build:** High | **Human Review:** Light

**Dependencies:** P6-001, P1-008

**Allowed files:** `packages/web/src/pages/dispatch/**, packages/web/src/components/dispatch/**`

**Build prompt:** Render lanes for active technicians and their assigned appointments for the selected day.

**Review prompt:** Review readability and empty-lane behavior.

**Automated checks:**
```bash
npx tsc --noEmit
npm test -- --grep "P6-004"
```

**Required tests:**
- [ ] Happy path test
- [ ] Validation test — invalid input rejected with clear errors

---

### P6-005 — Date navigation for day view

> **Size:** XS | **Layer:** Dispatch UI | **AI Build:** High | **Human Review:** Light

**Dependencies:** P6-001

**Allowed files:** `packages/web/src/pages/dispatch/**, packages/web/src/components/dispatch/**`

**Build prompt:** Add previous day / next day / jump-to-date navigation.

**Review prompt:** Review timezone/day-boundary behavior.

**Automated checks:**
```bash
npx tsc --noEmit
npm test -- --grep "P6-005"
```

**Required tests:**
- [ ] Happy path test
- [ ] Validation test — invalid input rejected with clear errors

---

### P6-006 — Day-scoped dispatch board query

> **Size:** S | **Layer:** API | **AI Build:** High | **Human Review:** Moderate

**Dependencies:** P1-007, P1-008, P6-005

**Allowed files:** `packages/api/src/appointments/**, packages/api/src/dispatch/**`

**Build prompt:** Return unassigned and technician-grouped appointments with lightweight display context for the selected day.

**Review prompt:** Review payload efficiency and timezone scoping.

**Automated checks:**
```bash
npx tsc --noEmit
npm test -- --grep "P6-006"
```

**Required tests:**
- [ ] Happy path test
- [ ] Validation test — invalid input rejected with clear errors

---

### P6-007 — Drag-start and drag-target interaction model

> **Size:** S | **Layer:** Dispatch UI | **AI Build:** Medium | **Human Review:** Moderate

**Dependencies:** P6-001, P6-002

**Allowed files:** `packages/web/src/pages/dispatch/**, packages/web/src/components/dispatch/**`

**Build prompt:** Capture candidate moves from queue to lane or lane to lane without direct mutation.

**Review prompt:** Review interaction safety and accessibility.

**Automated checks:**
```bash
npx tsc --noEmit
npm test -- --grep "P6-007"
```

**Required tests:**
- [ ] Happy path test
- [ ] Validation test — invalid input rejected with clear errors

---

### P6-008 — Convert drag/drop into schedule proposal

> **Size:** S | **Layer:** Dispatch + Proposal | **AI Build:** Medium | **Human Review:** Heavy

**Dependencies:** P6-007, P2-001, P2-002

**Allowed files:** `packages/web/src/components/dispatch/**, packages/api/src/proposals/**`

**Build prompt:** Create schedule update proposals from drag/drop actions with before/after context.

**Review prompt:** Review trust model and payload completeness.

**Automated checks:**
```bash
npx tsc --noEmit
npm test -- --grep "P6-008"
```

**Required tests:**
- [ ] Happy path test
- [ ] Validation test — invalid input rejected with clear errors
- [ ] Invalid transition test
- [ ] Idempotency test

---

### P6-009 — Appointment reassignment proposal type

> **Size:** S | **Layer:** Proposal | **AI Build:** High | **Human Review:** Moderate

**Dependencies:** P2-001, P1-007

**Allowed files:** `packages/api/src/proposals/contracts/**`

**Build prompt:** Define typed reassignment proposal contract.

**Review prompt:** Review completeness and dispatch fit.

**Automated checks:**
```bash
npx tsc --noEmit
npm test -- --grep "P6-009"
```

**Required tests:**
- [ ] Happy path test
- [ ] Validation test — invalid input rejected with clear errors
- [ ] Invalid transition test
- [ ] Idempotency test

---

### P6-010 — Appointment reschedule proposal type

> **Size:** S | **Layer:** Proposal | **AI Build:** High | **Human Review:** Moderate

**Dependencies:** P2-001, P1-007

**Allowed files:** `packages/api/src/proposals/contracts/**`

**Build prompt:** Define typed reschedule proposal contract with schedule and arrival-window fields.

**Review prompt:** Review time-model completeness.

**Automated checks:**
```bash
npx tsc --noEmit
npm test -- --grep "P6-010"
```

**Required tests:**
- [ ] Happy path test
- [ ] Validation test — invalid input rejected with clear errors
- [ ] Invalid transition test
- [ ] Idempotency test

---

### P6-011 — Appointment cancellation proposal type

> **Size:** S | **Layer:** Proposal | **AI Build:** High | **Human Review:** Moderate

**Dependencies:** P2-001, P1-007

**Allowed files:** `packages/api/src/proposals/contracts/**`

**Build prompt:** Define typed cancellation proposal contract.

**Review prompt:** Review reason model and lifecycle alignment.

**Automated checks:**
```bash
npx tsc --noEmit
npm test -- --grep "P6-011"
```

**Required tests:**
- [ ] Happy path test
- [ ] Validation test — invalid input rejected with clear errors
- [ ] Invalid transition test
- [ ] Idempotency test

---

### P6-012 — Execution for reassignment proposals

> **Size:** S | **Layer:** Execution | **AI Build:** Medium | **Human Review:** Heavy

**Dependencies:** P6-009, P2-010

**Allowed files:** `packages/api/src/proposals/execution/**`

**Build prompt:** Apply approved reassignment proposals with idempotency and audit trail.

**Review prompt:** Review stale-context and double-write safety.

**Automated checks:**
```bash
npx tsc --noEmit
npm test -- --grep "P6-012"
```

**Required tests:**
- [ ] Happy path test
- [ ] Validation test — invalid input rejected with clear errors
- [ ] Tenant isolation test — cross-tenant data inaccessible
- [ ] Invalid transition test
- [ ] Idempotency test

---

### P6-013 — Execution for reschedule proposals

> **Size:** S | **Layer:** Execution | **AI Build:** Medium | **Human Review:** Heavy

**Dependencies:** P6-010, P2-010, P1-007A

**Allowed files:** `packages/api/src/proposals/execution/**`

**Build prompt:** Apply approved reschedules with time validation and audit trail.

**Review prompt:** Review whether field mutation matches the scheduling model.

**Automated checks:**
```bash
npx tsc --noEmit
npm test -- --grep "P6-013"
```

**Required tests:**
- [ ] Happy path test
- [ ] Validation test — invalid input rejected with clear errors
- [ ] Tenant isolation test — cross-tenant data inaccessible
- [ ] Invalid transition test
- [ ] Idempotency test

---

### P6-014 — Execution for cancellation proposals

> **Size:** S | **Layer:** Execution | **AI Build:** Medium | **Human Review:** Moderate

**Dependencies:** P6-011, P2-010

**Allowed files:** `packages/api/src/proposals/execution/**`

**Build prompt:** Apply approved cancellations idempotently and update lifecycle state.

**Review prompt:** Review cancellation semantics.

**Automated checks:**
```bash
npx tsc --noEmit
npm test -- --grep "P6-014"
```

**Required tests:**
- [ ] Happy path test
- [ ] Validation test — invalid input rejected with clear errors
- [ ] Tenant isolation test — cross-tenant data inaccessible
- [ ] Invalid transition test
- [ ] Idempotency test

---

### P6-015A — Technician working-hours model

> **Size:** S | **Layer:** Availability | **AI Build:** High | **Human Review:** Moderate

**Dependencies:** P0-003, P1-008

**Allowed files:** `packages/api/src/availability/**`

**Build prompt:** Create day-of-week working-hours settings for technicians.

**Review prompt:** Review scope and simplicity.

**Automated checks:**
```bash
npx tsc --noEmit
npm test -- --grep "P6-015A"
```

**Required tests:**
- [ ] Happy path test
- [ ] Validation test — invalid input rejected with clear errors

---

### P6-015B — Technician unavailable-block model

> **Size:** S | **Layer:** Availability | **AI Build:** High | **Human Review:** Moderate

**Dependencies:** P6-015A

**Allowed files:** `packages/api/src/availability/**`

**Build prompt:** Add manual unavailable blocks for schedule protection.

**Review prompt:** Review overlap handling.

**Automated checks:**
```bash
npx tsc --noEmit
npm test -- --grep "P6-015B"
```

**Required tests:**
- [ ] Happy path test
- [ ] Validation test — invalid input rejected with clear errors

---

### P6-015C — Availability summary in board queries

> **Size:** XS | **Layer:** Availability | **AI Build:** High | **Human Review:** Light

**Dependencies:** P6-015A, P6-015B, P6-006

**Allowed files:** `packages/api/src/availability/**`

**Build prompt:** Expose lightweight availability summary in dispatch board payloads.

**Review prompt:** Review payload usefulness.

**Automated checks:**
```bash
npx tsc --noEmit
npm test -- --grep "P6-015C"
```

**Required tests:**
- [ ] Happy path test
- [ ] Validation test — invalid input rejected with clear errors

---

### P6-016 — Overlapping-appointment conflict detection

> **Size:** S | **Layer:** Validation | **AI Build:** Medium | **Human Review:** Heavy

**Dependencies:** P6-006, P6-015C, P1-007A

**Allowed files:** `packages/api/src/*/validation.**`

**Build prompt:** Block overlapping active appointments for the same technician.

**Review prompt:** Review whether the blocking rule is right for beta.

**Automated checks:**
```bash
npx tsc --noEmit
npm test -- --grep "P6-016"
```

**Required tests:**
- [ ] Happy path test
- [ ] Validation test — invalid input rejected with clear errors

---

### P6-017 — Availability-block conflict detection

> **Size:** S | **Layer:** Validation | **AI Build:** Medium | **Human Review:** Moderate

**Dependencies:** P6-015B, P6-006

**Allowed files:** `packages/api/src/*/validation.**`

**Build prompt:** Detect assignment conflicts against working hours and unavailable blocks.

**Review prompt:** Review strictness and edge cases.

**Automated checks:**
```bash
npx tsc --noEmit
npm test -- --grep "P6-017"
```

**Required tests:**
- [ ] Happy path test
- [ ] Validation test — invalid input rejected with clear errors

---

### P6-018 — Conflict visibility in proposal review

> **Size:** S | **Layer:** Dispatch UI | **AI Build:** High | **Human Review:** Moderate

**Dependencies:** P6-016, P2-004

**Allowed files:** `packages/web/src/pages/dispatch/**, packages/web/src/components/dispatch/**`

**Build prompt:** Surface blocking and warning-level scheduling conflicts in review UI.

**Review prompt:** Review message clarity and decision support.

**Automated checks:**
```bash
npx tsc --noEmit
npm test -- --grep "P6-018"
```

**Required tests:**
- [ ] Happy path test
- [ ] Validation test — invalid input rejected with clear errors

---

### P6-019 — Technician day-of assigned-work view

> **Size:** S | **Layer:** Technician UI | **AI Build:** High | **Human Review:** Moderate

**Dependencies:** P1-008, P1-016

**Allowed files:** `packages/web/src/pages/technician/**`

**Build prompt:** Show only the technician’s assigned appointments for the selected day with customer, location, timing, and status.

**Review prompt:** Review mobile and field usability.

**Automated checks:**
```bash
npx tsc --noEmit
npm test -- --grep "P6-019"
```

**Required tests:**
- [ ] Happy path test
- [ ] Validation test — invalid input rejected with clear errors

---

### P6-020 — Appointment reorder support within lane

> **Size:** S | **Layer:** Dispatch UI | **AI Build:** Medium | **Human Review:** Moderate

**Dependencies:** P6-001, P6-007, P6-004

**Allowed files:** `packages/web/src/pages/dispatch/**, packages/web/src/components/dispatch/**`

**Build prompt:** Allow within-lane reordering through proposal/intention, not direct silent mutation.

**Review prompt:** Review whether it adds real beta value.

**Automated checks:**
```bash
npx tsc --noEmit
npm test -- --grep "P6-020"
```

**Required tests:**
- [ ] Happy path test
- [ ] Validation test — invalid input rejected with clear errors

---

### P6-021 — Dispatch board filters

> **Size:** XS | **Layer:** Dispatch UI | **AI Build:** High | **Human Review:** Light

**Dependencies:** P6-001

**Allowed files:** `packages/web/src/pages/dispatch/**, packages/web/src/components/dispatch/**`

**Build prompt:** Add technician and status filters to day view.

**Review prompt:** Review simplicity and usefulness.

**Automated checks:**
```bash
npx tsc --noEmit
npm test -- --grep "P6-021"
```

**Required tests:**
- [ ] Happy path test
- [ ] Validation test — invalid input rejected with clear errors

---

### P6-022A — Dispatch metric model

> **Size:** S | **Layer:** Analytics | **AI Build:** Medium | **Human Review:** Moderate

**Dependencies:** P6-001

**Allowed files:** `packages/api/src/*/analytics.**`

**Build prompt:** Define metrics for unassigned, reassigned, rescheduled, canceled, and conflict events.

**Review prompt:** Review whether the model gives useful beta insight.

**Automated checks:**
```bash
npx tsc --noEmit
npm test -- --grep "P6-022A"
```

**Required tests:**
- [ ] Happy path test
- [ ] Validation test — invalid input rejected with clear errors

---

### P6-022B — Dispatch analytics event capture

> **Size:** S | **Layer:** Analytics | **AI Build:** Medium | **Human Review:** Light

**Dependencies:** P6-022A

**Allowed files:** `packages/api/src/*/analytics.**`

**Build prompt:** Capture assignment, reassignment, reschedule, cancellation, and conflict events into analytics-ready records.

**Review prompt:** Review completeness.

**Automated checks:**
```bash
npx tsc --noEmit
npm test -- --grep "P6-022B"
```

**Required tests:**
- [ ] Happy path test
- [ ] Validation test — invalid input rejected with clear errors

---

### P6-023 — Stale scheduling proposal invalidation

> **Size:** S | **Layer:** Guardrails | **AI Build:** Medium | **Human Review:** Moderate

**Dependencies:** P6-010, P6-012, P6-013

**Allowed files:** `packages/api/src/ai/guardrails/**`

**Build prompt:** Block execution of scheduling proposals when underlying appointment context changed materially.

**Review prompt:** Review whether invalidation is too aggressive.

**Automated checks:**
```bash
npx tsc --noEmit
npm test -- --grep "P6-023"
```

**Required tests:**
- [ ] Happy path test
- [ ] Validation test — invalid input rejected with clear errors
- [ ] Invalid transition test
- [ ] Idempotency test

---

### P6-024 — Day-of operational summary strip

> **Size:** XS | **Layer:** Dispatch UI | **AI Build:** High | **Human Review:** Light

**Dependencies:** P6-001, P6-006

**Allowed files:** `packages/web/src/pages/dispatch/**, packages/web/src/components/dispatch/**`

**Build prompt:** Show selected-day counts for unassigned, scheduled, in-progress, completed, and canceled appointments.

**Review prompt:** Review whether summary adds useful signal.

**Automated checks:**
```bash
npx tsc --noEmit
npm test -- --grep "P6-024"
```

**Required tests:**
- [ ] Happy path test
- [ ] Validation test — invalid input rejected with clear errors

---
