# AI Service OS — Enhanced Execution PRD

## Consolidated Master PRD · Phases 0–7 · Optimized for Claude Code + Cowork

---

## How to Use This Document

This PRD is structured for **AI-agent-driven development** using Claude Code and Cowork. Every story includes:

- **Allowed files/modules** — scope boundaries for the coding agent
- **Acceptance criteria** — verifiable conditions, not vibes
- **Non-goals** — explicit fences so the agent doesn't sprawl
- **Build prompt** — the instruction to send to the coding agent
- **Review prompt** — the instruction to send to the review agent
- **Automated checks** — what the CI pipeline validates

### Execution Protocol

```
1. Copy the story's Build Prompt into Claude Code
2. Verify output stays within Allowed Files/Modules
3. Run Automated Checks
4. Send Review Prompt to a separate Claude Code session
5. Human signoff on stories marked "Heavy" human review
6. Merge only when all checks pass
```

### CLAUDE.md Integration

Drop this into your repo root as `CLAUDE.md` so Claude Code has persistent context:

```markdown
# AI Service OS — Claude Code Context

## Project Structure
- /infra — AWS CDK stacks (TypeScript)
- /packages/api — Backend API (TypeScript, Node, Express/Fastify)
- /packages/web — Frontend (React, TypeScript, Tailwind)
- /packages/shared — Shared types, contracts, constants

## Core Patterns
- All money: integer cents, never floating point
- All times: stored UTC, rendered in tenant timezone
- All entities: tenant_id column + RLS
- All mutations: emit audit events
- All AI calls: route through LLM gateway (packages/api/src/ai/gateway)
- All proposals: typed payloads validated by Zod contracts

## Story Execution Rules
- Only modify files listed in "Allowed files/modules"
- Run automated checks before requesting review
- Never auto-execute proposals — all require human approval
- Use the shared billing engine for all financial calculations
- Use the async worker pattern (P0-009) for background jobs
- Use the webhook base (P0-014) for all external webhook handlers
```

---

## Executive Summary

AI Service OS is a voice-first, proposal-driven operating system for small HVAC and plumbing businesses. Owners, dispatchers, and technicians interact through conversation and voice. The AI interprets input and generates typed, reviewable proposals. Humans approve before any operational data changes.

**Primary beta value propositions:**
1. Faster, more consistent estimate drafting
2. Faster path from completed work to invoice and payment
3. Day-of operations managed through conversation + dispatch board

**Headline metric:** Time to cash

---

## Locked Product Decisions

| Area | Decision |
|------|----------|
| Cloud + deployment | AWS CDK (TypeScript), ECS/Fargate, RDS Postgres, S3, SQS, CloudWatch, Sentry |
| Auth | Clerk with tenant bootstrap on first owner signup |
| Channels in beta | In-app voice + in-app chat + operational SMS context |
| AI safety model | AI creates typed proposals → humans review and approve → deterministic execution |
| LLM strategy | Provider-agnostic gateway with tiered model routing (lightweight/standard/complex) |
| Initial verticals | HVAC and Plumbing via vertical packs |
| Financial | Integer cents, Stripe payment links after invoice approval, deposits as partial payments |
| Dispatch | Appointment-centric day view, drag/drop creates proposals |
| Beta integrations | Twilio SMS, Stripe payment links, QuickBooks one-way invoice sync |

---

## System Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    Channels                              │
│  In-App Voice │ In-App Chat │ SMS (Twilio) │ Future     │
└──────────┬──────────┬──────────┬────────────────────────┘
           │          │          │
┌──────────▼──────────▼──────────▼────────────────────────┐
│              Conversation Layer                           │
│  Threads │ Messages │ Transcripts │ Clarifications       │
└──────────────────────┬──────────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────────┐
│              AI Orchestration                             │
│  Intent Classification │ Context Assembly │ Task Routing  │
└──────────────────────┬──────────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────────┐
│              LLM Gateway (P2-027)                         │
│  Provider Adapters │ Model Router │ Health │ Cache        │
│  ┌─────────┐ ┌──────────┐ ┌───────────┐                 │
│  │Tier 1   │ │Tier 2    │ │Tier 3     │                 │
│  │8B model │ │30-35B MoE│ │Frontier   │                 │
│  │classify │ │proposals │ │estimates  │                 │
│  └─────────┘ └──────────┘ └───────────┘                 │
└──────────────────────┬──────────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────────┐
│              Proposal Engine (Trust Boundary)             │
│  Typed Contracts │ Confidence │ Expiry │ Review UX       │
└──────────────────────┬──────────────────────────────────┘
                       │ (approved only)
┌──────────────────────▼──────────────────────────────────┐
│              Deterministic Execution                      │
│  Entity Mutations │ Idempotency │ Audit │ Rollback-safe  │
└──────────────────────┬──────────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────────┐
│              Operational Data Layer                        │
│  Customers│Jobs│Appointments│Estimates│Invoices│Payments  │
│  Tenant-scoped │ RLS │ Audit │ Revisions │ Diffs         │
└──────────────────────┬──────────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────────┐
│              Learning Foundations                          │
│  AI Runs │ Prompt Versions │ Revisions │ Edit Deltas     │
│  Proposal Outcomes │ Eval Datasets │ Quality Metrics     │
└─────────────────────────────────────────────────────────┘
```

### Core Architectural Principles

1. **Proposal-first safety** — AI creates typed proposals; deterministic services execute approved actions
2. **Voice-first interaction** — primary beta experience is in-app voice + conversation
3. **Tenant isolation** — all entities, conversations, proposals, AI artifacts are tenant-scoped with RLS
4. **Learning-ready data model** — AI runs, prompt versions, revisions, diffs preserved for quality improvement
5. **Vertical-pack model** — HVAC/plumbing behavior layered on shared core
6. **Provider-agnostic AI** — LLM gateway abstracts model providers; tiered routing optimizes cost/quality

---

## AI-Heavy Delivery Model

### Story Sizing Policy

| Size | Definition | AI Agent Execution |
|------|-----------|-------------------|
| XS | Isolated change, one objective, minimal blast radius | Direct to Claude Code |
| S | One contained implementation unit | Direct to Claude Code |
| M+ | Must split before implementation | **Never send to coding agent** |

Every story in this catalog is XS or S.

### AI vs Human Review Matrix

| Work Type | AI Buildability | Human Review Focus |
|-----------|----------------|-------------------|
| CRUD entities / APIs | High | Field semantics, tenant boundaries |
| DB schema + migrations | Medium | Irreversible decisions, money/time semantics |
| RBAC / auth | Medium | Security, least privilege |
| Proposal engine | Medium | Trust, lifecycle, stale context |
| Estimate/invoice calculations | Medium | Financial correctness |
| LLM gateway / model routing | High | Provider contracts, credential security, routing decisions |
| Conversation / UI | High | UX clarity, mobile practicality |
| Voice / transcription | Medium | Recovery behavior, source preservation |
| Integrations | Medium | Webhook idempotency, operational support |

---

## Testing Strategy

Testing is a first-class concern in this PRD, not a downstream activity. Every story includes test requirements, and the CI pipeline enforces coverage thresholds. The full testing strategy document lives at `docs/testing.md` in the repo.

### Testing Framework

| Tool | Purpose |
|------|---------|
| Vitest | Unit and integration tests (all packages) |
| Supertest | HTTP route integration tests |
| Testing Library | React component tests |
| Playwright | E2E tests (Phase 7+ beta hardening) |
| testcontainers | Postgres container for integration tests |

### Coverage Thresholds (CI-Enforced)

| Module Category | Line Coverage | Branch Coverage |
|----------------|--------------|-----------------|
| Billing engine | 100% | 100% |
| Proposal execution | 95% | 90% |
| Auth / RBAC / permissions | 95% | 90% |
| Appointment time validation | 95% | 90% |
| AI gateway / routing | 90% | 85% |
| Entity CRUD / services | 80% | 75% |
| UI components | 70% | — |

### Test Categories Required per Story

Every story must include tests for:
1. **Happy path** — primary use case works end-to-end
2. **Validation** — invalid input rejected with structured errors
3. **Tenant isolation** — cross-tenant access denied at data layer
4. **Permissions** — unauthorized roles rejected (for protected routes)
5. **Edge cases** — empty data, boundary values, concurrent access

### Test Conventions

- **Test files:** `packages/*/tests/` mirroring `src/` structure
- **Naming:** `<module>.test.ts` for unit, `<module>.integration.test.ts` for integration
- **Test data:** Factory functions, never raw fixtures
- **DB isolation:** Transaction rollback after each test
- **CI order:** `tsc --noEmit` → `lint` → `migrate:up` → `test --coverage` → `check-coverage`

### AI-Specific Testing

For AI task handlers (P2-016 estimate drafting, P5-003A invoice drafting):
- Use deterministic mock LLM provider for unit tests
- Validate AI output against Zod proposal contracts
- Verify billing engine recalculates totals (override AI-suggested totals)
- Golden dataset regression tests after beta has real approval data

For LLM gateway (P2-027):
- Provider swap tests (change config → same result)
- Tier routing tests (task type → correct model tier)
- Failover tests (degrade primary → automatic fallback)
- Cache hit tests (same input → cached response → no LLM call)

### E2E Test Flows (Phase 7 Beta Readiness)

These five critical flows must have passing E2E tests before external beta:
1. **Dispatcher intake:** Voice → transcript → proposals → approve → customer + job + appointment
2. **Estimate flow:** Conversation → draft estimate → edit → approve → estimate with provenance
3. **Invoice flow:** Completed work → draft invoice → approve → Stripe payment link → payment
4. **Dispatch flow:** Drag/drop → scheduling proposal → conflict check → approve → assignment
5. **Technician flow:** Voice update → transcript → proposal routed to dispatcher → approve

### Load Testing Targets (Phase 7)

- 50 concurrent tenants
- 100 requests/second
- P95 < 500ms for CRUD, < 3s for AI tasks
- Zero cross-tenant data leakage under load

---

## AI Quality Metrics and Beta Thresholds

The AI components need measurable quality gates before going to external beta. These thresholds are tracked by the analytics foundations built in Phases 1, 2, and 4.

### Estimate AI Quality (Phase 4 Exit Criteria)

| Metric | Threshold | Measurement |
|--------|-----------|-------------|
| Approval rate | > 70% | % of estimate proposals approved or approved-with-edits |
| Clean approval rate | > 30% | % approved without any edits |
| Edit rate | < 40% | % of approved proposals that required edits |
| Execution failure rate | < 5% | % of approved proposals where execution fails |
| Average time-to-review | < 90 seconds | Median time from proposal ready_for_review to approved/rejected |
| Low-confidence rate | < 25% | % of AI tasks routed to clarification or safe failure |

### Invoice AI Quality (Phase 5 Exit Criteria)

| Metric | Threshold | Measurement |
|--------|-----------|-------------|
| Approval rate | > 75% | % of invoice proposals approved |
| Clean approval rate | > 40% | % approved without edits |
| Time-to-cash improvement | > 30% | Reduction vs manual invoice creation time |

### Proposal System Health (Phase 2 Exit Criteria)

| Metric | Threshold | Measurement |
|--------|-----------|-------------|
| Proposal execution success rate | > 99% | % of approved proposals that execute without error |
| Stale proposal rate | < 10% | % of proposals that expire before review |
| Clarification resolution rate | > 60% | % of clarification requests that lead to successful proposals |

### LLM Gateway Health (P2-027–P2-031)

| Metric | Threshold | Measurement |
|--------|-----------|-------------|
| Gateway availability | > 99.5% | % of requests that receive a response (including fallback) |
| P95 latency (lightweight tier) | < 2s | Intent classification, entity extraction |
| P95 latency (standard tier) | < 5s | Proposal generation |
| P95 latency (complex tier) | < 15s | Estimate drafting |
| Cache hit rate (deterministic tasks) | > 40% | After 1 week of usage |
| Failover trigger rate | < 5% | % of requests that trigger automatic failover |

---

## Phase 0 — Platform Foundation

**Purpose:** Secure, deployable, observable, multi-tenant platform foundation before AI mutates business workflows.

**Exit criteria:** Environments deploy cleanly; users sign in; tenancy and roles enforced; logs/errors visible; files, conversations, audio, transcripts, AI runs, and revisions stored safely.

### Locked Decisions

| Decision | Choice |
|----------|--------|
| IaC / runtime | AWS CDK (TypeScript) with ECS/Fargate |
| Auth | Clerk with tenant bootstrap on first owner signup |
| Storage | RDS Postgres + S3 + SQS |
| Monitoring | CloudWatch for logs; Sentry for errors |
| Learning readiness | AI runs, prompt versions, revisions, diffs from the start |

### Story Catalog

#### P0-001 — Cloud environments and CDK baseline `[S]`

| Attribute | Value |
|-----------|-------|
| Layer | Platform/Infra |
| AI Buildability | High |
| Human Review | Moderate |
| Dependencies | None |
| Allowed Files | `infra/**`, `.github/workflows/**`, `package.json`, `tsconfig.json`, `CLAUDE.md` |

**Build prompt:** Provision AWS CDK stacks for dev/staging/prod on ECS/Fargate with ALB, ECR, health checks, and GitHub Actions CI/CD. Use TypeScript CDK. Create a monorepo structure with `/infra`, `/packages/api`, `/packages/web`, `/packages/shared` directories.

**Review prompt:** Review environment separation, security groups, health checks, rollback path, naming/tagging consistency, and whether the monorepo structure supports bounded story-level changes.

**Automated checks:** `cdk synth; deploy smoke; health-check validation; typecheck`

**Acceptance criteria:**
- CDK synth succeeds for all three stacks
- Dev deploys with a passing health check
- GitHub Actions pipeline runs lint + typecheck + deploy on push to main

**Non-goals:** Do not configure production domains, SSL, or custom VPC beyond default. Do not set up frontend build yet.

---

#### P0-002 — Clerk auth and tenant bootstrap `[S]`

| Attribute | Value |
|-----------|-------|
| Layer | Auth |
| AI Buildability | High |
| Human Review | Moderate |
| Dependencies | P0-001 |
| Allowed Files | `packages/api/src/auth/**`, `packages/api/src/tenants/**`, `packages/api/src/middleware/**` |

**Build prompt:** Implement Clerk sign-up/sign-in with webhook-based tenant bootstrap. On first owner signup: create tenant record, map Clerk user to internal user, set owner role. Use Clerk middleware for session validation. Store tenant_id in session context for all downstream queries.

**Review prompt:** Review identity mapping, session handling, tenant bootstrap idempotency, and whether re-signup or Clerk webhook replay causes duplicate tenants.

**Automated checks:** `auth integration tests; permission tests; tenant bootstrap idempotency tests`

**Acceptance criteria:**
- New user signup creates exactly one tenant and one owner user
- Clerk webhook replay does not duplicate
- Session middleware injects tenant_id and user_id into request context
- Unauthenticated requests return 401

**Non-goals:** Do not implement invitation flow, team management, or social login.

---

#### P0-003 — RBAC for owner / dispatcher / technician `[S]`

| Attribute | Value |
|-----------|-------|
| Layer | Auth |
| AI Buildability | High |
| Human Review | Heavy |
| Dependencies | P0-002 |
| Allowed Files | `packages/api/src/auth/**`, `packages/api/src/middleware/permissions.*` |

**Build prompt:** Add role model (owner, dispatcher, technician) with shared permission middleware. Create permission constants enum, role-to-permission mapping, and route-level guards. Owners get full access, dispatchers get operational access, technicians get assigned-work-only access.

**Review prompt:** Review permission matrix, least-privilege enforcement, and whether the model supports future proposal-approval restrictions (technicians cannot approve financial proposals).

**Automated checks:** `permission matrix tests; route auth tests; role escalation tests`

**Acceptance criteria:**
- Each role has a defined permission set
- Route guards reject unauthorized access with 403
- Permission constants are importable by any module
- Tests cover all role-route combinations

**Non-goals:** Do not implement custom roles or per-tenant role config.

---

#### P0-004 — Tenant-safe Postgres schema + RLS `[S]`

| Attribute | Value |
|-----------|-------|
| Layer | Data |
| AI Buildability | Medium |
| Human Review | Heavy |
| Dependencies | P0-001, P0-002 |
| Allowed Files | `packages/api/src/db/**`, `packages/api/migrations/**`, `packages/api/src/entities/base.*` |

**Build prompt:** Provision RDS Postgres. Implement tenant_id column convention, RLS policies, migration workflow with up/down scripts, standard audit fields (created_at, updated_at, created_by, updated_by) on base entity. Create shared base migration and migration runner.

**Review prompt:** Review RLS policy completeness, cross-tenant safety, index strategy, migration rollback safety.

**Automated checks:** `migration tests; schema validation; tenant isolation tests; cross-tenant query tests`

**Acceptance criteria:**
- RLS prevents cross-tenant reads and writes
- Migrations run forward and backward cleanly
- All tables include tenant_id and audit fields
- A test proves user A cannot read user B's tenant data

**Non-goals:** Do not create business entity tables yet. Do not implement soft-delete pattern yet.

---

#### P0-005 — Backend service skeleton and shared contracts `[S]`

| Attribute | Value |
|-----------|-------|
| Layer | Platform |
| AI Buildability | High |
| Human Review | Moderate |
| Dependencies | P0-001, P0-002, P0-004 |
| Allowed Files | `packages/api/src/shared/**`, `packages/api/src/health/**`, `packages/api/src/example/**` |

**Build prompt:** Create TypeScript service skeleton with Zod-based request validation, typed error responses with error codes, health endpoint, tenant-aware request context type, shared API response envelope, and example CRUD module showing the full pattern.

**Review prompt:** Review layering consistency, error model clarity, and whether an AI coding agent can follow the pattern to generate new entity modules without ambiguity.

**Automated checks:** `typecheck; unit tests; contract tests; pattern-conformance lint`

**Acceptance criteria:**
- Health endpoint returns 200 with version and environment
- Error responses follow the shared envelope
- Validation errors return structured field-level errors
- Example module demonstrates full CRUD pattern with tenant scoping

**Non-goals:** Do not build real business entities. Example module is a reference pattern only.

---

#### P0-006 — Secrets and config framework `[S]`

| Attribute | Value |
|-----------|-------|
| Layer | Platform |
| AI Buildability | High |
| Human Review | Moderate |
| Dependencies | P0-001, P0-005 |
| Allowed Files | `packages/api/src/config/**`, `packages/api/src/secrets/**` |

**Build prompt:** Implement environment-aware config loading from env vars and AWS Secrets Manager. Validate required config at startup — fail fast. Separate platform secrets (DB, AWS) from integration secrets (Clerk, Stripe, Twilio). Typed config accessor.

**Review prompt:** Review secret exposure risks in logs/errors, config validation strictness, environment parity, rotation readiness.

**Automated checks:** `startup config tests; secret resolution tests; missing-secret failure tests`

**Acceptance criteria:**
- App fails to start if required secrets are missing
- Secrets never appear in logs or error responses
- Config is typed and accessible from any module
- Dev environment works with .env file fallback

**Non-goals:** Do not implement secret rotation. Do not build integration-specific config yet.

---

#### P0-007 — Audit logging foundation `[S]`

| Attribute | Value |
|-----------|-------|
| Layer | Trust |
| AI Buildability | High |
| Human Review | Moderate |
| Dependencies | P0-002, P0-004, P0-005 |
| Allowed Files | `packages/api/src/audit/**`, `packages/api/migrations/*audit*` |

**Build prompt:** Create immutable audit event model: actor_id, tenant_id, event_type enum, entity_type, entity_id, timestamp, correlation_id, metadata JSONB. Provide emitAuditEvent() helper. Append-only audit_events table.

**Review prompt:** Review audit event coverage, separation from debug logs, and compliance query support.

**Automated checks:** `audit event tests; traceability checks; append-only enforcement tests`

**Acceptance criteria:**
- Audit events persisted with all required fields
- Audit table is append-only (no UPDATE/DELETE)
- Events queryable by tenant, entity, and time range
- Shared helper makes emitting events trivial

**Non-goals:** Do not build audit UI or search API.

---

#### P0-008 — Observability, structured logging, and Sentry `[S]`

| Attribute | Value |
|-----------|-------|
| Layer | Ops |
| AI Buildability | High |
| Human Review | Moderate |
| Dependencies | P0-001, P0-005 |
| Allowed Files | `packages/api/src/logging/**`, `packages/api/src/monitoring/**`, `packages/api/src/middleware/correlation.*` |

**Build prompt:** Structured JSON logging with correlation IDs. CloudWatch log sinks. Sentry exception tracking with tenant/user context. Health metrics endpoint. PII redaction for email, phone, name fields.

**Review prompt:** Review PII redaction completeness, alert coverage, correlation ID propagation across async boundaries.

**Automated checks:** `logging tests; PII redaction tests; sentry smoke; correlation propagation tests`

**Acceptance criteria:**
- All log entries are structured JSON with correlation_id
- PII fields masked in logs
- Sentry captures unhandled exceptions with tenant context
- Health metrics endpoint returns request count, error rate, latency

**Non-goals:** Do not build dashboards. Do not implement distributed tracing.

---

#### P0-009 — Async job processing with SQS `[S]`

| Attribute | Value |
|-----------|-------|
| Layer | Workers |
| AI Buildability | High |
| Human Review | Moderate |
| Dependencies | P0-001, P0-005, P0-008 |
| Allowed Files | `packages/api/src/workers/**`, `packages/api/src/queues/**`, `infra/sqs-stacks.*` |

**Build prompt:** SQS-backed async job pattern: typed job payloads, worker polling loop, configurable retry with exponential backoff, dead-letter queue, idempotency key support, structured logging per job. Base worker class that concrete workers extend.

**Review prompt:** Review idempotency enforcement, poison message handling, visibility timeout, and pattern clarity for AI-generated workers.

**Automated checks:** `queue tests; retry tests; idempotency tests; DLQ tests`

**Acceptance criteria:**
- Jobs enqueued with typed payloads and idempotency keys
- Workers retry with backoff up to configurable limit
- Failed jobs land in DLQ
- Duplicate submissions deduplicated
- Worker execution logged with correlation IDs

**Non-goals:** Do not implement concrete workers yet. Framework only.

---

#### P0-010 — File upload and attachment storage `[S]`

| Attribute | Value |
|-----------|-------|
| Layer | Storage |
| AI Buildability | High |
| Human Review | Light |
| Dependencies | P0-001, P0-004, P0-005 |
| Allowed Files | `packages/api/src/files/**`, `packages/api/migrations/*file*` |

**Build prompt:** S3 upload with presigned URLs, file metadata table (tenant_id, entity_type, entity_id, filename, content_type, size_bytes, s3_key, uploaded_by, created_at), signed retrieval URLs, tenant-prefixed S3 keys, file size/type validation.

**Automated checks:** `upload tests; authz tests; metadata tests; file-type validation tests`

**Acceptance criteria:** Files upload via presigned URL with tenant-prefixed keys. Metadata persisted and queryable by entity. Retrieval URLs signed and time-limited.

**Non-goals:** No file browsing UI, image processing, thumbnails, or virus scanning.

---

#### P0-011 — Conversation and message persistence `[S]`

| Attribute | Value |
|-----------|-------|
| Layer | Conversation |
| AI Buildability | High |
| Human Review | Moderate |
| Dependencies | P0-004, P0-010 |
| Allowed Files | `packages/api/src/conversations/**`, `packages/api/migrations/*conversation*`, `packages/api/migrations/*message*` |

**Build prompt:** Thread model: tenant_id, status, created_by, linked_customer_id (nullable), linked_job_id (nullable). Message model: thread_id, message_type enum (text, transcript, system_event, note, proposal_summary), sender_type (user, system, ai), content, metadata JSONB, created_at. Chronological retrieval with pagination.

**Automated checks:** `thread/message tests; linkage tests; pagination tests`

**Acceptance criteria:** Threads tenant-scoped. Messages typed. Chronological pagination. Entity linkage nullable. Mixed message types in a thread.

**Non-goals:** No conversation UI, real-time delivery, or message search.

---

#### P0-012 — Voice ingestion and transcription pipeline `[S]`

| Attribute | Value |
|-----------|-------|
| Layer | Voice |
| AI Buildability | Medium |
| Human Review | Heavy |
| Dependencies | P0-009, P0-010, P0-011 |
| Allowed Files | `packages/api/src/voice/**`, `packages/api/src/workers/transcription.*`, `packages/api/migrations/*transcript*` |

**Build prompt:** Audio file upload → S3 storage → enqueue transcription job → persist status (queued/processing/completed/failed) and result → link to conversation message. Pluggable provider interface with stub implementation.

**Automated checks:** `upload tests; transcription state tests; retry tests; provider-swap tests`

**Acceptance criteria:** Audio stored and linked. Transcription jobs queued and processed. Status tracked. Failed transcriptions retryable. Provider swappable without pipeline changes.

**Non-goals:** No real transcription provider (use stub). No voice capture UI.

---

#### P0-013 — Feature flags and environment gating `[XS]`

| Attribute | Value |
|-----------|-------|
| Layer | Release |
| AI Buildability | High |
| Human Review | Light |
| Dependencies | P0-006 |
| Allowed Files | `packages/api/src/flags/**`, `packages/api/migrations/*flag*` |

**Build prompt:** Lightweight feature flags with environment-level and tenant-level overrides. Simple isEnabled(flagName, tenantId?) check. Seed flags for Phase 1+ features.

**Automated checks:** `flag tests; rollout tests; precedence tests`

**Acceptance criteria:** Flags checkable by name with optional tenant context. Environment overrides tenant. Missing flags default to false.

**Non-goals:** No flag management UI. No percentage-based rollout.

---

#### P0-014 — Webhook security and idempotency foundation `[S]`

| Attribute | Value |
|-----------|-------|
| Layer | Integrations |
| AI Buildability | Medium |
| Human Review | Moderate |
| Dependencies | P0-006, P0-009 |
| Allowed Files | `packages/api/src/webhooks/**`, `packages/api/migrations/*webhook*` |

**Build prompt:** Secure webhook base: pluggable signature verification, replay protection via event ID dedup, async handoff to worker queue, structured failure logging. Reusable base for Clerk/Stripe/Twilio.

**Automated checks:** `webhook signature tests; idempotency tests; replay protection tests`

**Acceptance criteria:** Signatures verified. Duplicates rejected. Events handed off async. Failures logged with full context.

**Non-goals:** No provider-specific handlers. Foundation only.

---

#### P0-015 — AI run logging foundation `[S]`

| Attribute | Value |
|-----------|-------|
| Layer | AI Foundations |
| AI Buildability | High |
| Human Review | Moderate |
| Dependencies | P0-004, P0-005, P0-007 |
| Allowed Files | `packages/api/src/ai/runs/**`, `packages/api/migrations/*ai_run*` |

**Build prompt:** AI run log model: id, tenant_id, task_type, model_identifier, prompt_version_id, input/output snapshot refs, status (queued/running/completed/failed/timeout), timing, token_count_input, token_count_output, cost_estimate_usd. logAiRun() helper.

**Automated checks:** `persistence tests; query tests; cost-tracking tests`

**Acceptance criteria:** AI runs logged with all fields. Queryable by tenant, task type, status, time range. Helper captures timing automatically.

**Non-goals:** No AI/LLM calls. No run viewing UI.

---

#### P0-016 — Prompt version registry `[S]`

| Attribute | Value |
|-----------|-------|
| Layer | AI Foundations |
| AI Buildability | High |
| Human Review | Light |
| Dependencies | P0-015 |
| Allowed Files | `packages/api/src/ai/prompts/**`, `packages/api/migrations/*prompt*` |

**Build prompt:** Prompt registry: task_type, version, prompt_template, is_active, created_at. Active prompt lookup per task type. AI run linkage. Rollback by re-activation.

**Automated checks:** `persistence tests; query tests; version rollback tests`

**Acceptance criteria:** Prompts versioned per task type. One active per type. AI runs reference version. Previous version re-activatable.

**Non-goals:** No prompt authoring UI. No A/B testing.

---

#### P0-017 — Document revision storage foundation `[S]`

| Attribute | Value |
|-----------|-------|
| Layer | AI Foundations |
| AI Buildability | Medium |
| Human Review | Moderate |
| Dependencies | P0-004, P0-005 |
| Allowed Files | `packages/api/src/revisions/**`, `packages/api/migrations/*revision*` |

**Build prompt:** Generic revision model: entity_type, entity_id, revision_number, snapshot_payload JSONB, source_type, actor_id, created_at. Revision history and latest revision queries.

**Automated checks:** `persistence tests; query tests; revision ordering tests`

**Acceptance criteria:** Revisions per entity with monotonic numbers. Full history retrievable. Latest queryable efficiently.

**Non-goals:** No diff generation. No revision UI.

---

#### P0-018 — Async diff-analysis worker foundation `[S]`

| Attribute | Value |
|-----------|-------|
| Layer | AI Foundations |
| AI Buildability | Medium |
| Human Review | Moderate |
| Dependencies | P0-009, P0-017 |
| Allowed Files | `packages/api/src/workers/diff.*`, `packages/api/src/revisions/diff.*`, `packages/api/migrations/*diff*` |

**Build prompt:** Worker comparing two revision snapshots. Diff format: array of {field_path, change_type, old_value, new_value}. Store in diff_results table linked to revision pair.

**Automated checks:** `diff worker tests; diff format tests; retry tests`

**Acceptance criteria:** Diffs generated between revisions. Structured format. Stored and queryable. Uses async job framework with idempotency.

**Non-goals:** No semantic diff. Structural field-level only.

---

## Phase 1 — Core Business Entities

**Purpose:** Deterministic operational model for customers, locations, jobs, appointments, estimates, invoices, and payments.

**Exit criteria:** All core entities work end-to-end; estimate provenance and revision hooks exist for future learning.

### Locked Decisions

| Decision | Choice |
|----------|--------|
| Customer model | Customer and service location are separate entities |
| Scheduling | Appointment separate from job; stores scheduled time + arrival window |
| Estimate/invoice | Shared line-item schema; document-level subtotal, discount, tax, total |
| Money | Integer cents everywhere, no floating point |
| Timezone | Store UTC, render in tenant timezone |

### Story Catalog

> **Note:** Phase 1 stories follow the same enhanced format as Phase 0. For brevity in this document, Phase 1–7 stories use the compact format. The full expanded versions with all fields are available in the Linear import CSV.

| ID | Title | Size | Layer | AI Build | Human Review | Dependencies |
|----|-------|------|-------|----------|--------------|-------------|
| P1-001 | Customer entity + CRUD | S | Core Entity | High | Moderate | P0-002, P0-004, P0-005, P0-007 |
| P1-002 | Customer communication methods | S | Core Entity | High | Light | P1-001 |
| P1-003 | Service location entity | S | Core Entity | High | Moderate | P1-001 |
| P1-004 | Deterministic duplicate prevention | S | Validation | Medium | Moderate | P1-001, P1-003 |
| P1-005 | Job entity + CRUD | S | Core Entity | High | Moderate | P1-001, P1-003 |
| P1-006 | Job lifecycle and timeline events | S | Workflow | Medium | Moderate | P1-005, P0-007 |
| P1-007 | Appointment entity + schedule/arrival window | S | Scheduling | Medium | Heavy | P1-005 |
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
| P1-016 | Operational list/detail views, filters, search | S | UI | High | Moderate | P0-003, P1-001, P1-003, P1-005, P1-007, P1-009, P1-011, P1-013 |
| P1-017 | Tenant business settings and numbering preferences | S | Settings | High | Moderate | P0-002 |

---

## Phase 2 — Proposal Engine + AI Safety

**Purpose:** Introduce typed proposal model that converts AI output into reviewable, auditable, human-approved operational actions.

**Exit criteria:** Proposals generated, reviewed, edited, approved, rejected, executed deterministically, and analyzed.

### Locked Decisions

| Decision | Choice |
|----------|--------|
| Proposal safety | AI never writes directly to operational entities |
| Scope in beta | Customer, job, appointment, estimate proposals; invoice proposals start Phase 5 |
| Approval policy | Owners and dispatchers approve; technicians cannot approve financial proposals |
| Low confidence | Never auto-executes; routes to clarification, partial proposal, or safe failure |
| LLM access | All AI calls route through the LLM gateway (P2-027) — no direct provider calls |

### Story Catalog

| ID | Title | Size | Layer | AI Build | Human Review | Dependencies |
|----|-------|------|-------|----------|--------------|-------------|
| P2-001 | Proposal entity and core schema | S | AI Safety | High | Heavy | P0-004, P0-015, P1-014 |
| P2-002 | Typed proposal contracts | S | AI Safety | High | Heavy | P2-001, P1-001, P1-005, P1-007, P1-009 |
| P2-003 | Proposal lifecycle transitions | S | Workflow | High | Moderate | P2-001 |
| P2-004 | Proposal list and detail views | S | UI | High | Moderate | P2-001, P2-002, P1-016 |
| P2-005 | Approve / reject / edit interactions | S | UI + Workflow | Medium | Heavy | P2-004 |
| P2-006 | Proposal audit timeline and entity linkage | S | Trust | High | Light | P2-001, P0-007 |
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
| P2-017 | Estimate proposal review + inline edit | S | Estimate AI | Medium | Heavy | P2-005, P2-016, P1-009B, P1-009E |
| P2-018 | Proposal rejection reasons + correction signals | S | Learning | High | Moderate | P2-005, P2-009 |
| P2-019 | Proposal outcome analytics foundation | S | Analytics | Medium | Light | P2-003, P2-009, P2-018 |
| P2-020 | Evaluation dataset hooks | S | Evaluation | Medium | Moderate | P0-015, P0-016, P2-019 |
| P2-021 | Proposal inbox prioritization | XS | UI | High | Light | P2-004, P2-015 |
| P2-022 | Inline proposal rendering in conversation | S | Conversation | High | Moderate | P0-011, P2-004 |
| **P2-027** | **Provider-agnostic LLM gateway** | **S** | **AI/Platform** | **High** | **Heavy** | **P0-015, P0-016, P2-007** |
| **P2-028** | **Task-complexity-based model routing** | **S** | **AI/Orchestration** | **Medium** | **Heavy** | **P2-027, P2-008** |
| **P2-029** | **Provider health monitoring + failover** | **S** | **AI/Operations** | **High** | **Moderate** | **P2-027, P0-008** |
| **P2-030** | **Model shadow comparison framework** | **S** | **AI/Analytics** | **Medium** | **Moderate** | **P2-027, P2-020, P0-015** |
| **P2-031** | **Response caching for deterministic tasks** | **S** | **AI/Platform** | **High** | **Moderate** | **P2-027** |

---

## Phase 3 — Conversation + Voice Experience

**Purpose:** Turn the proposal system into a day-to-day conversational product.

**Exit criteria:** Users work conversationally with transcripts, inline proposals, clarifications, linked context, and role-aware views.

### Story Catalog

| ID | Title | Size | Layer | AI Build | Human Review | Dependencies |
|----|-------|------|-------|----------|--------------|-------------|
| P3-001 | Core conversation thread UI | S | Conversation UI | High | Moderate | P0-011, P2-022, P1-016 |
| P3-002 | Voice capture UI | S | Voice UI | Medium | Moderate | P0-012 |
| P3-003 | Transcript rendering and status | S | Voice UI | High | Light | P0-011, P0-012, P3-001 |
| P3-004 | Transcript review and correction | S | Voice UI | Medium | Moderate | P3-003, P0-017 |
| P3-005 | Clarification rendering and response flow | S | Conversation UI | Medium | Moderate | P2-014, P3-001 |
| P3-006 | Inline proposal rendering with quick actions | S | Conversation UI | High | Moderate | P2-004, P2-005, P3-001 |
| P3-007 | Conversation-side context panel | S | Context UI | High | Moderate | P1-014, P1-016, P3-001 |
| P3-008 | Technician voice update workflow | S | Technician UX | Medium | Heavy | P1-008, P3-002, P2-016 |
| P3-009 | Dispatcher conversational intake workflow | S | Dispatcher UX | Medium | Heavy | P2-016, P2-005, P3-001, P3-002 |
| P3-010 | Proposal trigger modes by workflow type | S | Orchestration UX | Medium | Moderate | P2-007, P3-002, P3-008, P3-009 |
| P3-011 | Conversation state and retry handling | S | Reliability | High | Light | P3-001, P3-003, P2-016 |
| P3-012 | Conversation search and recent threads | S | Conversation UI | High | Light | P0-011, P1-014, P1-016 |
| P3-013 | Mobile-friendly technician interactions | S | Technician UX | High | Moderate | P3-008, P1-016 |
| P3-014 | Conversation-to-estimate linkage | S | Learning | Medium | Light | P1-009B, P1-009C, P2-016, P3-001 |
| P3-015 | Conversation permissions and visibility | S | Security | Medium | Heavy | P0-003, P3-001, P3-007 |

---

## Phases 4–7 — Summary Tables

> Phases 4–7 retain the same story structure from the source PRD. The full expanded versions with allowed files, acceptance criteria, and non-goals are in the Linear import CSV. Summary tables below for reference.

### Phase 4 — Vertical Packs + Estimate Intelligence (26 stories)

**Purpose:** Make estimates trade-aware for HVAC and plumbing. Begin improving drafts using vertical context and tenant history.

Key stories: Vertical pack registry (P4-001A–C), HVAC/plumbing terminology and taxonomy (P4-002A–P4-003B), estimate templates (P4-004A–C), approved-estimate retrieval (P4-005A–C), bundle patterns (P4-006A–B), wording preferences (P4-007A–B), missing-item signals (P4-008A–B), vertical-aware context assembly (P4-009A–C), quality metrics (P4-011A), beta benchmark (P4-012).

### Phase 5 — Invoice Intelligence + Payments (29 stories)

**Purpose:** Extend AI from estimates to invoices and payment readiness. Accelerate time to cash.

Key stories: Invoice draft proposal (P5-001–003C), invoice review UI (P5-004A–C), execution (P5-005), Stripe payment links (P5-010A–F), payment recording (P5-011A–C), time-to-cash analytics (P5-013A–B), beta benchmark (P5-015).

### Phase 6 — Dispatch Board + Scheduling (27 stories)

**Purpose:** Day-of operational layer for dispatchers and technicians.

Key stories: Day-view board (P6-001–006), drag/drop scheduling proposals (P6-007–008), appointment proposal types (P6-009–014), technician availability (P6-015A–C), conflict detection (P6-016–018), technician view (P6-019), analytics (P6-022A–B).

### Phase 7 — Integrations + Beta Hardening (18 stories)

**Purpose:** Core integrations, support tooling, and reliability for external beta.

Key stories: Twilio SMS (P7-001–004), Stripe (P7-005–006), QuickBooks sync (P7-007–010), diagnostics (P7-011–014), beta flags (P7-015), degraded-mode UX (P7-016), backup/recovery (P7-017), launch readiness (P7-018).

---

## Testing Strategy

> Testing is a first-class concern in this PRD, not an afterthought. Every story must include tests. This section defines the conventions, coverage requirements, and AI-specific quality thresholds.

### Test Framework

| Tool | Purpose | Introduced |
|------|---------|-----------|
| Vitest | Unit + integration tests (all packages) | P0-001 |
| Supertest | HTTP integration tests | P0-005 |
| Testing Library | React component tests | P1-016 |
| Playwright | E2E browser tests | P7-018 |
| testcontainers | Real Postgres for integration tests | P0-004 |

### Test File Conventions

- **Unit tests:** Co-located as `module.test.ts` next to source
- **Integration tests:** `packages/api/tests/integration/[domain]/`
- **Test factories:** `packages/api/tests/factories/` — one per entity, uses Faker
- **Naming:** Describe blocks use story IDs: `describe('P0-004: Tenant isolation', () => { ... })`
- **Never hardcode IDs** — always generate via factory

### Coverage Requirements

| Module Category | Minimum | Rationale |
|----------------|---------|-----------|
| Billing engine | 95% | Financial correctness is non-negotiable |
| Payments | 90% | Money movement |
| Estimates/invoices | 90% | Customer-facing financial docs |
| Proposal execution | 85% | Trust boundary |
| Auth/RBAC | 85% | Security boundary |
| AI gateway | 80% | Provider abstraction reliability |
| CRUD + validation | 70% | High AI-buildability, moderate risk |
| UI components | 60% | Behavior, not pixel-perfect |

### Required Tests by Story Type

**Every story:** Happy path + validation + tenant isolation (if DB-touching)

**Financial stories** additionally: zero amount, rounding boundary, large amount (>$100K), negative amount, 100% discount, partial payment arithmetic

**Permission stories** additionally: role escalation, missing auth (401), wrong tenant (403)

**Proposal stories** additionally: invalid transition, stale context, idempotency, execution failure recovery

**AI/LLM stories** additionally: mock provider, malformed AI output, timeout handling, provider swap

### AI Quality Thresholds (Beta Gate)

These must be met before promoting from Phase 4 to Phase 5:

| Metric | Beta Threshold | Measured By |
|--------|---------------|-------------|
| Estimate proposal approval rate | ≥ 60% | P2-019 |
| Wrong-entity rejection rate | < 5% | P2-018 |
| Line-item edit rate | < 40% of items edited | P2-017 |
| Intent classification accuracy | ≥ 85% | P2-020 eval hooks |
| AI response schema validation | ≥ 95% pass | P2-027 gateway |
| Mean time to first proposal | < 15 seconds | P2-007 timing |

### CI Pipeline

**PR checks:** typecheck → lint → unit tests → integration tests → coverage check
**Staging deploy:** all PR checks → CDK synth → migration dry-run → deploy → smoke tests
**Beta quality gate:** full eval dataset → AI thresholds → financial test suite → human review of 20 random proposals

### Story-Level Test Checklist

Every PR must confirm:
- [ ] Unit tests added/updated
- [ ] Integration tests (if DB-touching)
- [ ] Tenant isolation test (if new entity)
- [ ] Financial edge cases (if money-related)
- [ ] Permission tests (if new endpoint)
- [ ] All existing tests pass
- [ ] Coverage thresholds maintained

---

## Effort and Timing Estimates

| Phase | Outcome | AI-Buildable | Human Review | Calendar Range* |
|-------|---------|-------------|--------------|----------------|
| 0 | Secure platform foundation | ~65% | ~35% | 3–5 weeks |
| 1 | Core business entities | ~70% | ~30% | 4–6 weeks |
| 2 | Proposal engine + AI safety + LLM gateway | ~55% | ~45% | 5–7 weeks |
| 3 | Conversation + voice UX | ~60% | ~40% | 3–5 weeks |
| 4 | Vertical packs + estimate intelligence | ~55% | ~45% | 3–5 weeks |
| 5 | Invoice intelligence + payments | ~55% | ~45% | 3–5 weeks |
| 6 | Dispatch board + scheduling | ~50% | ~50% | 4–6 weeks |
| 7 | Integrations + beta hardening | ~45% | ~55% | 4–6 weeks |

*Assumes 2 engineers using AI tools heavily + founder/product oversight.

### Recommended Beta Cut

- **Must-have before external beta:** Phases 0–3 + estimate intelligence from Phase 4 + payment-link/support essentials from Phases 5 and 7
- **Strong beta target:** Complete Phases 0–6 + core Phase 7 integrations
- **Defer if needed:** Route optimization, automated reminders, outbound AI calling, advanced accounting sync

---

## Critical Path: Phase 0 Execution Order

Based on dependency analysis, here is the parallelizable execution order for Phase 0:

```
Week 1 (parallel):
  P0-001 Cloud environments ──→ P0-002 Clerk auth
  
Week 2 (parallel, after P0-001 + P0-002):
  P0-003 RBAC
  P0-004 Tenant-safe Postgres
  P0-005 Backend skeleton (after P0-004)
  
Week 3 (parallel, after P0-005):
  P0-006 Secrets framework
  P0-007 Audit logging
  P0-008 Observability
  P0-009 Async workers
  P0-010 File upload
  
Week 4 (parallel, after P0-009 + P0-010):
  P0-011 Conversation persistence
  P0-012 Voice pipeline
  P0-013 Feature flags (after P0-006)
  P0-014 Webhook base (after P0-006 + P0-009)
  
Week 5 (parallel, after P0-004 + P0-005 + P0-007):
  P0-015 AI run logging
  P0-016 Prompt registry (after P0-015)
  P0-017 Revision storage
  P0-018 Diff worker (after P0-009 + P0-017)
```

---

## Dependency Graph: Phase 2 Model Routing Integration

```
P0-015 (AI run logging) ──┐
P0-016 (Prompt registry) ──┤
P2-001 (Proposal entity) ──┤
                           ▼
               P2-007 (Orchestration baseline)
                           │
                           ▼
               P2-027 (LLM Gateway) ◄── P0-008 (Observability)
                    │    │    │
         ┌─────────┘    │    └──────────┐
         ▼              ▼               ▼
   P2-028           P2-029          P2-031
   (Model Router)   (Health/Failover) (Response Cache)
         │
         ▼
   P2-030 (Shadow Comparison) ◄── P2-020 (Eval Hooks)
```

P2-027 is the critical story — it must ship before or alongside P2-007 so all orchestration goes through the gateway from day one.
