# Phase 0 — Platform Foundation: Launch Readiness Gaps

> **14 stories** | Continues from P0-018

---

## Purpose

Close the critical infrastructure gaps that prevent any real usage: database persistence, frontend authentication, environment safety, real STT, and queue integration.

## Exit Criteria

All data persists across restarts; real users can sign in and receive tenants; env vars validated; voice transcription returns real results; queues process asynchronously.

## Gap Summary

| ID | Title | Size | Layer | AI Build | Human Review | Dependencies |
|----|-------|------|-------|----------|--------------|-------------|
| P0-019 | Postgres repositories — core entities | M | Data | High | Heavy | P0-004, P0-005 |
| P0-020 | Postgres repositories — financial entities | M | Data | High | Heavy | P0-004, P0-005, P0-019 |
| P0-021 | Postgres repositories — AI & conversation entities | M | Data | High | Heavy | P0-004, P0-005 |
| P0-022 | Postgres repositories — config & operational entities | M | Data | High | Heavy | P0-004, P0-005 |
| P0-023 | Wire Postgres pool in app.ts and replace all InMemory instantiations | S | Platform | High | Heavy | P0-019, P0-020, P0-021, P0-022 |
| P0-024 | RLS tenant context middleware | S | Security | Medium | Heavy | P0-023 |
| P0-025 | Implement bootstrapTenant() on Clerk user.created webhook | S | Auth | Medium | Heavy | P0-002, P0-004, P0-024 |
| P0-026 | Startup env validation and remove hardcoded dev-secret fallback | S | Platform | High | Moderate | P0-006 |
| P0-027 | Integrate real STT provider (OpenAI Whisper) | S | Voice | Medium | Heavy | P0-009, P0-012 |
| P0-028 | Replace InMemory queue with SQS worker integration | S | Workers | Medium | Moderate | P0-009 |
| P0-029 | Frontend Clerk SDK integration | S | Auth/UI | High | Heavy | P0-002 |
| P0-030 | Auth headers in frontend API client hooks | S | Auth/UI | High | Moderate | P0-029 |
| P0-031 | Protected route guards | S | Auth/UI | High | Light | P0-029 |
| P0-032 | Global error boundary and Sonner toast provider | S | UI | High | Light | None |

---

## Story Specifications

### P0-019 — Postgres repositories — core entities

> **Size:** M | **Layer:** Data | **AI Build:** High | **Human Review:** Heavy

**Dependencies:** P0-004, P0-005

**Allowed files:** `packages/api/src/customers/pg-*.ts, packages/api/src/locations/pg-*.ts, packages/api/src/jobs/pg-*.ts, packages/api/src/appointments/pg-*.ts, packages/api/src/notes/pg-*.ts`

**Build prompt:** Create Postgres-backed repository implementations for Customer, Location, Job, JobTimeline, Appointment, and Note entities. Each must implement the same interface as its InMemory counterpart. Use the existing `PgDatabaseClient` from `packages/api/src/db/client.ts`. All queries must include `tenant_id` in WHERE clauses as defense-in-depth alongside RLS. Use parameterized queries only — no string interpolation. Handle connection errors gracefully. Follow the existing InMemory repository interface contracts exactly.

**Review prompt:** Verify SQL injection safety (parameterized queries only). Verify tenant_id is included in every query. Verify error handling on connection failures. Verify all InMemory interface methods are implemented. Check index usage on common query patterns (list by tenant, search by name, filter by status).

**Automated checks:**
```bash
npx tsc --noEmit
npm test -- --grep "P0-019"
```

**Required tests:**
- [ ] Happy path — create, read, update, list for each entity
- [ ] Tenant isolation — cross-tenant data inaccessible
- [ ] Search and filter — text search, status filter, date range
- [ ] Archive/restore — soft delete works correctly
- [ ] Connection error — graceful failure on db unavailable
- [ ] Concurrent writes — no data corruption on parallel inserts

---

### P0-020 — Postgres repositories — financial entities

> **Size:** M | **Layer:** Data | **AI Build:** High | **Human Review:** Heavy

**Dependencies:** P0-004, P0-005, P0-019

**Allowed files:** `packages/api/src/estimates/pg-*.ts, packages/api/src/invoices/pg-*.ts`

**Build prompt:** Create Postgres-backed repository implementations for Estimate, EstimateApproval, EstimateEditDelta, Invoice, and Payment entities. These handle money — all amounts must be stored and queried as integer cents. Status transitions must be atomic (use transactions). Partial payment arithmetic must be exact. The Estimate repo must handle line items as a JSONB column or normalized child table — match whichever approach the migration schema uses.

**Review prompt:** Verify all money is integer cents with no float conversion. Verify status transitions are atomic (within a transaction). Verify partial payment balance recalculation is correct. Verify line item storage matches schema migration. Check that estimate snapshot/revision queries are efficient.

**Automated checks:**
```bash
npx tsc --noEmit
npm test -- --grep "P0-020"
```

**Required tests:**
- [ ] Happy path — full estimate lifecycle (draft → sent → accepted)
- [ ] Happy path — full invoice lifecycle (draft → open → paid)
- [ ] Partial payment — arithmetic stays in integer cents
- [ ] Zero amount edge case
- [ ] Rounding boundary — tax calculation at basis point boundaries
- [ ] Status transition guard — invalid transitions rejected
- [ ] Tenant isolation — cross-tenant financial data inaccessible
- [ ] Concurrent payment — two payments on same invoice don't corrupt balance

---

### P0-021 — Postgres repositories — AI & conversation entities

> **Size:** M | **Layer:** Data | **AI Build:** High | **Human Review:** Heavy

**Dependencies:** P0-004, P0-005

**Allowed files:** `packages/api/src/conversations/pg-*.ts, packages/api/src/voice/pg-*.ts, packages/api/src/ai/pg-*.ts, packages/api/src/proposals/pg-*.ts`

**Build prompt:** Create Postgres-backed repository implementations for Conversation, Voice, AIRun, PromptVersion, DocumentRevision, and Proposal entities. Conversations must support message append (not full replace). Proposals must support idempotency key uniqueness constraint. AI runs must be append-only (immutable after creation). Voice recordings must store S3 references, not audio data.

**Review prompt:** Verify conversation message append is atomic. Verify proposal idempotency key is enforced at database level (unique constraint). Verify AI run records are immutable after insert. Verify voice records reference S3 paths, not binary data. Check query performance on conversation message listing (pagination).

**Automated checks:**
```bash
npx tsc --noEmit
npm test -- --grep "P0-021"
```

**Required tests:**
- [ ] Happy path — conversation create, add message, list messages
- [ ] Happy path — proposal lifecycle (create → approve → execute)
- [ ] Idempotency — duplicate proposal key rejected with conflict error
- [ ] AI run immutability — update after creation rejected
- [ ] Tenant isolation — cross-tenant conversations inaccessible
- [ ] Pagination — message list with offset/limit

---

### P0-022 — Postgres repositories — config & operational entities

> **Size:** M | **Layer:** Data | **AI Build:** High | **Human Review:** Heavy

**Dependencies:** P0-004, P0-005

**Allowed files:** `packages/api/src/settings/pg-*.ts, packages/api/src/verticals/pg-*.ts, packages/api/src/templates/pg-*.ts, packages/api/src/quality/pg-*.ts, packages/api/src/audit/pg-*.ts, packages/api/src/webhooks/pg-*.ts`

**Build prompt:** Create Postgres-backed repository implementations for Settings, PackActivation, VerticalPackRegistry, EstimateTemplate, ServiceBundle, QualityMetrics, Audit, and Webhook (idempotency) entities. Settings must support upsert (create if not exists, update if exists). Audit must be append-only. Webhook idempotency must use a unique constraint on event_id to prevent duplicate processing. Numbering sequences (estimate/invoice numbers) must use database sequences or SELECT FOR UPDATE to prevent gaps under concurrency.

**Review prompt:** Verify settings upsert is atomic. Verify audit records are immutable. Verify webhook event_id has unique constraint. Verify numbering sequences are gap-free under concurrent access. Check that vertical pack config queries are efficient (loaded once per request, cached if possible).

**Automated checks:**
```bash
npx tsc --noEmit
npm test -- --grep "P0-022"
```

**Required tests:**
- [ ] Happy path — settings create and update
- [ ] Upsert — settings created on first access, updated on subsequent
- [ ] Audit append-only — updates and deletes rejected
- [ ] Webhook idempotency — duplicate event_id rejected
- [ ] Numbering sequence — concurrent requests get unique sequential numbers
- [ ] Tenant isolation — cross-tenant settings inaccessible
- [ ] Pack activation — activate/deactivate vertical packs

---

### P0-023 — Wire Postgres pool in app.ts and replace all InMemory instantiations

> **Size:** S | **Layer:** Platform | **AI Build:** High | **Human Review:** Heavy

**Dependencies:** P0-019, P0-020, P0-021, P0-022

**Allowed files:** `packages/api/src/app.ts, packages/api/src/db/pool.ts`

**Build prompt:** Replace all 21 InMemory repository instantiations in `app.ts` (lines 101–122) with their Postgres-backed equivalents from P0-019 through P0-022. Initialize the database connection pool at startup using `packages/api/src/db/pool.ts`. Run migrations on startup (or verify they've been run). Pass the pool/client to each Postgres repository constructor. Ensure the InMemory queue is also replaced (or flagged for P0-028). Add a graceful shutdown handler that closes the pool on SIGTERM/SIGINT.

**Review prompt:** Verify all 21 InMemory repos are replaced — none remain. Verify pool is initialized before routes are registered. Verify graceful shutdown closes the pool. Verify migration check runs before accepting requests. Check that pool configuration (size, timeouts) is appropriate for production.

**Automated checks:**
```bash
npx tsc --noEmit
npm test -- --grep "P0-023"
grep -r "InMemory" packages/api/src/app.ts | grep -v "test" | wc -l  # Should be 0
```

**Required tests:**
- [ ] Integration test — API starts with real database connection
- [ ] Graceful shutdown — pool closed on SIGTERM
- [ ] Startup failure — clear error if DATABASE_URL missing
- [ ] Health check — /health returns database connectivity status

---

### P0-024 — RLS tenant context middleware

> **Size:** S | **Layer:** Security | **AI Build:** Medium | **Human Review:** Heavy

**Dependencies:** P0-023

**Allowed files:** `packages/api/src/middleware/**, packages/api/src/db/**`

**Build prompt:** Add Express middleware that runs after auth middleware and before route handlers. On every authenticated request, execute `SET LOCAL app.current_tenant_id = $1` within the request's database transaction/connection. This activates the RLS policies defined in the migration schema. Ensure the setting is LOCAL (transaction-scoped) so it doesn't leak between requests sharing a pooled connection. For unauthenticated routes (health check, public estimate approval), skip the RLS context.

**Review prompt:** Verify SET LOCAL is used (not SET) to prevent connection pool leaks. Verify RLS context is set BEFORE any repository query executes. Verify unauthenticated routes skip RLS. Verify that a missing tenant_id on an authenticated request returns 403, not a query error. Test that connection is returned to pool cleanly.

**Automated checks:**
```bash
npx tsc --noEmit
npm test -- --grep "P0-024"
```

**Required tests:**
- [ ] Happy path — RLS variable set for authenticated request
- [ ] Tenant isolation — query with wrong tenant returns empty results
- [ ] Pool safety — SET LOCAL doesn't leak to next request on same connection
- [ ] Unauthenticated routes — health check works without RLS
- [ ] Missing tenant — returns 403, not database error

---

### P0-025 — Implement bootstrapTenant() on Clerk user.created webhook

> **Size:** S | **Layer:** Auth | **AI Build:** Medium | **Human Review:** Heavy

**Dependencies:** P0-002, P0-004, P0-024

**Allowed files:** `packages/api/src/webhooks/**, packages/api/src/auth/**`

**Build prompt:** Implement the `bootstrapTenant()` function referenced in the TODO at `webhooks/routes.ts:88`. On `user.created` webhook event from Clerk: (1) Create a new tenant record in the tenants table. (2) Create a user record with role=owner linked to the tenant. (3) Create default tenant settings (timezone, prefixes, payment terms). (4) Write the tenant_id back to Clerk user metadata via the Clerk API. (5) Emit an audit event for the tenant creation. The entire operation must be idempotent — if the webhook fires twice, the second call should be a no-op.

**Review prompt:** Verify idempotency — duplicate webhook doesn't create duplicate tenant. Verify Clerk metadata is updated with tenant_id. Verify default settings are created. Verify audit event is emitted. Check that a partially failed bootstrap (e.g., Clerk API call fails after DB write) can be retried safely.

**Automated checks:**
```bash
npx tsc --noEmit
npm test -- --grep "P0-025"
```

**Required tests:**
- [ ] Happy path — user.created webhook creates tenant, user, settings
- [ ] Idempotency — duplicate webhook is a no-op
- [ ] Clerk metadata — tenant_id written back to Clerk
- [ ] Audit trail — tenant.created event logged
- [ ] Partial failure — retryable after Clerk API failure
- [ ] Invalid signature — webhook rejected

---

### P0-026 — Startup env validation and remove hardcoded dev-secret fallback

> **Size:** S | **Layer:** Platform | **AI Build:** High | **Human Review:** Moderate

**Dependencies:** P0-006

**Allowed files:** `packages/api/src/app.ts, packages/api/src/shared/env.ts`

**Build prompt:** Create a Zod schema for all required environment variables and validate at startup before initializing any services. Required vars: `DATABASE_URL`, `CLERK_SECRET_KEY`, `CLERK_PUBLISHABLE_KEY`, `CORS_ORIGIN` (must not be `true` in production), `NODE_ENV`. Optional with safe defaults: `PORT`, `LOG_LEVEL`. Remove the hardcoded `'dev-secret-key'` fallback at `app.ts:97` — throw a clear error if `CLERK_SECRET_KEY` is missing. In development mode (`NODE_ENV=development`), allow relaxed defaults. In production, fail fast on any missing required var.

**Review prompt:** Verify the `'dev-secret-key'` fallback is completely removed. Verify CORS_ORIGIN cannot be `true` in production. Verify all env vars listed in deployment docs are validated. Verify the error messages are clear and actionable (tell the operator exactly which var is missing).

**Automated checks:**
```bash
npx tsc --noEmit
npm test -- --grep "P0-026"
grep -r "dev-secret-key" packages/api/src/ | wc -l  # Should be 0
```

**Required tests:**
- [ ] Happy path — all vars present, server starts
- [ ] Missing CLERK_SECRET_KEY — throws with clear error
- [ ] Missing DATABASE_URL — throws with clear error
- [ ] CORS_ORIGIN=true in production — throws with clear error
- [ ] Development mode — relaxed defaults allowed
- [ ] Invalid DATABASE_URL format — throws with clear error

---

### P0-027 — Integrate real STT provider (OpenAI Whisper)

> **Size:** S | **Layer:** Voice | **AI Build:** Medium | **Human Review:** Heavy

**Dependencies:** P0-009, P0-012

**Allowed files:** `packages/api/src/voice/**, packages/api/src/workers/**`

**Build prompt:** Replace the hardcoded mock transcription provider in `app.ts:124-131` with a real OpenAI Whisper integration. Create a `WhisperTranscriptionProvider` that implements the existing `TranscriptionProvider` interface. It should: (1) Accept an S3 audio URL or buffer. (2) Call OpenAI's `/v1/audio/transcriptions` endpoint. (3) Return the transcript text. (4) Handle errors gracefully (timeout, rate limit, invalid audio). (5) Support configurable model (`whisper-1`). Guard the provider — if `OPENAI_API_KEY` is missing, fall back to a no-op provider that logs a warning (not the mock that returns fake data).

**Review prompt:** Verify the mock hardcoded string is removed from app.ts. Verify the Whisper API call uses proper auth. Verify error handling for network failures, rate limits, and invalid audio. Verify the fallback when OPENAI_API_KEY is missing logs a warning rather than silently returning fake data. Check audio file size limits.

**Automated checks:**
```bash
npx tsc --noEmit
npm test -- --grep "P0-027"
```

**Required tests:**
- [ ] Happy path — audio file transcribed via Whisper (mock HTTP in test)
- [ ] Error handling — network timeout returns error, not fake transcript
- [ ] Rate limit — 429 response handled with retry hint
- [ ] Invalid audio — clear error message
- [ ] Missing API key — no-op provider with logged warning
- [ ] Large file — files over 25MB rejected with clear error

---

### P0-028 — Replace InMemory queue with SQS worker integration

> **Size:** S | **Layer:** Workers | **AI Build:** Medium | **Human Review:** Moderate

**Dependencies:** P0-009

**Allowed files:** `packages/api/src/queues/**, packages/api/src/workers/**`

**Build prompt:** Replace the `InMemoryQueue` in `app.ts` with an SQS-backed queue that uses the existing CDK `QueueStack` infrastructure. Create an `SqsQueue` class implementing the same `Queue` interface. Messages should be sent via the AWS SDK SQS client. Create a worker process (or in-process poller) that receives messages from the queue and dispatches to the existing worker registry. Include dead-letter queue handling. In development mode, allow fallback to InMemory queue for local development without AWS credentials.

**Review prompt:** Verify SQS queue URL is configured via environment variable. Verify message visibility timeout is appropriate. Verify dead-letter queue is configured. Verify worker handles message processing failures (nack/retry). Check that development fallback is safe and logged.

**Automated checks:**
```bash
npx tsc --noEmit
npm test -- --grep "P0-028"
```

**Required tests:**
- [ ] Happy path — message enqueued and processed
- [ ] Worker failure — message returns to queue after visibility timeout
- [ ] Dead letter — message moved to DLQ after max retries
- [ ] Development fallback — InMemory queue used when SQS_QUEUE_URL missing
- [ ] Graceful shutdown — worker stops accepting messages on SIGTERM

---

### P0-029 — Frontend Clerk SDK integration

> **Size:** S | **Layer:** Auth/UI | **AI Build:** High | **Human Review:** Heavy

**Dependencies:** P0-002

**Allowed files:** `packages/web/src/App.tsx, packages/web/src/components/auth/**, packages/web/src/components/layout/**`

**Build prompt:** Install `@clerk/clerk-react` and wrap the application in `<ClerkProvider>`. Replace the fake `LoginPage` (which uses `setTimeout` to simulate login) with Clerk's `<SignIn>` component. Replace the hardcoded "Mike Ortega" user in the Shell with real user data from `useUser()`. Add `<SignUp>` for registration. Replace the demo account quick-login with Clerk's actual sign-in flow. The `VITE_CLERK_PUBLISHABLE_KEY` env var must be required at build time.

**Review prompt:** Verify the setTimeout fake login is completely removed. Verify the hardcoded "Mike Ortega" is replaced with real user data. Verify ClerkProvider wraps the entire app. Verify the publishable key is sourced from environment, not hardcoded. Check that sign-out works and clears state.

**Automated checks:**
```bash
npx tsc --noEmit
npm test -- --grep "P0-029"
grep -r "setTimeout" packages/web/src/components/auth/LoginPage.tsx | wc -l  # Should be 0
grep -r "Mike Ortega" packages/web/src/ | wc -l  # Should be 0
```

**Required tests:**
- [ ] Happy path — Clerk sign-in renders
- [ ] Sign-out — user data cleared, redirected to login
- [ ] Missing publishable key — clear build error
- [ ] User data — Shell displays real user name and avatar

---

### P0-030 — Auth headers in frontend API client hooks

> **Size:** S | **Layer:** Auth/UI | **AI Build:** High | **Human Review:** Moderate

**Dependencies:** P0-029

**Allowed files:** `packages/web/src/hooks/**, packages/web/src/lib/**`

**Build prompt:** Update `useListQuery`, `useDetailQuery`, and `useMutation` hooks to include the Clerk JWT token in the `Authorization: Bearer <token>` header on every API request. Use Clerk's `useAuth()` hook to get `getToken()`. Requests made without a valid token (e.g., during sign-out transition) should be cancelled, not sent unauthenticated. Handle 401 responses by redirecting to the sign-in page.

**Review prompt:** Verify every API call includes the Authorization header. Verify 401 responses trigger redirect to login. Verify token refresh is handled (Clerk manages this, but verify getToken() is called per-request, not cached stale). Check that public endpoints (estimate approval, payment page) do NOT send auth headers.

**Automated checks:**
```bash
npx tsc --noEmit
npm test -- --grep "P0-030"
```

**Required tests:**
- [ ] Happy path — API request includes Bearer token
- [ ] 401 response — redirects to sign-in
- [ ] No token — request is cancelled, not sent unauthenticated
- [ ] Public routes — estimate approval page works without auth

---

### P0-031 — Protected route guards

> **Size:** S | **Layer:** Auth/UI | **AI Build:** High | **Human Review:** Light

**Dependencies:** P0-029

**Allowed files:** `packages/web/src/App.tsx, packages/web/src/components/auth/**`

**Build prompt:** Create a `<ProtectedRoute>` wrapper component that checks authentication status via Clerk's `useAuth()`. If the user is not signed in, redirect to `/login`. Wrap all internal routes (dashboard, jobs, estimates, invoices, customers, dispatch, settings, etc.) with this guard. Leave public routes unguarded: `/login`, `/signup`, `/e/:id` (estimate approval), `/pay/:id` (payment), `/intake`. Show a loading spinner while Clerk is initializing (not a flash of login page).

**Review prompt:** Verify all internal routes are guarded. Verify public routes remain accessible. Verify no flash of login page during Clerk initialization. Check deep link preservation — user navigating to `/estimates/123` while unauthenticated should land there after sign-in.

**Automated checks:**
```bash
npx tsc --noEmit
npm test -- --grep "P0-031"
```

**Required tests:**
- [ ] Unauthenticated — redirects to /login
- [ ] Authenticated — renders protected content
- [ ] Public routes — accessible without auth
- [ ] Deep link — preserved through sign-in redirect
- [ ] Loading state — spinner during Clerk init, not login flash

---

### P0-032 — Global error boundary and Sonner toast provider

> **Size:** S | **Layer:** UI | **AI Build:** High | **Human Review:** Light

**Dependencies:** None

**Allowed files:** `packages/web/src/App.tsx, packages/web/src/components/layout/**, packages/web/src/hooks/**`

**Build prompt:** Add a React error boundary component at the top level of the app (in App.tsx) that catches render errors and displays a user-friendly fallback UI with a "Reload" button. Wire the already-installed `sonner` toast library by adding `<Toaster>` to the app layout. Update the `useMutation` hook to show success/error toasts on mutation results. Add toast notifications for common actions: customer created, estimate saved, invoice sent, appointment scheduled. Ensure toasts are accessible (proper ARIA roles).

**Review prompt:** Verify error boundary catches render errors and shows fallback. Verify Sonner Toaster is mounted. Verify mutation hooks show toasts. Check that error boundary doesn't swallow errors silently — errors should still be logged to console/Sentry.

**Automated checks:**
```bash
npx tsc --noEmit
npm test -- --grep "P0-032"
```

**Required tests:**
- [ ] Error boundary — render error shows fallback UI
- [ ] Error boundary — reload button works
- [ ] Toast — mutation success shows success toast
- [ ] Toast — mutation error shows error toast
- [ ] Toast — accessible ARIA roles present

---

### P0-033 — Clerk session verification — RS256 + JWKS

> **Size:** M | **Layer:** Platform | **AI Build:** Medium | **Human Review:** Heavy

**Dependencies:** P0-026

**Allowed files:** `packages/api/src/auth/clerk.ts, packages/api/src/auth/dev-auth-bypass.ts, packages/api/src/auth/clerk.test.ts, packages/api/src/shared/env.ts`

**Build prompt:** Replace the current HMAC-SHA256 verification in `verifyClerkSession` (`auth/clerk.ts:85-90`) with proper RS256 verification using Clerk's published JWKS. Real Clerk session tokens are signed RS256, so HMAC verification will reject every legitimate production session — only the dev bypass and synthetic HMAC dev-tokens currently work. Implementation: (1) Use `jose` (already a transitive dep via Clerk) or add `jsonwebtoken` + `jwks-rsa` to fetch and cache JWKS from `https://{frontend_api_host}/.well-known/jwks.json`. The frontend API host is encoded in the Clerk publishable key. (2) Verify `iss`, `aud` (or `azp`), `exp`, `nbf`. (3) Cache JWKS for 10 minutes; refresh on `kid` miss. (4) Preserve the existing dev-only HMAC path behind an explicit `CLERK_DEV_HMAC_TOKENS=true` env flag — DEFAULT OFF in production. (5) Update `dev-auth-bypass.ts` to remove the comment claiming HMAC is the only path; document that `DEV_AUTH_BYPASS=true` skips verification entirely and must remain off in prod. Maintain the existing return shape (`{ userId, tenantId, role }`).

**Review prompt:** Verify production tokens (signed RS256 by Clerk) verify successfully against a test JWKS fixture. Verify token tampering / wrong `kid` / expired tokens are rejected. Verify HMAC dev path only activates when `CLERK_DEV_HMAC_TOKENS=true`. Verify JWKS cache TTL and refresh-on-miss behavior. Verify `iss` is checked against the configured Clerk frontend API. Confirm `validateProductionConfig` rejects `CLERK_DEV_HMAC_TOKENS=true` in production.

**Automated checks:**
```bash
cd packages/api && npx tsc --project tsconfig.build.json --noEmit
npm test --workspace=packages/api -- --run --grep "P0-033|verifyClerkSession"
```

**Required tests:**
- [ ] Happy path — valid RS256 token verifies (test JWKS server)
- [ ] Wrong signature — rejected
- [ ] Expired token — rejected
- [ ] Wrong issuer — rejected
- [ ] `kid` not in JWKS — refresh once, then reject if still missing
- [ ] HMAC dev path active only with `CLERK_DEV_HMAC_TOKENS=true`
- [ ] HMAC dev path rejected in production env
- [ ] JWKS cache hit (no second HTTP fetch within TTL)

---

### P0-034 — Feature-flag admin authority — platform-admin gate

> **Size:** S | **Layer:** Platform | **AI Build:** High | **Human Review:** Heavy

**Dependencies:** None

**Allowed files:** `packages/api/src/routes/feature-flags.ts, packages/api/src/routes/feature-flags.test.ts, packages/api/src/auth/rbac.ts, packages/api/src/auth/platform-admin.ts, packages/api/src/auth/platform-admin.test.ts, packages/api/src/db/schema.ts, packages/api/scripts/grant-platform-admin.ts`

**Build prompt:** The feature-flag admin endpoints in `routes/feature-flags.ts:39,55,75,100` gate on `requireRole('owner')`, which is a per-tenant role — meaning **any tenant owner can mutate global feature flags**, escalating their authority beyond their tenant. Implement a true platform-admin authorization layer: (1) Add `platform_admins` table (migration 046): `(user_id UUID PRIMARY KEY, granted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), granted_by UUID NOT NULL, notes TEXT)` — NOT tenant-scoped, no RLS. (2) Add `requirePlatformAdmin` middleware in `auth/platform-admin.ts` that checks the authenticated user against the `platform_admins` table. Return 403 if not present. (3) Replace `requireRole('owner')` with `requirePlatformAdmin` in all four feature-flag admin routes. (4) Add a CLI seed script (`packages/api/scripts/grant-platform-admin.ts`) that takes a Clerk user id and inserts into the table — for bootstrap. (5) Audit every grant/revoke via the existing audit module with `actor_type='platform'`. Per-tenant feature flag READS may still be done by tenant owners — only WRITES to the global registry require platform-admin.

**Review prompt:** Verify all four admin routes (GET, GET/:name, PUT, DELETE) require platform-admin. Verify a non-platform-admin tenant owner gets 403. Verify the seed script is idempotent. Verify the grant/revoke audit rows include `actor_type='platform'`. Verify there's no platform-admin claim in the JWT (DB lookup is the source of truth — JWT cannot be forged into platform-admin). Confirm migration is reservation-safe (`046_*`).

**Automated checks:**
```bash
cd packages/api && npx tsc --project tsconfig.build.json --noEmit
npm test --workspace=packages/api -- --run --grep "P0-034|requirePlatformAdmin|feature-flags"
```

**Required tests:**
- [ ] Tenant owner without platform-admin row → 403 on PUT
- [ ] Tenant owner without platform-admin row → 403 on DELETE
- [ ] Platform admin → 200 on PUT
- [ ] Platform admin → 200 on DELETE
- [ ] Tenant owner can still READ (if read access is open by design)
- [ ] Grant emits audit row with `actor_type='platform'`
- [ ] Revoke emits audit row
- [ ] Migration applies cleanly + RLS NOT applied to `platform_admins` (intentionally cross-tenant)
