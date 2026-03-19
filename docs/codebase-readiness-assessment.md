# ServiceOS — Codebase Readiness Assessment

## Context

Full audit of the ServiceOS codebase to determine what's production-ready, what's stubbed, what's missing, and what must be done to ship. The codebase is a multi-tenant field-service management platform with AI assistant capabilities, built as a monorepo (`infra/`, `packages/api`, `packages/web`, `packages/shared`).

---

## Overall Verdict: ~60% Launch-Ready

The **architecture and scaffolding are excellent** — strict TypeScript, RLS, audit trails, CDK infra, CI/CD, Zod contracts, structured logging. But the runtime is not connected to its own database, auth is stubbed on the frontend, and AI features are demo-only. This is a high-quality prototype, not yet a production system.

---

## LAUNCH BLOCKERS (Must fix before any real users)

### 1. All Data Lives In-Memory (CRITICAL)
- `packages/api/src/app.ts` instantiates **21 InMemoryRepository** instances (customers, jobs, invoices, appointments, estimates, payments, etc.)
- **Data is lost on every restart.** Zero durability.
- The DB layer is *ready but disconnected*:
  - `packages/api/src/db/schema.ts` — 30+ migrations defined
  - `packages/api/src/db/pool.ts` — connection pool implemented
  - `packages/api/src/db/migrate.ts` — migration runner ready
  - RLS policies defined in migrations
- **Work needed:** Create Postgres-backed repository implementations for all 21 repos and wire them in `app.ts`.

### 2. Frontend Auth is Fake (CRITICAL)
- `packages/web` LoginPage uses `setTimeout()` to simulate login — no real auth
- Hardcoded user "Mike Ortega" throughout the shell
- No Clerk SDK imports, no `useAuth()`/`useUser()` hooks, no JWT handling
- All routes publicly accessible — no auth guards
- **Backend auth is implemented** (Clerk JWT verification, RBAC middleware) but frontend never sends tokens
- **Work needed:** Integrate Clerk React SDK, wire auth to API calls, add route guards.

### 3. Clerk Webhook Tenant Bootstrap Incomplete (CRITICAL)
- `packages/api/src/webhooks/routes.ts:88` — explicit TODO:
  ```
  // TODO: call bootstrapTenant() and write tenant_id back to Clerk
  ```
- Webhook signature verification works, but new signups don't create tenants
- `bootstrapTenant()` function doesn't exist yet
- **Work needed:** Implement tenant provisioning on `user.created` event.

### 4. Hardcoded Dev Secret in Production Path (CRITICAL)
- `packages/api/src/app.ts:97`:
  ```typescript
  const clerkSecret = process.env.CLERK_SECRET_KEY || 'dev-secret-key';
  ```
- If env var is missing in prod, API accepts any JWT — total auth bypass
- **Work needed:** Throw on missing required env vars in production.

---

## HIGH-PRIORITY GAPS (Must fix for credible beta)

### 5. AI Assistant is Demo-Only
- `packages/web` AssistantPage has hardcoded `AI_REPLIES` bank (lines 57–153) — not connected to LLM
- Voice recorder selects from 4 mock transcript strings — no real audio processing
- Backend AI gateway is fully implemented (`packages/api/src/ai/gateway/`) with provider routing, failover, caching — but frontend doesn't call it for chat
- **Work needed:** Wire frontend conversation flow to backend AI gateway endpoints.

### 6. Voice/STT Pipeline is a Stub
- `packages/api/src/app.ts:124-131` — transcription provider returns hardcoded string:
  ```typescript
  return { transcript: `Transcribed audio from ${audioUrl}` }
  ```
- Decision doc exists (`docs/voice-production-readiness.md`) but no provider chosen
- SQS queue infra is ready (CDK QueueStack deployed)
- **Work needed:** Integrate real STT provider (OpenAI Whisper, Azure, Google Speech).

### 7. Mock Payment Provider in Production Code
- `packages/api/src/payments/payment-link-provider.ts` — `MockPaymentLinkProvider` generates URLs like `https://pay.mock.com/...`
- Exported from main index alongside real provider interfaces
- **Work needed:** Integrate Stripe (or chosen provider), guard against mock in prod config.

### 8. Settings Page is All Stubs
- Every settings item has `action: () => {}` — empty handlers
- Business profile, team management, terminology, integrations — none functional
- QuickBooks, Zapier, Google Calendar integration modals exist with no backends
- **Work needed:** Implement settings persistence (at minimum: business profile, team management).

### 9. No E2E Tests
- 162 test files exist (strong unit/component coverage, Vitest + Testing Library + MSW)
- Coverage thresholds configured (70-95% by module)
- **Zero Playwright/Cypress E2E tests** — no critical user journey validation
- **Work needed:** At minimum, E2E for signup → create customer → create estimate → send → approve flow.

---

### 9a. Frontend Missing Global Error Boundary & Toast Notifications
- `sonner` (toast library) is installed but not wired up anywhere
- No React error boundary wrapping the app
- Loading states are inconsistent — present on HomePage but missing on LeadsPage, CustomersPage
- **Work needed:** Add `<ErrorBoundary>` in App.tsx, integrate Sonner for mutation feedback.

### 9b. Frontend Payment Page Has No Real Stripe Integration
- `InvoicePaymentPage` (`/pay/:id`) has card/ACH/bank entry UI but no Stripe SDK
- No `@stripe/react-stripe-js` or `@stripe/stripe-js` imports found
- Form captures card data but doesn't process it
- **Work needed:** Integrate Stripe Elements for PCI-compliant payment capture.

### 9c. Installed But Unused Libraries
- `react-hook-form` — installed, not used (all forms are manual `useState`)
- `recharts` — installed, not used in any visible page
- These add bundle weight with no benefit
- **Fix:** Either integrate or remove.

---

## MEDIUM-PRIORITY ISSUES (Should fix, won't block a careful beta)

### 10. Environment Variable Validation
- Multiple fallbacks to localhost/dev defaults throughout `app.ts` and `connection.ts`
- CORS_ORIGIN falls back to `true` (allow all origins)
- No startup validation that required vars exist
- **Fix:** Add env validation at startup (Zod schema for env).

### 11. Deprecated/Vulnerable Dependencies
- `package-lock.json` flags: old `glob` (security vulns), deprecated `async` (memory leaks), outdated `superagent`
- **Fix:** `npm audit fix`, update transitive deps.

### 12. `as any` Type Escapes (8 instances)
- `packages/web/src/components/dispatch/useCreateScheduleProposal.test.ts` (4x)
- `packages/api/src/verticals/registry.ts:45`
- `packages/api/src/proposals/execution/reschedule-handler.ts`
- `packages/api/src/routes/notes.ts`, `packages/api/src/routes/jobs.ts`

### 13. InMemory Webhook Repository
- `packages/api/src/webhooks/routes.ts:9` — idempotency tracking lost on restart
- Duplicate Clerk events could double-process

### 14. No Rollback Strategy Documented
- Railway deploy pipeline exists (dev → staging → prod)
- No documented rollback procedure

---

## WHAT'S ACTUALLY WORKING WELL

| Area | Status | Details |
|------|--------|---------|
| **CDK Infrastructure** | 95% ready | 5 stacks, proper env configs, scoped IAM, no wildcards |
| **Database Schema** | 95% ready | 30+ migrations, RLS, audit tables, indexes |
| **API Route Coverage** | 90% | 16 route modules, full CRUD for all entities |
| **Backend Auth/RBAC** | 95% | Clerk JWT verification, 3 roles, 60+ permissions |
| **AI Gateway** | 100% | Provider routing, failover, caching, health checks |
| **Billing Engine** | 100% | Integer cents, tax in bps, discounts, line items |
| **Frontend Routes** | 100% | 13 pages + 3 customer-facing flows, all wired |
| **Frontend API Hooks** | 95% | `useListQuery`, `useDetailQuery`, `useMutation` — real HTTP |
| **CI/CD Pipeline** | 100% | GitHub Actions: typecheck, lint, test, coverage, migration dry-run |
| **Shared Contracts** | 95% | 40+ enums, Zod schemas throughout |
| **Logging/Error Handling** | 90% | Structured JSON, correlation IDs, global error handler |
| **Component Tests** | Good | ~61 test files in web, solid component coverage |
| **Frontend UI/UX** | 85% | Polished dashboard, responsive mobile nav, 30+ shadcn components |
| **Frontend Routing** | 100% | React Router v7, 13 pages + 3 customer-facing flows, deep links work |
| **Mobile Responsiveness** | 90% | Bottom tab nav, responsive grids, proper breakpoints |

---

## ONE-WEEK LAUNCH PLAN (Aggressive but possible for limited beta)

### Days 1-3: Data Persistence (the big one)
- Implement Postgres-backed repositories for all 21 entities
- Wire them in `app.ts` instead of InMemory instances
- Run migration suite against real database
- Validate RLS policies work end-to-end
- **Key files:** `packages/api/src/app.ts`, new `packages/api/src/*/pg-*.repository.ts` files

### Day 3-4: Auth End-to-End
- Integrate Clerk React SDK in `packages/web`
- Add auth headers to all API calls
- Implement route guards (redirect to /login if unauthenticated)
- Implement `bootstrapTenant()` in webhook handler
- Remove hardcoded fallback secrets
- **Key files:** `packages/web/src/App.tsx`, `packages/web/src/lib/api.ts`, `packages/api/src/webhooks/routes.ts`, `packages/api/src/app.ts`

### Day 4-5: AI & Voice (minimum viable)
- Connect frontend AssistantPage to backend conversation/AI endpoints
- Integrate one real STT provider (OpenAI Whisper recommended — simplest)
- Replace mock AI replies with real gateway calls
- **Key files:** `packages/web/src/pages/AssistantPage.tsx`, `packages/api/src/app.ts` (transcription provider)

### Day 5-6: Production Hardening
- Env var validation at startup (fail fast on missing required vars)
- Remove/guard mock providers (payment, LLM) from prod config
- Fix CORS to specific origins only
- `npm audit fix`
- Settings page: implement at least business profile save

### Day 6-7: Testing & Staging Validation
- Deploy to staging environment
- Manual smoke test of critical flows
- Fix any integration issues
- Write 2-3 E2E tests for core flows
- Load test with realistic data

---

## FILES TO MODIFY (Critical Path)

```
# Data persistence (Day 1-3)
packages/api/src/app.ts                          # Replace 21 InMemory repos
packages/api/src/customers/pg-customer.repo.ts   # New (×21 entities)
packages/api/src/db/pool.ts                      # Already exists, wire in

# Auth (Day 3-4)
packages/web/src/App.tsx                          # Clerk provider wrapper
packages/web/src/pages/LoginPage.tsx              # Real Clerk auth
packages/web/src/lib/api.ts                       # Auth headers
packages/api/src/webhooks/routes.ts               # bootstrapTenant()
packages/api/src/app.ts                           # Remove fallback secret

# AI/Voice (Day 4-5)
packages/web/src/pages/AssistantPage.tsx           # Real AI integration
packages/api/src/app.ts                            # Real STT provider

# Hardening (Day 5-6)
packages/api/src/app.ts                            # Env validation
packages/api/src/payments/payment-link-provider.ts # Guard mock
packages/web/src/pages/SettingsPage.tsx             # Basic persistence
```

---

## Verification Plan

1. **Data persistence:** Create a customer via API, restart the server, verify customer persists
2. **Auth:** Sign up via Clerk, verify tenant created, verify JWT required for all API calls
3. **AI:** Send a message in assistant, verify real LLM response (not hardcoded)
4. **Voice:** Upload audio, verify real transcript returned
5. **E2E:** Run Playwright test: signup → create customer → create estimate → send → customer approves
6. **Load:** Simulate 50 concurrent users against staging
7. **RLS:** Verify tenant A cannot see tenant B's data via API
