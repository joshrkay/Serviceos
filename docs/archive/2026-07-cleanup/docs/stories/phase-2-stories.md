# Phase 2 — Proposal Engine + AI Safety

> **27 stories** | Reference: AI Service OS Enhanced Execution PRD

---

## Purpose

Introduce typed proposal model converting AI output into reviewable, auditable, human-approved actions.

## Exit Criteria

Proposals generated, reviewed, edited, approved, rejected, executed deterministically, and analyzed.

## Locked Decisions

| Decision | Choice |
|----------|--------|
| Proposal safety | AI never writes directly to operational entities |
| Scope in beta | Customer, job, appointment, estimate proposals; invoice proposals start Phase 5 |
| Approval policy | Owners/dispatchers approve; technicians cannot approve financial proposals |
| Low confidence | Never auto-executes; routes to clarification, partial proposal, or safe failure |
| LLM access | All AI calls route through the LLM gateway (P2-027) |

## Story Summary

| ID | Title | Size | Layer | AI Build | Human Review | Dependencies |
|----|-------|------|-------|----------|--------------|-------------|
| P2-001 | Proposal entity and core schema | S | AI Safety | High | Moderate | P0-004, P0-015, P1-014 |
| P2-002 | Typed proposal contracts | S | AI Safety | High | Moderate | P2-001, P1-001, P1-005, P1-007, P1-009 |
| P2-003 | Proposal lifecycle transitions | S | Workflow | High | Moderate | P2-001 |
| P2-004 | Proposal list and detail views | S | UI | High | Moderate | P2-001, P2-002, P1-016 |
| P2-005 | Approve / reject / edit interactions | S | UI + Workflow | Medium | Heavy | P2-004 |
| P2-006 | Proposal audit timeline and entity linkage | S | Trust | High | Moderate | P2-001, P0-007 |
| P2-007 | AI task orchestration baseline | S | Orchestration | Medium | Heavy | P0-015, P0-016, P2-001 |
| P2-008 | Source-context packaging | S | Orchestration | Medium | Moderate | P1-014, P1-017, P2-007 |
| P2-009 | AI run to proposal linkage | S | AI Foundations | High | Light | P0-015, P0-016, P2-001 |
| P2-010 | Deterministic proposal execution engine | S | Execution | Medium | Heavy | P2-002, P2-003, P1-001, P1-005, P1-007, P1-009 |
| P2-011 | Execution idempotency controls | S | Execution | Medium | Heavy | P2-010 |
| P2-012 | Confidence storage and display | S | Guardrails | High | Moderate | P2-001, P2-004 |
| P2-013 | Low-confidence handling policy | S | Guardrails | Medium | Heavy | P2-012, P0-013 |
| P2-014 | Clarification request workflow | S | Conversation | Medium | Moderate | P2-007, P2-013 |
| P2-015 | Proposal expiration and stale-context handling | S | Guardrails | Medium | Moderate | P2-003, P2-010 |
| P2-016 | Estimate draft proposal generation | S | Estimate AI | Medium | Heavy | P1-009, P2-008, P2-010 |
| P2-017 | Estimate proposal review + inline edit workflow | S | Estimate AI | Medium | Heavy | P2-005, P2-016, P1-009B, P1-009E |
| P2-018 | Proposal rejection reasons and correction signals | S | Learning | High | Moderate | P2-005, P2-009 |
| P2-019 | Proposal outcome analytics foundation | S | Analytics | Medium | Light | P2-003, P2-009, P2-018 |
| P2-020 | Evaluation dataset hooks for proposal tasks | S | Evaluation | Medium | Moderate | P0-015, P0-016, P2-019 |
| P2-021 | Proposal inbox prioritization | XS | UI | High | Light | P2-004, P2-015 |
| P2-022 | Inline proposal rendering in conversation | S | Conversation | High | Moderate | P0-011, P2-004 |
| P2-027 | Provider-agnostic LLM gateway | S | AI/Platform | High | Heavy | P0-015, P0-016, P2-007 |
| P2-028 | Task-complexity-based model routing | S | AI/Orchestration | Medium | Heavy | P2-027, P2-008 |
| P2-029 | Provider health monitoring and automatic failover | S | AI/Operations | High | Moderate | P2-027, P0-008 |
| P2-030 | Model performance shadow comparison | S | AI/Analytics | Medium | Moderate | P2-027, P2-020, P0-015 |
| P2-031 | Response caching for deterministic AI tasks | S | AI/Platform | High | Moderate | P2-027 |

---

## Story Specifications

### P2-001 — Proposal entity and core schema

> **Size:** S | **Layer:** AI Safety | **AI Build:** High | **Human Review:** Moderate

**Dependencies:** P0-004, P0-015, P1-014

**Allowed files:** `packages/api/src/proposals/**`

**Build prompt:** Create proposal entity with status, payload, summary, explanation, confidence, source context refs, AI run refs, and target linkage.

**Review prompt:** Review traceability and lifecycle completeness.

**Automated checks:**
```bash
npx tsc --noEmit
npm test -- --grep "P2-001"
```

**Required tests:**
- [ ] Happy path test
- [ ] Validation test — invalid input rejected with clear errors
- [ ] Tenant isolation test — cross-tenant data inaccessible
- [ ] Invalid transition test
- [ ] Idempotency test
- [ ] Mock provider test
- [ ] Malformed AI output handled gracefully

---

### P2-002 — Typed proposal contracts

> **Size:** S | **Layer:** AI Safety | **AI Build:** High | **Human Review:** Moderate

**Dependencies:** P2-001, P1-001, P1-005, P1-007, P1-009

**Allowed files:** `packages/api/src/proposals/**`

**Build prompt:** Define payload schemas for create/update customer, job, appointment, and draft/update estimate proposals.

**Review prompt:** Review schema completeness and safe editability.

**Automated checks:**
```bash
npx tsc --noEmit
npm test -- --grep "P2-002"
```

**Required tests:**
- [ ] Happy path test
- [ ] Validation test — invalid input rejected with clear errors
- [ ] Tenant isolation test — cross-tenant data inaccessible
- [ ] Invalid transition test
- [ ] Idempotency test
- [ ] Mock provider test
- [ ] Malformed AI output handled gracefully

---

### P2-003 — Proposal lifecycle transitions

> **Size:** S | **Layer:** Workflow | **AI Build:** High | **Human Review:** Moderate

**Dependencies:** P2-001

**Allowed files:** `packages/api/src/jobs/lifecycle.**`

**Build prompt:** Enforce draft, ready_for_review, approved, rejected, expired, executed, and execution_failed transitions.

**Review prompt:** Review invalid transitions and expiry semantics.

**Automated checks:**
```bash
npx tsc --noEmit
npm test -- --grep "P2-003"
```

**Required tests:**
- [ ] Happy path test
- [ ] Validation test — invalid input rejected with clear errors

---

### P2-004 — Proposal list and detail views

> **Size:** S | **Layer:** UI | **AI Build:** High | **Human Review:** Moderate

**Dependencies:** P2-001, P2-002, P1-016

**Allowed files:** `packages/web/src/pages/**, packages/web/src/components/**`

**Build prompt:** Build proposal inbox and detail views with filters, explanation, confidence, and source context.

**Review prompt:** Review usability and whether confidence/explanation are understandable.

**Automated checks:**
```bash
npx tsc --noEmit
npm test -- --grep "P2-004"
```

**Required tests:**
- [ ] Happy path test
- [ ] Validation test — invalid input rejected with clear errors

---

### P2-005 — Approve / reject / edit interactions

> **Size:** S | **Layer:** UI + Workflow | **AI Build:** Medium | **Human Review:** Heavy

**Dependencies:** P2-004

**Allowed files:** `packages/web/src/components/proposals/**, packages/api/src/proposals/**`

**Build prompt:** Allow typed field editing before approval, rejection reasons, and approve-with-edits tracking.

**Review prompt:** Review trust model and edit semantics.

**Automated checks:**
```bash
npx tsc --noEmit
npm test -- --grep "P2-005"
```

**Required tests:**
- [ ] Happy path test
- [ ] Validation test — invalid input rejected with clear errors

---

### P2-006 — Proposal audit timeline and entity linkage

> **Size:** S | **Layer:** Trust | **AI Build:** High | **Human Review:** Moderate

**Dependencies:** P2-001, P0-007

**Allowed files:** `packages/api/src/audit/**`

**Build prompt:** Show proposal history and the resulting entity if executed.

**Review prompt:** Review whether support/debug visibility is sufficient.

**Automated checks:**
```bash
npx tsc --noEmit
npm test -- --grep "P2-006"
```

**Required tests:**
- [ ] Happy path test
- [ ] Validation test — invalid input rejected with clear errors

---

### P2-007 — AI task orchestration baseline

> **Size:** S | **Layer:** Orchestration | **AI Build:** Medium | **Human Review:** Heavy

**Dependencies:** P0-015, P0-016, P2-001

**Allowed files:** `packages/api/src/ai/orchestration/**, packages/api/src/ai/tasks/**`

**Build prompt:** Route conversation inputs into bounded task handlers such as create_customer, create_job, create_appointment, and draft_estimate.

**Review prompt:** Review orchestration boundaries and unsupported-task handling.

**Automated checks:**
```bash
npx tsc --noEmit
npm test -- --grep "P2-007"
```

**Required tests:**
- [ ] Happy path test
- [ ] Validation test — invalid input rejected with clear errors
- [ ] Mock provider test
- [ ] Malformed AI output handled gracefully

---

### P2-008 — Source-context packaging

> **Size:** S | **Layer:** Orchestration | **AI Build:** Medium | **Human Review:** Moderate

**Dependencies:** P1-014, P1-017, P2-007

**Allowed files:** `packages/api/src/ai/orchestration/**, packages/api/src/ai/tasks/**`

**Build prompt:** Assemble relevant conversation, customer, job, location, and tenant context for proposal generation.

**Review prompt:** Review whether context is relevant and not bloated.

**Automated checks:**
```bash
npx tsc --noEmit
npm test -- --grep "P2-008"
```

**Required tests:**
- [ ] Happy path test
- [ ] Validation test — invalid input rejected with clear errors
- [ ] Mock provider test
- [ ] Malformed AI output handled gracefully

---

### P2-009 — AI run to proposal linkage

> **Size:** S | **Layer:** AI Foundations | **AI Build:** High | **Human Review:** Light

**Dependencies:** P0-015, P0-016, P2-001

**Allowed files:** `packages/api/src/ai/**`

**Build prompt:** Link each proposal to AI run and prompt version metadata.

**Review prompt:** Review provenance usefulness.

**Automated checks:**
```bash
npx tsc --noEmit
npm test -- --grep "P2-009"
```

**Required tests:**
- [ ] Happy path test
- [ ] Validation test — invalid input rejected with clear errors
- [ ] Mock provider test
- [ ] Malformed AI output handled gracefully

---

### P2-010 — Deterministic proposal execution engine

> **Size:** S | **Layer:** Execution | **AI Build:** Medium | **Human Review:** Heavy

**Dependencies:** P2-002, P2-003, P1-001, P1-005, P1-007, P1-009

**Allowed files:** `packages/api/src/proposals/execution/**`

**Build prompt:** Map approved proposal types to deterministic entity mutations; record outcomes and resulting entity refs.

**Review prompt:** Review idempotency, entity safety, and execution boundaries.

**Automated checks:**
```bash
npx tsc --noEmit
npm test -- --grep "P2-010"
```

**Required tests:**
- [ ] Happy path test
- [ ] Validation test — invalid input rejected with clear errors
- [ ] Tenant isolation test — cross-tenant data inaccessible
- [ ] Invalid transition test
- [ ] Idempotency test

---

### P2-011 — Execution idempotency controls

> **Size:** S | **Layer:** Execution | **AI Build:** Medium | **Human Review:** Heavy

**Dependencies:** P2-010

**Allowed files:** `packages/api/src/proposals/execution/**`

**Build prompt:** Prevent duplicate execution on retries or repeated approvals.

**Review prompt:** Review duplicate-write risks and recovery behavior.

**Automated checks:**
```bash
npx tsc --noEmit
npm test -- --grep "P2-011"
```

**Required tests:**
- [ ] Happy path test
- [ ] Validation test — invalid input rejected with clear errors
- [ ] Tenant isolation test — cross-tenant data inaccessible
- [ ] Invalid transition test
- [ ] Idempotency test

---

### P2-012 — Confidence storage and display

> **Size:** S | **Layer:** Guardrails | **AI Build:** High | **Human Review:** Moderate

**Dependencies:** P2-001, P2-004

**Allowed files:** `packages/api/src/ai/guardrails/**`

**Build prompt:** Store confidence metadata and render it without using it to auto-execute.

**Review prompt:** Review whether confidence helps users without overpromising certainty.

**Automated checks:**
```bash
npx tsc --noEmit
npm test -- --grep "P2-012"
```

**Required tests:**
- [ ] Happy path test
- [ ] Validation test — invalid input rejected with clear errors
- [ ] Invalid transition test
- [ ] Idempotency test

---

### P2-013 — Low-confidence handling policy

> **Size:** S | **Layer:** Guardrails | **AI Build:** Medium | **Human Review:** Heavy

**Dependencies:** P2-012, P0-013

**Allowed files:** `packages/api/src/ai/guardrails/**`

**Build prompt:** Route low-confidence outputs to clarification, partial proposal, or safe failure.

**Review prompt:** Review thresholds and failure-mode UX.

**Automated checks:**
```bash
npx tsc --noEmit
npm test -- --grep "P2-013"
```

**Required tests:**
- [ ] Happy path test
- [ ] Validation test — invalid input rejected with clear errors
- [ ] Invalid transition test
- [ ] Idempotency test

---

### P2-014 — Clarification request workflow

> **Size:** S | **Layer:** Conversation | **AI Build:** Medium | **Human Review:** Moderate

**Dependencies:** P2-007, P2-013

**Allowed files:** `packages/api/src/conversations/**`

**Build prompt:** Support in-thread clarification prompts, responses, and proposal regeneration.

**Review prompt:** Review linkage to original task and user comprehension.

**Automated checks:**
```bash
npx tsc --noEmit
npm test -- --grep "P2-014"
```

**Required tests:**
- [ ] Happy path test
- [ ] Validation test — invalid input rejected with clear errors

---

### P2-015 — Proposal expiration and stale-context handling

> **Size:** S | **Layer:** Guardrails | **AI Build:** Medium | **Human Review:** Moderate

**Dependencies:** P2-003, P2-010

**Allowed files:** `packages/api/src/ai/guardrails/**`

**Build prompt:** Expire or block stale proposals when underlying context changed materially.

**Review prompt:** Review invalidation aggressiveness.

**Automated checks:**
```bash
npx tsc --noEmit
npm test -- --grep "P2-015"
```

**Required tests:**
- [ ] Happy path test
- [ ] Validation test — invalid input rejected with clear errors
- [ ] Invalid transition test
- [ ] Idempotency test

---

### P2-016 — Estimate draft proposal generation

> **Size:** S | **Layer:** Estimate AI | **AI Build:** Medium | **Human Review:** Heavy

**Dependencies:** P1-009, P2-008, P2-010

**Allowed files:** `packages/api/src/ai/tasks/**, packages/web/src/components/proposals/estimate-editor.**`

**Build prompt:** Generate draft_estimate proposals from conversation + entity context.

**Review prompt:** Review line-item quality expectations and schema alignment.

**Automated checks:**
```bash
npx tsc --noEmit
npm test -- --grep "P2-016"
```

**Required tests:**
- [ ] Happy path test
- [ ] Validation test — invalid input rejected with clear errors
- [ ] Mock provider test
- [ ] Malformed AI output handled gracefully

---

### P2-017 — Estimate proposal review + inline edit workflow

> **Size:** S | **Layer:** Estimate AI | **AI Build:** Medium | **Human Review:** Heavy

**Dependencies:** P2-005, P2-016, P1-009B, P1-009E

**Allowed files:** `packages/api/src/ai/tasks/**, packages/web/src/components/proposals/estimate-editor.**`

**Build prompt:** Allow line-item, quantity, category, price, and wording edits before approving draft_estimate proposals.

**Review prompt:** Review financial trust and edit capture.

**Automated checks:**
```bash
npx tsc --noEmit
npm test -- --grep "P2-017"
```

**Required tests:**
- [ ] Happy path test
- [ ] Validation test — invalid input rejected with clear errors
- [ ] Mock provider test
- [ ] Malformed AI output handled gracefully

---

### P2-018 — Proposal rejection reasons and correction signals

> **Size:** S | **Layer:** Learning | **AI Build:** High | **Human Review:** Moderate

**Dependencies:** P2-005, P2-009

**Allowed files:** `packages/api/src/estimates/**, packages/api/src/ai/evaluation/**`

**Build prompt:** Capture structured reasons such as wrong entity, missing info, wrong pricing, wrong wording, or duplicate action.

**Review prompt:** Review analytics usefulness and coverage.

**Automated checks:**
```bash
npx tsc --noEmit
npm test -- --grep "P2-018"
```

**Required tests:**
- [ ] Happy path test
- [ ] Validation test — invalid input rejected with clear errors

---

### P2-019 — Proposal outcome analytics foundation

> **Size:** S | **Layer:** Analytics | **AI Build:** Medium | **Human Review:** Light

**Dependencies:** P2-003, P2-009, P2-018

**Allowed files:** `packages/api/src/*/analytics.**`

**Build prompt:** Store approval, edit, rejection, execution-failure, and low-confidence signals by task type and tenant.

**Review prompt:** Review whether later metrics can be derived cleanly.

**Automated checks:**
```bash
npx tsc --noEmit
npm test -- --grep "P2-019"
```

**Required tests:**
- [ ] Happy path test
- [ ] Validation test — invalid input rejected with clear errors

---

### P2-020 — Evaluation dataset hooks for proposal tasks

> **Size:** S | **Layer:** Evaluation | **AI Build:** Medium | **Human Review:** Moderate

**Dependencies:** P0-015, P0-016, P2-019

**Allowed files:** `packages/api/src/ai/evaluation/**`

**Build prompt:** Store proposal-task snapshots and approved outcomes so later offline evals can compare prompts/models/releases.

**Review prompt:** Review whether hooks are enough for regression testing.

**Automated checks:**
```bash
npx tsc --noEmit
npm test -- --grep "P2-020"
```

**Required tests:**
- [ ] Happy path test
- [ ] Validation test — invalid input rejected with clear errors

---

### P2-021 — Proposal inbox prioritization

> **Size:** XS | **Layer:** UI | **AI Build:** High | **Human Review:** Light

**Dependencies:** P2-004, P2-015

**Allowed files:** `packages/web/src/pages/**, packages/web/src/components/**`

**Build prompt:** Sort and group pending proposals by age, urgency, and type.

**Review prompt:** Review whether prioritization feels useful but not noisy.

**Automated checks:**
```bash
npx tsc --noEmit
npm test -- --grep "P2-021"
```

**Required tests:**
- [ ] Happy path test
- [ ] Validation test — invalid input rejected with clear errors

---

### P2-022 — Inline proposal rendering in conversation

> **Size:** S | **Layer:** Conversation | **AI Build:** High | **Human Review:** Moderate

**Dependencies:** P0-011, P2-004

**Allowed files:** `packages/api/src/conversations/**`

**Build prompt:** Render proposal cards inside threads with quick actions and status updates.

**Review prompt:** Review whether inline rendering feels natural and trustworthy.

**Automated checks:**
```bash
npx tsc --noEmit
npm test -- --grep "P2-022"
```

**Required tests:**
- [ ] Happy path test
- [ ] Validation test — invalid input rejected with clear errors

---

### P2-027 — Provider-agnostic LLM gateway

> **Size:** S | **Layer:** AI/Platform | **AI Build:** High | **Human Review:** Heavy

**Dependencies:** P0-015, P0-016, P2-007

**Allowed files:** `packages/api/src/ai/gateway/**`

**Build prompt:** Create unified LLM gateway with provider-agnostic request/response contract. Expose OpenAI-compatible internal API. Implement provider adapters for: (1) OpenAI-compatible APIs (covers Claude, GPT, Together.ai, Fireworks.ai, vLLM), (2) stub/mock for testing. Store credentials via secrets framework. Log all calls through AI run logging. Route by task type via config.

**Review prompt:** Review provider abstraction, credential security, API surface, and whether switching providers requires zero business logic changes. Verify gateway is the only module importing provider SDKs.

**Automated checks:**
```bash
npx tsc --noEmit
npm test -- --grep "P2-027"
```

**Required tests:**
- [ ] Happy path test
- [ ] Validation test — invalid input rejected with clear errors
- [ ] Mock provider test
- [ ] Malformed AI output handled gracefully

---

### P2-028 — Task-complexity-based model routing

> **Size:** S | **Layer:** AI/Orchestration | **AI Build:** Medium | **Human Review:** Heavy

**Dependencies:** P2-027, P2-008

**Allowed files:** `packages/api/src/ai/gateway/router.**, packages/api/src/config/ai-routing.**`

**Build prompt:** Implement task-complexity router in the gateway. Three tiers in config: lightweight (intent classification, entity extraction, transcript normalization), standard (customer/job/appointment proposals, clarifications), complex (estimate drafting, multi-entity proposals, financial docs). Each tier maps to configurable model/provider pair. Track per-tier latency and cost in AI run logs.

**Review prompt:** Review tier classification accuracy, cost/quality tradeoffs, routing config ergonomics, and whether tier boundaries match real task difficulty.

**Automated checks:**
```bash
npx tsc --noEmit
npm test -- --grep "P2-028"
```

**Required tests:**
- [ ] Happy path test
- [ ] Validation test — invalid input rejected with clear errors
- [ ] Mock provider test
- [ ] Malformed AI output handled gracefully

---

### P2-029 — Provider health monitoring and automatic failover

> **Size:** S | **Layer:** AI/Operations | **AI Build:** High | **Human Review:** Moderate

**Dependencies:** P2-027, P0-008

**Allowed files:** `packages/api/src/ai/gateway/health.**, packages/api/src/ai/gateway/failover.**`

**Build prompt:** Track per-provider latency (p50/p95/p99), error rate, availability via sliding windows. Auto-failover when thresholds exceeded (error >10% over 5min, p95 >30s). Log failover events. Support manual override via feature flags.

**Review prompt:** Review threshold defaults, alerting policy, failover speed, and whether fallback preserves task quality.

**Automated checks:**
```bash
npx tsc --noEmit
npm test -- --grep "P2-029"
```

**Required tests:**
- [ ] Happy path test
- [ ] Validation test — invalid input rejected with clear errors
- [ ] Mock provider test
- [ ] Malformed AI output handled gracefully

---

### P2-030 — Model performance shadow comparison

> **Size:** S | **Layer:** AI/Analytics | **AI Build:** Medium | **Human Review:** Moderate

**Dependencies:** P2-027, P2-020, P0-015

**Allowed files:** `packages/api/src/ai/evaluation/**`

**Build prompt:** Shadow mode: run same task against primary + shadow provider (shadow logged only). Configurable sampling rate per task type (default 10%). Track quality via proposal acceptance rates and edit distances. Store with comparison_group_id.

**Review prompt:** Review shadow impact on cost/latency, scoring methodology, and whether data enables confident model promotion.

**Automated checks:**
```bash
npx tsc --noEmit
npm test -- --grep "P2-030"
```

**Required tests:**
- [ ] Happy path test
- [ ] Validation test — invalid input rejected with clear errors
- [ ] Mock provider test
- [ ] Malformed AI output handled gracefully

---

### P2-031 — Response caching for deterministic AI tasks

> **Size:** S | **Layer:** AI/Platform | **AI Build:** High | **Human Review:** Moderate

**Dependencies:** P2-027

**Allowed files:** `packages/api/src/ai/gateway/**`

**Build prompt:** Cache within gateway for deterministic tasks (classification, extraction, normalization). Content-addressed keys (hash of model+prompt+input). Tenant isolation in keys. Configurable TTL per task type. Track hit rates and cost savings.

**Review prompt:** Review invalidation policy, tenant isolation, TTL config, and stale-result risk per task category.

**Automated checks:**
```bash
npx tsc --noEmit
npm test -- --grep "P2-031"
```

**Required tests:**
- [ ] Happy path test
- [ ] Validation test — invalid input rejected with clear errors
- [ ] Mock provider test
- [ ] Malformed AI output handled gracefully

---
