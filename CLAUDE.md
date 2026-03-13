# AI Service OS — Claude Code Context

## What This Is

AI Service OS is a voice-first, proposal-driven operating system for small HVAC and plumbing businesses. Users interact through conversation and voice. AI interprets input and generates typed proposals. Humans approve before any data changes.

## Tech Stack

- **Language:** TypeScript everywhere (CDK, API, Web, Shared)
- **Backend:** Node.js with Express, Zod validation, Postgres via Drizzle ORM
- **Frontend:** React 18, TypeScript, Tailwind CSS, Vite
- **Infrastructure:** AWS CDK, ECS/Fargate, RDS Postgres, S3, SQS, CloudWatch
- **Auth:** Clerk (sign-up, sign-in, session management, webhooks)
- **Monitoring:** CloudWatch for logs, Sentry for errors
- **Payments:** Stripe (payment links only)
- **SMS:** Twilio (operational messages only)
- **Accounting:** QuickBooks (one-way invoice sync)

## Project Structure

```
/
├── infra/                    # AWS CDK stacks (TypeScript)
├── packages/
│   ├── api/                  # Backend API
│   │   ├── src/
│   │   │   ├── auth/         # Clerk integration, session, user mapping
│   │   │   ├── middleware/   # Auth, permissions, correlation, tenant context
│   │   │   ├── shared/       # Response envelope, errors, billing engine, line items
│   │   │   ├── config/       # Environment config, AI routing config
│   │   │   ├── secrets/      # AWS Secrets Manager resolution
│   │   │   ├── db/           # Connection, RLS setup, migration runner
│   │   │   ├── audit/        # Immutable audit event system
│   │   │   ├── logging/      # Structured JSON logging
│   │   │   ├── monitoring/   # Health metrics, Sentry
│   │   │   ├── flags/        # Feature flags
│   │   │   ├── queues/       # SQS queue definitions
│   │   │   ├── workers/      # Async job processors (base + concrete)
│   │   │   ├── files/        # S3 upload, metadata, retrieval
│   │   │   ├── webhooks/     # Webhook base + provider handlers
│   │   │   ├── customers/    # Customer entity, CRUD, dedup, communication
│   │   │   ├── locations/    # Service location entity
│   │   │   ├── jobs/         # Job entity, lifecycle, timeline
│   │   │   ├── appointments/ # Appointment entity, validation, assignment
│   │   │   ├── estimates/    # Estimate entity, provenance, revisions, deltas, analytics
│   │   │   ├── invoices/     # Invoice entity, balance, numbering
│   │   │   ├── payments/     # Payment entity, partial payments, rollups
│   │   │   ├── conversations/# Thread, message, linkage, permissions, search
│   │   │   ├── voice/        # Transcription pipeline, correction
│   │   │   ├── notes/        # Polymorphic internal notes
│   │   │   ├── settings/     # Tenant business settings
│   │   │   ├── revisions/    # Generic revision storage, diff engine
│   │   │   ├── proposals/    # Proposal entity, contracts, lifecycle, execution, analytics
│   │   │   ├── ai/
│   │   │   │   ├── gateway/  # LLM gateway, provider adapters, router, health, cache
│   │   │   │   ├── providers/# Provider-specific adapters (OpenAI-compatible, mock)
│   │   │   │   ├── orchestration/ # Intent routing, task handlers, triggers
│   │   │   │   ├── context/  # Source-context assembly per task type
│   │   │   │   ├── tasks/    # Concrete AI task implementations
│   │   │   │   ├── guardrails/ # Confidence, low-confidence routing, clarification
│   │   │   │   ├── runs/     # AI run logging
│   │   │   │   ├── prompts/  # Prompt version registry
│   │   │   │   └── evaluation/ # Eval dataset hooks, shadow comparison
│   │   │   └── ...
│   │   ├── migrations/       # Numbered SQL migration files (YYYYMMDD_NNN_name.sql)
│   │   └── tests/
│   │       ├── unit/         # Pure logic tests (no DB, no network)
│   │       ├── integration/  # Tests requiring DB or external services
│   │       ├── e2e/          # Full API endpoint tests
│   │       └── fixtures/     # Shared test data factories
│   ├── web/                  # Frontend React app
│   │   ├── src/
│   │   │   ├── components/   # Reusable UI components
│   │   │   ├── pages/        # Route-level page components
│   │   │   ├── hooks/        # Custom React hooks
│   │   │   ├── lib/          # API client, utilities
│   │   │   └── types/        # Frontend-specific types
│   │   └── tests/            # Component and integration tests
│   └── shared/               # Shared types, contracts, constants
│       ├── proposal-types.ts # Proposal payload Zod schemas
│       ├── permissions.ts    # Permission constants
│       └── enums.ts          # Shared enumerations
├── .github/workflows/        # CI/CD pipelines
├── CLAUDE.md                 # This file
├── docs/
│   ├── stories/              # Per-story implementation specs
│   ├── decisions.md          # Architectural decision log
│   └── testing.md            # Testing strategy and conventions
└── scripts/                  # Dev tooling, seed data, utilities
```

## Commands

```bash
# Build
npm run build                           # TypeScript compile, all packages
npx tsc --noEmit                        # Type check only (fast)

# Test
npm test                                # Run all tests
npm test -- --grep "P0-004"             # Run tests for a specific story
npm run test:unit                       # Unit tests only
npm run test:integration                # Integration tests (requires DB)
npm run test:e2e                        # End-to-end API tests

# Lint
npm run lint                            # ESLint check
npm run lint:fix                        # ESLint auto-fix

# Database
npm run migrate                         # Run pending migrations
npm run migrate:rollback                # Rollback last migration
npm run migrate:status                  # Show migration state

# Infrastructure
cd infra && npx cdk synth               # Synthesize CloudFormation
cd infra && npx cdk deploy --all        # Deploy all stacks

# Dev
npm run dev                             # Start API + Web dev servers
npm run seed                            # Seed test data for dev environment
```

## Core Patterns — Follow These Everywhere

### Money: Integer Cents
```typescript
// ✅ CORRECT
const unitPrice = 4999;  // $49.99
const total = quantity * unitPrice;  // integer arithmetic

// 🚫 NEVER
const unitPrice = 49.99;  // floating point
const total = quantity * unitPrice;  // imprecise
```

### Tenant Isolation: Every Query
```typescript
// ✅ CORRECT — tenant_id in every WHERE clause
const customers = await db.query(
  'SELECT * FROM customers WHERE tenant_id = $1 AND status = $2',
  [ctx.tenantId, 'active']
);

// 🚫 NEVER — query without tenant scope
const customers = await db.query(
  'SELECT * FROM customers WHERE status = $1', ['active']
);
```

### Time: UTC Storage, Tenant Timezone Render
```typescript
// ✅ CORRECT
const scheduledStart = new Date().toISOString();  // UTC
// Render: formatInTimezone(scheduledStart, tenant.timezone)

// 🚫 NEVER — store local time
const scheduledStart = "2026-03-15 09:00:00";  // ambiguous timezone
```

### Audit Events: On Every Mutation
```typescript
// ✅ CORRECT — emit after successful mutation
await customerService.create(data);
await emitAuditEvent({
  tenantId: ctx.tenantId,
  actorId: ctx.userId,
  eventType: 'customer.created',
  entityType: 'customer',
  entityId: customer.id,
  correlationId: ctx.correlationId,
});
```

### AI Calls: Always Through Gateway
```typescript
// ✅ CORRECT — use the LLM gateway
const result = await llmGateway.chat({
  taskType: 'draft_estimate',
  messages: [{ role: 'user', content: contextPayload }],
});

// 🚫 NEVER — direct provider call
import OpenAI from 'openai';
const client = new OpenAI();  // bypass gateway
```

### Proposals: Never Direct Mutation
```typescript
// ✅ CORRECT — AI creates proposal, human approves, engine executes
const proposal = await proposalService.create({
  type: 'create_customer',
  payload: aiOutput,
  confidence: 0.85,
});
// ... human reviews and approves ...
await proposalExecutionEngine.execute(proposal);

// 🚫 NEVER — AI writes directly to entities
await customerService.create(aiOutput);  // no proposal, no review
```

## Three-Tier Boundaries

### ✅ Always Do (no permission needed)
- Run `npm test` and `npx tsc --noEmit` before committing
- Include tenant_id in every database query
- Use integer cents for all money fields
- Emit audit events on entity mutations
- Route AI calls through the LLM gateway
- Add Zod validation to all API endpoints
- Include correlation_id in all log entries
- Follow the naming pattern in existing modules
- Write tests alongside implementation (same PR)
- Use the shared billing engine for financial calculations

### ⚠️ Ask First (require human approval)
- Adding or modifying database migrations
- Adding new npm dependencies
- Modifying auth, RBAC, or permission logic
- Changing proposal execution or approval logic
- Modifying the billing calculation engine
- Adding new API routes or changing route structure
- Changing CI/CD pipeline configuration
- Modifying the LLM gateway provider contract

### 🚫 Never Do (hard stops)
- Commit secrets, API keys, or credentials
- Use floating-point arithmetic for money
- Query without tenant_id scoping
- Auto-execute proposals (all require human approval)
- Call LLM providers directly (must use gateway)
- Edit migrations that have already run in staging/prod
- Remove or skip a failing test without explicit approval
- Modify `node_modules/` or generated files
- Store PII in application logs
- Delete audit events (append-only)

## Testing Conventions

### File Location
- Unit tests: `packages/api/tests/unit/<module>/<name>.test.ts`
- Integration tests: `packages/api/tests/integration/<module>/<name>.integration.test.ts`
- E2E tests: `packages/api/tests/e2e/<endpoint>.e2e.test.ts`
- Component tests: `packages/web/tests/<component>.test.tsx`
- Test fixtures: `packages/api/tests/fixtures/<entity>Factory.ts`

### Test Naming
```typescript
describe('CustomerService', () => {
  describe('create', () => {
    it('should create a customer with valid data', async () => { ... });
    it('should reject creation without tenant_id', async () => { ... });
    it('should emit audit event on creation', async () => { ... });
    it('should prevent cross-tenant access', async () => { ... });
  });
});
```

### Required Test Categories Per Story
Every story must include tests for:
1. **Happy path** — the primary use case works
2. **Tenant isolation** — cross-tenant access is blocked
3. **Validation** — invalid input returns structured errors
4. **Edge cases** — empty data, boundary values, concurrent access
5. **Audit** — mutations emit correct audit events (where applicable)

### Test Data
Use factory functions from `packages/api/tests/fixtures/`:
```typescript
import { createTestTenant, createTestCustomer } from '../fixtures';

const tenant = await createTestTenant();
const customer = await createTestCustomer({ tenantId: tenant.id });
```

## Git Workflow

- **Branch naming:** `feat/P0-001-cdk-baseline`, `fix/P1-009-rounding-bug`
- **Commit format:** `feat(P0-001): provision CDK stacks for dev/staging/prod`
- **PR title:** `[P0-001] Cloud environments and CDK baseline`
- **PR requirements:** All tests pass, typecheck clean, lint clean, story acceptance criteria met
- **Merge strategy:** Squash merge to main

## Story Execution Protocol

1. Read the story spec from `docs/stories/PX-NNN.md`
2. Implement within the allowed files/modules listed in the story
3. Write tests alongside implementation
4. Run `npm test && npx tsc --noEmit && npm run lint`
5. Verify all acceptance criteria from the story spec
6. Commit with conventional format
7. Stories marked "Heavy" human review require human signoff before merge
