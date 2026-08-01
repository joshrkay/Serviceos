# Phase 3 — Conversation + Voice Experience

> **15 stories** | Reference: AI Service OS Enhanced Execution PRD

---

## Purpose

Turn the proposal system into a day-to-day conversational product.

## Exit Criteria

Users work conversationally with transcripts, inline proposals, clarifications, linked context, and role-aware views.

## Locked Decisions

| Decision | Choice |
|----------|--------|
| Channels | In-app voice + in-app conversation primary; SMS is linked context |
| Transcript editing | Supported for internal users |
| Proposal rendering | Inline in conversation required |
| Technician scope | Voice updates + assigned work; cannot approve financial proposals |
| Generation trigger | Automatic or user-triggered depending on workflow |

## Story Summary

| ID | Title | Size | Layer | AI Build | Human Review | Dependencies |
|----|-------|------|-------|----------|--------------|-------------|
| P3-001 | Core conversation thread UI | S | Conversation UI | High | Moderate | P0-011, P2-022, P1-016 |
| P3-002 | Voice capture UI | S | Voice UI | Medium | Moderate | P0-012 |
| P3-003 | Transcript rendering and status | S | Voice UI | High | Moderate | P0-011, P0-012, P3-001 |
| P3-004 | Transcript review and correction | S | Voice UI | Medium | Moderate | P3-003, P0-017 |
| P3-005 | Clarification rendering and response flow | S | Conversation UI | Medium | Moderate | P2-014, P3-001 |
| P3-006 | Inline proposal rendering with quick actions | S | Conversation UI | High | Moderate | P2-004, P2-005, P3-001 |
| P3-007 | Conversation-side context panel | S | Context UI | High | Moderate | P1-014, P1-016, P3-001 |
| P3-008 | Technician voice update workflow | S | Technician UX | Medium | Heavy | P1-008, P3-002, P2-016 |
| P3-009 | Dispatcher conversational intake workflow | S | Dispatcher UX | Medium | Heavy | P2-016, P2-005, P3-001, P3-002 |
| P3-010 | Proposal trigger modes by workflow type | S | Orchestration UX | Medium | Moderate | P2-007, P3-002, P3-008, P3-009 |
| P3-011 | Conversation state and retry handling | S | Reliability | High | Moderate | P3-001, P3-003, P2-016 |
| P3-012 | Conversation search and recent threads | S | Conversation UI | High | Light | P0-011, P1-014, P1-016 |
| P3-013 | Mobile-friendly technician interactions | S | Technician UX | High | Moderate | P3-008, P1-016 |
| P3-014 | Conversation-to-estimate linkage | S | Learning | Medium | Moderate | P1-009B, P1-009C, P2-016, P3-001 |
| P3-015 | Conversation permissions and visibility rules | S | Security | Medium | Moderate | P0-003, P3-001, P3-007 |

---

## Story Specifications

### P3-001 — Core conversation thread UI

> **Size:** S | **Layer:** Conversation UI | **AI Build:** High | **Human Review:** Moderate

**Dependencies:** P0-011, P2-022, P1-016

**Allowed files:** `packages/web/src/pages/conversations/**, packages/web/src/components/conversations/**`

**Build prompt:** Render chronological messages, transcripts, system events, clarification prompts, and inline proposal cards.

**Review prompt:** Review scanability and role-aware access.

**Automated checks:**
```bash
npx tsc --noEmit
npm test -- --grep "P3-001"
```

**Required tests:**
- [ ] Happy path test
- [ ] Validation test — invalid input rejected with clear errors

---

### P3-002 — Voice capture UI

> **Size:** S | **Layer:** Voice UI | **AI Build:** Medium | **Human Review:** Moderate

**Dependencies:** P0-012

**Allowed files:** `packages/web/src/components/voice/**`

**Build prompt:** Build record / stop / cancel / re-record interactions with upload/transcribing state.

**Review prompt:** Review friction and mobile practicality.

**Automated checks:**
```bash
npx tsc --noEmit
npm test -- --grep "P3-002"
```

**Required tests:**
- [ ] Happy path test
- [ ] Validation test — invalid input rejected with clear errors

---

### P3-003 — Transcript rendering and status

> **Size:** S | **Layer:** Voice UI | **AI Build:** High | **Human Review:** Moderate

**Dependencies:** P0-011, P0-012, P3-001

**Allowed files:** `packages/web/src/components/voice/**`

**Build prompt:** Render transcript messages and states such as processing, completed, and failed with retry hooks.

**Review prompt:** Review whether status language is clear.

**Automated checks:**
```bash
npx tsc --noEmit
npm test -- --grep "P3-003"
```

**Required tests:**
- [ ] Happy path test
- [ ] Validation test — invalid input rejected with clear errors

---

### P3-004 — Transcript review and correction

> **Size:** S | **Layer:** Voice UI | **AI Build:** Medium | **Human Review:** Moderate

**Dependencies:** P3-003, P0-017

**Allowed files:** `packages/web/src/components/voice/**`

**Build prompt:** Allow internal users to edit transcripts while preserving original text and attribution.

**Review prompt:** Review auditability and downstream use of corrected transcript.

**Automated checks:**
```bash
npx tsc --noEmit
npm test -- --grep "P3-004"
```

**Required tests:**
- [ ] Happy path test
- [ ] Validation test — invalid input rejected with clear errors

---

### P3-005 — Clarification rendering and response flow

> **Size:** S | **Layer:** Conversation UI | **AI Build:** Medium | **Human Review:** Moderate

**Dependencies:** P2-014, P3-001

**Allowed files:** `packages/web/src/pages/conversations/**, packages/web/src/components/conversations/**`

**Build prompt:** Show clarification cards in-thread and tie replies back to task regeneration.

**Review prompt:** Review whether the interaction feels conversational.

**Automated checks:**
```bash
npx tsc --noEmit
npm test -- --grep "P3-005"
```

**Required tests:**
- [ ] Happy path test
- [ ] Validation test — invalid input rejected with clear errors

---

### P3-006 — Inline proposal rendering with quick actions

> **Size:** S | **Layer:** Conversation UI | **AI Build:** High | **Human Review:** Moderate

**Dependencies:** P2-004, P2-005, P3-001

**Allowed files:** `packages/web/src/pages/conversations/**, packages/web/src/components/conversations/**`

**Build prompt:** Render proposal summary, status, approve/reject, and open-detail actions inline.

**Review prompt:** Review whether quick actions are too risky or just right.

**Automated checks:**
```bash
npx tsc --noEmit
npm test -- --grep "P3-006"
```

**Required tests:**
- [ ] Happy path test
- [ ] Validation test — invalid input rejected with clear errors

---

### P3-007 — Conversation-side context panel

> **Size:** S | **Layer:** Context UI | **AI Build:** High | **Human Review:** Moderate

**Dependencies:** P1-014, P1-016, P3-001

**Allowed files:** `packages/web/src/components/conversations/context-panel.**`

**Build prompt:** Show linked customer, location, job, appointment, and estimate context alongside the thread.

**Review prompt:** Review information density and usefulness.

**Automated checks:**
```bash
npx tsc --noEmit
npm test -- --grep "P3-007"
```

**Required tests:**
- [ ] Happy path test
- [ ] Validation test — invalid input rejected with clear errors

---

### P3-008 — Technician voice update workflow

> **Size:** S | **Layer:** Technician UX | **AI Build:** Medium | **Human Review:** Heavy

**Dependencies:** P1-008, P3-002, P2-016

**Allowed files:** `packages/web/src/pages/technician/**`

**Build prompt:** From assigned-work context, capture voice update, transcript it, and trigger proposal generation tied to the job/appointment.

**Review prompt:** Review whether the field flow is minimal enough.

**Automated checks:**
```bash
npx tsc --noEmit
npm test -- --grep "P3-008"
```

**Required tests:**
- [ ] Happy path test
- [ ] Validation test — invalid input rejected with clear errors

---

### P3-009 — Dispatcher conversational intake workflow

> **Size:** S | **Layer:** Dispatcher UX | **AI Build:** Medium | **Human Review:** Heavy

**Dependencies:** P2-016, P2-005, P3-001, P3-002

**Allowed files:** `packages/web/src/pages/dispatcher/**`

**Build prompt:** Allow voice/text intake that produces create_customer / create_job / create_appointment proposals in-thread.

**Review prompt:** Review whether the intake flow is understandable and low-friction.

**Automated checks:**
```bash
npx tsc --noEmit
npm test -- --grep "P3-009"
```

**Required tests:**
- [ ] Happy path test
- [ ] Validation test — invalid input rejected with clear errors

---

### P3-010 — Proposal trigger modes by workflow type

> **Size:** S | **Layer:** Orchestration UX | **AI Build:** Medium | **Human Review:** Moderate

**Dependencies:** P2-007, P3-002, P3-008, P3-009

**Allowed files:** `packages/api/src/ai/orchestration/triggers.**`

**Build prompt:** Support automatic, manual, or semi-automatic proposal generation depending on workflow type.

**Review prompt:** Review whether behavior is predictable enough for users.

**Automated checks:**
```bash
npx tsc --noEmit
npm test -- --grep "P3-010"
```

**Required tests:**
- [ ] Happy path test
- [ ] Validation test — invalid input rejected with clear errors

---

### P3-011 — Conversation state and retry handling

> **Size:** S | **Layer:** Reliability | **AI Build:** High | **Human Review:** Moderate

**Dependencies:** P3-001, P3-003, P2-016

**Allowed files:** `packages/web/src/components/status/**, packages/api/src/health/**`

**Build prompt:** Show pending/success/failure states for upload, transcription, proposal generation, and clarification processing.

**Review prompt:** Review whether users can recover without confusion.

**Automated checks:**
```bash
npx tsc --noEmit
npm test -- --grep "P3-011"
```

**Required tests:**
- [ ] Happy path test
- [ ] Validation test — invalid input rejected with clear errors

---

### P3-012 — Conversation search and recent threads

> **Size:** S | **Layer:** Conversation UI | **AI Build:** High | **Human Review:** Light

**Dependencies:** P0-011, P1-014, P1-016

**Allowed files:** `packages/web/src/pages/conversations/**, packages/web/src/components/conversations/**`

**Build prompt:** Provide deterministic search by customer, phone, job, or recent activity and easy access to recent threads.

**Review prompt:** Review search usefulness and field selection.

**Automated checks:**
```bash
npx tsc --noEmit
npm test -- --grep "P3-012"
```

**Required tests:**
- [ ] Happy path test
- [ ] Validation test — invalid input rejected with clear errors

---

### P3-013 — Mobile-friendly technician interactions

> **Size:** S | **Layer:** Technician UX | **AI Build:** High | **Human Review:** Moderate

**Dependencies:** P3-008, P1-016

**Allowed files:** `packages/web/src/pages/technician/**`

**Build prompt:** Optimize technician conversation/work views for small screens and quick voice capture.

**Review prompt:** Review whether the mobile flow is actually field-usable.

**Automated checks:**
```bash
npx tsc --noEmit
npm test -- --grep "P3-013"
```

**Required tests:**
- [ ] Happy path test
- [ ] Validation test — invalid input rejected with clear errors

---

### P3-014 — Conversation-to-estimate linkage

> **Size:** S | **Layer:** Learning | **AI Build:** Medium | **Human Review:** Moderate

**Dependencies:** P1-009B, P1-009C, P2-016, P3-001

**Allowed files:** `packages/api/src/estimates/**, packages/api/src/ai/evaluation/**`

**Build prompt:** Preserve linkage from conversation and estimate proposals to final estimates for later learning and support.

**Review prompt:** Review whether lineage is complete enough.

**Automated checks:**
```bash
npx tsc --noEmit
npm test -- --grep "P3-014"
```

**Required tests:**
- [ ] Happy path test
- [ ] Validation test — invalid input rejected with clear errors

---

### P3-015 — Conversation permissions and visibility rules

> **Size:** S | **Layer:** Security | **AI Build:** Medium | **Human Review:** Moderate

**Dependencies:** P0-003, P3-001, P3-007

**Allowed files:** `packages/api/src/conversations/permissions.**, packages/api/src/middleware/**`

**Build prompt:** Apply role-aware conversation visibility so technicians see only relevant work context.

**Review prompt:** Review whether access rules are operationally safe.

**Automated checks:**
```bash
npx tsc --noEmit
npm test -- --grep "P3-015"
```

**Required tests:**
- [ ] Happy path test
- [ ] Validation test — invalid input rejected with clear errors
- [ ] Role escalation test
- [ ] Missing auth returns 401
- [ ] Wrong tenant returns 403

---
