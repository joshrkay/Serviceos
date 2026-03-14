# Phase 0 — Platform Foundation

> **18 stories** | Reference: AI Service OS Enhanced Execution PRD

---

## Purpose

Establish the secure, deployable, observable, multi-tenant platform foundation.

## Exit Criteria

Environments deploy cleanly; users sign in; tenancy and roles enforced; logs/errors visible; files, conversations, audio, transcripts, AI runs, and revisions stored safely.

## Locked Decisions

| Decision | Choice |
|----------|--------|
| IaC / runtime | AWS CDK (TypeScript) with ECS/Fargate |
| Auth | Clerk with tenant bootstrap on first owner signup |
| Storage | RDS Postgres + S3 + SQS |
| Monitoring | CloudWatch for logs; Sentry for errors |
| Learning readiness | AI runs, prompt versions, revisions, diffs from the start |

## Story Summary

| ID | Title | Size | Layer | AI Build | Human Review | Dependencies |
|----|-------|------|-------|----------|--------------|-------------|
| P0-001 | Cloud environments and CDK baseline | S | Platform/Infra | High | Moderate | None |
| P0-002 | Clerk auth and tenant bootstrap | S | Auth | High | Moderate | P0-001 |
| P0-003 | RBAC for owner / dispatcher / technician | S | Auth | High | Moderate | P0-002 |
| P0-004 | Tenant-safe Postgres schema + RLS | S | Data | Medium | Heavy | P0-001, P0-002 |
| P0-005 | Backend service skeleton and shared contracts | S | Platform | High | Moderate | P0-001, P0-002, P0-004 |
| P0-006 | Secrets/config framework | S | Platform | High | Moderate | P0-001, P0-005 |
| P0-007 | Audit logging foundation | S | Trust | High | Moderate | P0-002, P0-004, P0-005 |
| P0-008 | Observability, structured logging, and Sentry | S | Ops | High | Moderate | P0-001, P0-005 |
| P0-009 | Async job processing with SQS | S | Workers | High | Moderate | P0-001, P0-005, P0-008 |
| P0-010 | File upload and attachment storage | S | Storage | High | Light | P0-001, P0-004, P0-005 |
| P0-011 | Conversation and message persistence | S | Conversation | High | Moderate | P0-004, P0-010 |
| P0-012 | Voice ingestion and transcription pipeline | S | Voice | Medium | Heavy | P0-009, P0-010, P0-011 |
| P0-013 | Feature flags and environment gating | XS | Release | High | Light | P0-006 |
| P0-014 | Webhook security and idempotency foundation | S | Integrations | Medium | Moderate | P0-006, P0-009 |
| P0-015 | AI run logging foundation | S | AI Foundations | High | Moderate | P0-004, P0-005, P0-007 |
| P0-016 | Prompt version registry | S | AI Foundations | High | Light | P0-015 |
| P0-017 | Document revision storage foundation | S | AI Foundations | Medium | Moderate | P0-004, P0-005 |
| P0-018 | Async diff-analysis worker foundation | S | AI Foundations | Medium | Moderate | P0-009, P0-017 |

---

## Story Specifications

### P0-001 — Cloud environments and CDK baseline

> **Size:** S | **Layer:** Platform/Infra | **AI Build:** High | **Human Review:** Moderate

**Dependencies:** None

**Allowed files:** `infra/**, .github/workflows/**`

**Build prompt:** Create dev/staging/prod stacks with ECS/Fargate, ALB, ECR, and health checks.

**Review prompt:** Review stack separation, deploy safety, tagging, and environment hygiene.

**Automated checks:**
```bash
npx tsc --noEmit
npm test -- --grep "P0-001"
```

**Required tests:**
- [ ] Happy path test
- [ ] Validation test — invalid input rejected with clear errors

---

### P0-002 — Clerk auth and tenant bootstrap

> **Size:** S | **Layer:** Auth | **AI Build:** High | **Human Review:** Moderate

**Dependencies:** P0-001

**Allowed files:** `packages/api/src/auth/**, packages/api/src/middleware/**`

**Build prompt:** Implement owner signup/sign-in and create tenant + owner records on first signup.

**Review prompt:** Review identity mapping, session handling, and tenant bootstrap idempotency.

**Automated checks:**
```bash
npx tsc --noEmit
npm test -- --grep "P0-002"
```

**Required tests:**
- [ ] Happy path test
- [ ] Validation test — invalid input rejected with clear errors
- [ ] Role escalation test
- [ ] Missing auth returns 401
- [ ] Wrong tenant returns 403

---

### P0-003 — RBAC for owner / dispatcher / technician

> **Size:** S | **Layer:** Auth | **AI Build:** High | **Human Review:** Moderate

**Dependencies:** P0-002

**Allowed files:** `packages/api/src/auth/**, packages/api/src/middleware/**`

**Build prompt:** Add role model, permission middleware, and UI-readable permission contract.

**Review prompt:** Review permission boundaries and future proposal-approval compatibility.

**Automated checks:**
```bash
npx tsc --noEmit
npm test -- --grep "P0-003"
```

**Required tests:**
- [ ] Happy path test
- [ ] Validation test — invalid input rejected with clear errors
- [ ] Role escalation test
- [ ] Missing auth returns 401
- [ ] Wrong tenant returns 403

---

### P0-004 — Tenant-safe Postgres schema + RLS

> **Size:** S | **Layer:** Data | **AI Build:** Medium | **Human Review:** Heavy

**Dependencies:** P0-001, P0-002

**Allowed files:** `packages/api/src/db/**, packages/api/migrations/**`

**Build prompt:** Provision tenant-scoped schemas and RLS-ready conventions with migrations.

**Review prompt:** Review tenant isolation, audit fields, indexes, and cross-tenant failure cases.

**Automated checks:**
```bash
npx tsc --noEmit
npm test -- --grep "P0-004"
```

**Required tests:**
- [ ] Happy path test
- [ ] Validation test — invalid input rejected with clear errors
- [ ] Tenant isolation test — cross-tenant data inaccessible

---

### P0-005 — Backend service skeleton and shared contracts

> **Size:** S | **Layer:** Platform | **AI Build:** High | **Human Review:** Moderate

**Dependencies:** P0-001, P0-002, P0-004

**Allowed files:** `packages/api/src/shared/**, packages/api/src/health/**`

**Build prompt:** Create TypeScript service skeleton with validation, health endpoints, structured errors, and shared contracts.

**Review prompt:** Review consistency, maintainability, and hidden coupling.

**Automated checks:**
```bash
npx tsc --noEmit
npm test -- --grep "P0-005"
```

**Required tests:**
- [ ] Happy path test
- [ ] Validation test — invalid input rejected with clear errors

---

### P0-006 — Secrets/config framework

> **Size:** S | **Layer:** Platform | **AI Build:** High | **Human Review:** Moderate

**Dependencies:** P0-001, P0-005

**Allowed files:** `packages/api/src/shared/**, packages/api/src/health/**`

**Build prompt:** Implement startup config validation and Secrets Manager resolution by environment.

**Review prompt:** Review missing-secret behavior, separation of platform vs tenant secrets, and rotation readiness.

**Automated checks:**
```bash
npx tsc --noEmit
npm test -- --grep "P0-006"
```

**Required tests:**
- [ ] Happy path test
- [ ] Validation test — invalid input rejected with clear errors

---

### P0-007 — Audit logging foundation

> **Size:** S | **Layer:** Trust | **AI Build:** High | **Human Review:** Moderate

**Dependencies:** P0-002, P0-004, P0-005

**Allowed files:** `packages/api/src/audit/**`

**Build prompt:** Create immutable audit events with actor, tenant, entity, event type, and correlation id.

**Review prompt:** Review event coverage and whether key mutations remain traceable.

**Automated checks:**
```bash
npx tsc --noEmit
npm test -- --grep "P0-007"
```

**Required tests:**
- [ ] Happy path test
- [ ] Validation test — invalid input rejected with clear errors

---

### P0-008 — Observability, structured logging, and Sentry

> **Size:** S | **Layer:** Ops | **AI Build:** High | **Human Review:** Moderate

**Dependencies:** P0-001, P0-005

**Allowed files:** `packages/api/src/logging/**, packages/api/src/monitoring/**`

**Build prompt:** Add JSON logs, correlation ids, health metrics, and Sentry exception tracking.

**Review prompt:** Review PII exposure, alert coverage, and incident usefulness.

**Automated checks:**
```bash
npx tsc --noEmit
npm test -- --grep "P0-008"
```

**Required tests:**
- [ ] Happy path test
- [ ] Validation test — invalid input rejected with clear errors

---

### P0-009 — Async job processing with SQS

> **Size:** S | **Layer:** Workers | **AI Build:** High | **Human Review:** Moderate

**Dependencies:** P0-001, P0-005, P0-008

**Allowed files:** `packages/api/src/workers/**, packages/api/src/queues/**`

**Build prompt:** Create queue/worker pattern with retries, visibility, and idempotency guidance.

**Review prompt:** Review worker boundaries, retry logic, and dead-letter expectations.

**Automated checks:**
```bash
npx tsc --noEmit
npm test -- --grep "P0-009"
```

**Required tests:**
- [ ] Happy path test
- [ ] Validation test — invalid input rejected with clear errors

---

### P0-010 — File upload and attachment storage

> **Size:** S | **Layer:** Storage | **AI Build:** High | **Human Review:** Light

**Dependencies:** P0-001, P0-004, P0-005

**Allowed files:** `packages/api/src/files/**`

**Build prompt:** Add S3 upload flow, metadata persistence, entity linkage, and secure retrieval.

**Review prompt:** Review auth checks and metadata completeness.

**Automated checks:**
```bash
npx tsc --noEmit
npm test -- --grep "P0-010"
```

**Required tests:**
- [ ] Happy path test
- [ ] Validation test — invalid input rejected with clear errors

---

### P0-011 — Conversation and message persistence

> **Size:** S | **Layer:** Conversation | **AI Build:** High | **Human Review:** Moderate

**Dependencies:** P0-004, P0-010

**Allowed files:** `packages/api/src/conversations/**`

**Build prompt:** Create thread/message model for text, transcript, system-event, and note message types.

**Review prompt:** Review extensibility for proposals, entity linkage, and source tracking.

**Automated checks:**
```bash
npx tsc --noEmit
npm test -- --grep "P0-011"
```

**Required tests:**
- [ ] Happy path test
- [ ] Validation test — invalid input rejected with clear errors

---

### P0-012 — Voice ingestion and transcription pipeline

> **Size:** S | **Layer:** Voice | **AI Build:** Medium | **Human Review:** Heavy

**Dependencies:** P0-009, P0-010, P0-011

**Allowed files:** `packages/api/src/voice/**, packages/api/src/workers/transcription.*`

**Build prompt:** Accept audio uploads, enqueue transcription, persist transcript status and result, link to conversation.

**Review prompt:** Review failure handling, retry semantics, and source-audio preservation.

**Automated checks:**
```bash
npx tsc --noEmit
npm test -- --grep "P0-012"
```

**Required tests:**
- [ ] Happy path test
- [ ] Validation test — invalid input rejected with clear errors

---

### P0-013 — Feature flags and environment gating

> **Size:** XS | **Layer:** Release | **AI Build:** High | **Human Review:** Light

**Dependencies:** P0-006

**Allowed files:** `packages/api/src/flags/**`

**Build prompt:** Add lightweight environment/tenant feature flags for rollout control.

**Review prompt:** Review flag scope and avoid hidden branching complexity.

**Automated checks:**
```bash
npx tsc --noEmit
npm test -- --grep "P0-013"
```

**Required tests:**
- [ ] Happy path test
- [ ] Validation test — invalid input rejected with clear errors

---

### P0-014 — Webhook security and idempotency foundation

> **Size:** S | **Layer:** Integrations | **AI Build:** Medium | **Human Review:** Moderate

**Dependencies:** P0-006, P0-009

**Allowed files:** `packages/api/src/webhooks/**`

**Build prompt:** Create signed webhook ingestion pattern with replay protection and async handoff.

**Review prompt:** Review duplicate-event handling and security boundaries.

**Automated checks:**
```bash
npx tsc --noEmit
npm test -- --grep "P0-014"
```

**Required tests:**
- [ ] Happy path test
- [ ] Validation test — invalid input rejected with clear errors

---

### P0-015 — AI run logging foundation

> **Size:** S | **Layer:** AI Foundations | **AI Build:** High | **Human Review:** Moderate

**Dependencies:** P0-004, P0-005, P0-007

**Allowed files:** `packages/api/src/ai/**`

**Build prompt:** Store task type, model, prompt version, input/output snapshot refs, status, and timing metadata.

**Review prompt:** Review traceability and whether logs support later debugging and evals.

**Automated checks:**
```bash
npx tsc --noEmit
npm test -- --grep "P0-015"
```

**Required tests:**
- [ ] Happy path test
- [ ] Validation test — invalid input rejected with clear errors
- [ ] Mock provider test
- [ ] Malformed AI output handled gracefully

---

### P0-016 — Prompt version registry

> **Size:** S | **Layer:** AI Foundations | **AI Build:** High | **Human Review:** Light

**Dependencies:** P0-015

**Allowed files:** `packages/api/src/ai/**`

**Build prompt:** Create prompt registry with task type, version, active status, and linkage to AI runs.

**Review prompt:** Review versioning semantics and rollback safety.

**Automated checks:**
```bash
npx tsc --noEmit
npm test -- --grep "P0-016"
```

**Required tests:**
- [ ] Happy path test
- [ ] Validation test — invalid input rejected with clear errors
- [ ] Mock provider test
- [ ] Malformed AI output handled gracefully

---

### P0-017 — Document revision storage foundation

> **Size:** S | **Layer:** AI Foundations | **AI Build:** Medium | **Human Review:** Moderate

**Dependencies:** P0-004, P0-005

**Allowed files:** `packages/api/src/ai/**`

**Build prompt:** Store revision snapshots for estimates/invoices with source and actor metadata.

**Review prompt:** Review revision integrity and retrieval patterns.

**Automated checks:**
```bash
npx tsc --noEmit
npm test -- --grep "P0-017"
```

**Required tests:**
- [ ] Happy path test
- [ ] Validation test — invalid input rejected with clear errors
- [ ] Mock provider test
- [ ] Malformed AI output handled gracefully

---

### P0-018 — Async diff-analysis worker foundation

> **Size:** S | **Layer:** AI Foundations | **AI Build:** Medium | **Human Review:** Moderate

**Dependencies:** P0-009, P0-017

**Allowed files:** `packages/api/src/ai/**`

**Build prompt:** Create worker contract that compares two revisions and stores normalized diffs.

**Review prompt:** Review whether output is useful for future learning without overfitting early.

**Automated checks:**
```bash
npx tsc --noEmit
npm test -- --grep "P0-018"
```

**Required tests:**
- [ ] Happy path test
- [ ] Validation test — invalid input rejected with clear errors
- [ ] Mock provider test
- [ ] Malformed AI output handled gracefully

---
