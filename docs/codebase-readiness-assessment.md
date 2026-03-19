# ServiceOS — Codebase Readiness Assessment

## Context

Full audit of the ServiceOS codebase against all 184 user stories (Phases 0–7) to determine what's production-ready, what's stubbed, what's missing, and what must be done to ship. The codebase is a multi-tenant field-service management platform with AI assistant capabilities, built as a monorepo (`infra/`, `packages/api`, `packages/web`, `packages/shared`).

**Assessment date:** 2026-03-19
**Codebase size:** ~21,700 lines API source + ~15,000 lines web source + 205 test files

---

## Overall Verdict: ~65% Built, ~30% Launch-Ready

The **architecture and business logic are excellent** — strict TypeScript, RLS policies, audit trails, CDK infra, CI/CD, Zod contracts, structured logging, billing engine, proposal engine, AI gateway. But the runtime is disconnected from its own infrastructure: all 21 repositories are InMemory (zero persistence), frontend auth is a setTimeout fake, AI features are demo-only with hardcoded replies, and the payment page doesn't process real payments. This is a high-quality prototype with production-grade design, not yet a production system.

**36 gap stories** have been created across all 8 phases to close the remaining work. See `docs/stories/phase-*-gap-stories.md`.

---

## Story Completion by Phase

| Phase | Original Stories | Code Exists | Wired & Working | New Gap Stories | Total Remaining |
|-------|-----------------|-------------|-----------------|-----------------|-----------------|
| **P0 — Platform Foundation** | 18 | 17/18 | ~12/18 | 14 | ~20 |
| **P1 — Core Business Entities** | 24 | 24/24 | ~8/24 | 4 | ~20 |
| **P2 — Proposal Engine + AI Safety** | 27 | 25/27 | ~18/27 | 2 | ~11 |
| **P3 — Conversation + Voice** | 15 | 10/15 | ~3/15 | 4 | ~16 |
| **P4 — Vertical Packs + Estimate Intelligence** | 26 | 22/26 | ~18/26 | 2 | ~10 |
| **P5 — Invoice Intelligence + Payments** | 29 | 18/29 | ~10/29 | 4 | ~23 |
| **P6 — Dispatch Board + Scheduling** | 27 | 15/27 | ~8/27 | 3 | ~22 |
| **P7 — Integrations + Beta Hardening** | 18 | 2/18 | ~0/18 | 7 | ~25 |
| **TOTAL** | **184** | **133/184** | **~77/184** | **36** | **~143** |

**Key:** "Code Exists" = files with real logic present. "Wired & Working" = connected end-to-end, would function with a real database. "Total Remaining" = original stories not working + new gap stories.

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
- **Gap stories:** P0-019 through P0-024 (Postgres repos + wiring + RLS middleware)

### 2. Frontend Auth is Fake (CRITICAL)
- `packages/web` LoginPage uses `setTimeout()` to simulate login — no real auth
- Hardcoded user "Mike Ortega" throughout the shell
- No Clerk SDK imports, no `useAuth()`/`useUser()` hooks, no JWT handling
- All routes publicly accessible — no auth guards
- **Backend auth is implemented** (Clerk JWT verification, RBAC middleware) but frontend never sends tokens
- **Gap stories:** P0-029, P0-030, P0-031

### 3. Clerk Webhook Tenant Bootstrap Incomplete (CRITICAL)
- `packages/api/src/webhooks/routes.ts:88` — explicit TODO:
  ```
  // TODO: call bootstrapTenant() and write tenant_id back to Clerk
  ```
- Webhook signature verification works, but new signups don't create tenants
- `bootstrapTenant()` function doesn't exist yet
- **Gap story:** P0-025

### 4. Hardcoded Dev Secret in Production Path (CRITICAL)
- `packages/api/src/app.ts:97`:
  ```typescript
  const clerkSecret = process.env.CLERK_SECRET_KEY || 'dev-secret-key';
  ```
- If env var is missing in prod, API accepts any JWT — total auth bypass
- **Gap story:** P0-026

---

## HIGH-PRIORITY GAPS (Must fix for credible beta)

### 5. AI Assistant is Demo-Only
- `packages/web` AssistantPage has hardcoded `AI_REPLIES` bank (lines 57–153) — not connected to LLM
- Voice recorder selects from 4 mock transcript strings — no real audio processing
- Backend AI gateway is fully implemented (`packages/api/src/ai/gateway/`) with provider routing, failover, caching — but frontend doesn't call it
- **Gap stories:** P2-032, P3-016, P3-017

### 6. Voice/STT Pipeline is a Stub
- `packages/api/src/app.ts:124-131` — transcription provider returns hardcoded string:
  ```typescript
  return { transcript: `Transcribed audio from ${audioUrl}` }
  ```
- Decision doc exists (`docs/voice-production-readiness.md`) but no provider integrated
- SQS queue infra is ready (CDK QueueStack deployed)
- **Gap stories:** P0-027, P3-017

### 7. Mock Payment Provider in Production Code
- `packages/api/src/payments/payment-link-provider.ts` — `MockPaymentLinkProvider` generates URLs like `https://pay.mock.com/...`
- InvoicePaymentPage captures card data but processes with `setTimeout` — no Stripe SDK
- **Gap stories:** P5-016, P5-017

### 8. Settings Page is All Stubs
- Every settings item has `action: () => {}` — empty handlers
- Business profile, team management, terminology, integrations — none functional
- QuickBooks, Zapier, Google Calendar integration modals exist with no backends
- **Gap stories:** P1-020, P1-021, P4-014

### 9. Dispatch Board Drag-and-Drop Not Wired
- TechnicianLane and AppointmentCard have `draggable=true` and `onDragStart` handlers
- DispatchBoard parent does NOT implement `onDrop` or create proposals from drops
- **Gap story:** P6-025

### 10. No E2E Tests
- 152 API test files + 53 web component test files (strong unit/component coverage)
- Coverage thresholds configured (70-95% by module)
- **Zero Playwright/Cypress E2E tests** — no critical user journey validation
- **Gap story:** P7-019

### 11. Frontend Missing Global Error Boundary & Toast Notifications
- `sonner` (toast library) is installed but Toaster component is barely used
- No React error boundary wrapping the app
- Loading states are inconsistent across pages
- **Gap story:** P0-032

---

## MEDIUM-PRIORITY ISSUES

### 12. Environment Variable Validation
- Multiple fallbacks to localhost/dev defaults throughout `app.ts` and `connection.ts`
- CORS_ORIGIN falls back to `true` (allow all origins)
- No startup validation that required vars exist
- **Gap story:** P0-026

### 13. Deprecated/Vulnerable Dependencies
- `package-lock.json` flags: old `glob` (security vulns), deprecated `async` (memory leaks), outdated `superagent`
- **Gap story:** P7-020

### 14. `as any` Type Escapes (8 instances)
- `packages/web/src/components/dispatch/useCreateScheduleProposal.test.ts` (4x)
- `packages/api/src/verticals/registry.ts:45`
- `packages/api/src/proposals/execution/reschedule-handler.ts`
- `packages/api/src/routes/notes.ts`, `packages/api/src/routes/jobs.ts`
- **Gap story:** P7-024

### 15. InMemory Webhook Repository
- `packages/api/src/webhooks/routes.ts:9` — idempotency tracking lost on restart
- Duplicate Clerk events could double-process
- **Covered by:** P0-022 (Postgres webhook repo)

### 16. Installed But Unused Libraries
- `react-hook-form` — installed, not used (all forms are manual `useState`)
- `recharts` — installed, not used in any visible page
- **Gap story:** P7-021

### 17. No Rollback Strategy Documented
- Railway deploy pipeline exists (dev → staging → prod)
- No documented rollback procedure
- **Gap story:** P7-022

---

## WHAT'S ACTUALLY WORKING WELL

| Area | Status | Details |
|------|--------|---------|
| **CDK Infrastructure** | 95% ready | 5 stacks, proper env configs, scoped IAM, no wildcards |
| **Database Schema** | 95% ready | 30+ migrations, RLS, audit tables, indexes |
| **API Route Coverage** | 90% | 16 route modules, full CRUD for all entities |
| **Backend Auth/RBAC** | 95% | Clerk JWT verification, 3 roles, 61 permissions |
| **AI Gateway** | 100% | Provider routing, failover, caching, health checks — 35+ files, 3,100+ lines |
| **Proposal Engine** | 95% | 10 proposal types, typed contracts, execution handlers, idempotency — 21 files, 1,700 lines |
| **Billing Engine** | 100% | Integer cents, tax in bps, discounts, line items |
| **Vertical Packs** | 90% | HVAC + plumbing terminology, categories, templates, bundles, context assembly |
| **Estimate Logic** | 95% | Full lifecycle, approvals, revisions, edit deltas, analytics — 14 files, 2,500+ lines |
| **Invoice Logic** | 90% | Full lifecycle, payment tracking, proposal validation — 9 files, 1,000+ lines |
| **Stripe Webhooks** | 85% | Webhook handler, payment reconciliation, payment audit — needs frontend |
| **Frontend Routes** | 100% | 13 pages + 3 customer-facing flows, all wired |
| **Frontend API Hooks** | 95% | `useListQuery`, `useDetailQuery`, `useMutation` — real HTTP fetch |
| **CI/CD Pipeline** | 100% | GitHub Actions: typecheck, lint, test, coverage, migration dry-run |
| **Shared Contracts** | 95% | 40+ enums, Zod schemas throughout |
| **Logging/Error Handling** | 90% | Structured JSON, correlation IDs, global error handler |
| **Unit/Component Tests** | Good | 152 API test files + 53 web test files |
| **Frontend UI/UX** | 85% | Polished dashboard, responsive mobile nav, 30+ shadcn components |
| **Mobile Responsiveness** | 90% | Bottom tab nav, responsive grids, proper breakpoints |

---

## DETAILED MODULE STATUS

### Backend (`packages/api/src/` — 21,700 lines)

| Module | Files | Lines | Logic Quality | Persistence | Status |
|--------|-------|-------|---------------|-------------|--------|
| customers/ | 2 | 370 | Production | InMemory | Needs Pg repo |
| locations/ | 2 | 250 | Production | InMemory | Needs Pg repo |
| jobs/ | 2 | 330 | Production | InMemory | Needs Pg repo |
| appointments/ | 4 | 480 | Production | InMemory | Needs Pg repo |
| estimates/ | 14 | 2,500+ | Production-grade | InMemory | Needs Pg repo |
| invoices/ | 9 | 1,000+ | Production | InMemory | Needs Pg repo |
| proposals/ | 21 | 1,700 | Production-grade | InMemory | Needs Pg repo |
| conversations/ | 5 | 600 | Production | InMemory | Needs Pg repo |
| voice/ | 1 | 100 | Stub | InMemory | Needs real STT + Pg repo |
| ai/ | 35+ | 3,100+ | Production-grade | InMemory | Needs Pg repo |
| verticals/ | 11 | 500+ | Production | InMemory | Needs Pg repo |
| templates/ | 1 | 220 | Production | InMemory | Needs Pg repo |
| settings/ | 2 | 460 | Production | InMemory | Needs Pg repo |
| audit/ | 1 | 82 | Production | InMemory | Needs Pg repo |
| notes/ | 1 | 150 | Production | InMemory | Needs Pg repo |
| quality/ | 1 | 225 | Production | InMemory | Needs Pg repo |
| payments/ | 6 | 500+ | Production (Stripe) | Mixed | Backend OK, frontend needs work |
| routes/ | 16 | 2,600 | Production | N/A | Working |
| auth/ | 2 | 370 | Production | N/A | Working (backend only) |
| webhooks/ | 2 | 230 | Production | InMemory | Needs Pg idempotency repo |
| db/ | 5 | 1,100 | Production | Real Postgres | Ready but unused |
| shared/ | 11 | 2,600 | Production | N/A | Working |
| queues/ | 1 | 130 | Stub | InMemory | Needs SQS integration |
| dispatch/ | 4 | 510 | Production | InMemory | Needs Pg repo |
| availability/ | 2 | 220 | Skeleton | InMemory | Needs Pg repo |

### Frontend (`packages/web/src/` — ~15,000 lines)

| Area | Status | Details |
|------|--------|---------|
| Auth (LoginPage) | **FAKE** | `setTimeout()` login, no Clerk SDK |
| Shell/Layout | 90% | Hardcoded "Mike Ortega", needs Clerk user data |
| Dashboard (HomePage) | **Working** | Real API calls, stats, recent activity |
| Jobs | **Working** | Full CRUD, multiple views, real API |
| Customers | **Working** | Full CRUD, search, archive, real API |
| Leads | **Working** | Real API calls |
| Estimates | **Working** | Full editing, line items, proposals, real API |
| Invoices | **Working** | Full editing, proposal review, real API |
| Payments | **Partial** | List works; payment page is setTimeout fake |
| Dispatch Board | **Partial** | UI renders, drag-and-drop handlers not wired |
| Conversations | **Partial** | UI exists, connected to API, but no real AI responses |
| Assistant/AI | **FAKE** | Hardcoded AI_REPLIES dict, mock transcripts |
| Voice | **Partial** | Recording works, transcription returns mock strings |
| Settings | **STUBS** | All `action: () => {}`, no API integration |
| Onboarding | **Partial** | Multi-step form works, doesn't persist to API |
| Estimate Approval | **Working** | Signature canvas, approval flow |
| Invoice Payment | **FAKE** | Card form UI, setTimeout processing |
| Intake Form | **Working** | Conversational intake |

---

## GAP STORY SUMMARY (36 New Stories)

### Phase 0 — Platform Foundation (14 stories)
| ID | Title | Size | Priority |
|----|-------|------|----------|
| P0-019 | Postgres repositories — core entities | M | BLOCKER |
| P0-020 | Postgres repositories — financial entities | M | BLOCKER |
| P0-021 | Postgres repositories — AI & conversation entities | M | BLOCKER |
| P0-022 | Postgres repositories — config & operational entities | M | BLOCKER |
| P0-023 | Wire Postgres pool and replace all InMemory instantiations | S | BLOCKER |
| P0-024 | RLS tenant context middleware | S | BLOCKER |
| P0-025 | Implement bootstrapTenant() webhook | S | BLOCKER |
| P0-026 | Startup env validation + remove dev-secret fallback | S | BLOCKER |
| P0-027 | Integrate real STT provider (OpenAI Whisper) | S | HIGH |
| P0-028 | Replace InMemory queue with SQS worker | S | HIGH |
| P0-029 | Frontend Clerk SDK integration | S | BLOCKER |
| P0-030 | Auth headers in frontend API client hooks | S | BLOCKER |
| P0-031 | Protected route guards | S | BLOCKER |
| P0-032 | Global error boundary + Sonner toast provider | S | HIGH |

### Phase 1 — Core Entities (4 stories)
| ID | Title | Size | Priority |
|----|-------|------|----------|
| P1-018 | Postgres-backed search, pagination, and filtering | S | HIGH |
| P1-019 | Customer/location deduplication against Postgres | S | MEDIUM |
| P1-020 | Settings page — business profile save | S | HIGH |
| P1-021 | Team management in settings | S | HIGH |

### Phase 2 — Proposal Engine (2 stories)
| ID | Title | Size | Priority |
|----|-------|------|----------|
| P2-032 | Wire frontend proposal generation to AI gateway | S | HIGH |
| P2-033 | Proposal notification and inbox refresh | S | MEDIUM |

### Phase 3 — Conversation + Voice (4 stories)
| ID | Title | Size | Priority |
|----|-------|------|----------|
| P3-016 | Connect AssistantPage to backend AI endpoints | S | HIGH |
| P3-017 | Connect voice capture to real STT endpoint | S | HIGH |
| P3-018 | Wire proposal trigger modes to AI orchestration | S | MEDIUM |
| P3-019 | Conversation state persistence across navigation | S | MEDIUM |

### Phase 4 — Vertical Packs (2 stories)
| ID | Title | Size | Priority |
|----|-------|------|----------|
| P4-013 | Wire onboarding vertical pack selection to backend | S | HIGH |
| P4-014 | Template management UI in settings | S | MEDIUM |

### Phase 5 — Payments (4 stories)
| ID | Title | Size | Priority |
|----|-------|------|----------|
| P5-016 | Integrate Stripe Elements in InvoicePaymentPage | S | HIGH |
| P5-017 | Guard MockPaymentLinkProvider in production | XS | HIGH |
| P5-018 | Payment confirmation flow to frontend | S | MEDIUM |
| P5-019 | Invoice delivery notification | S | MEDIUM |

### Phase 6 — Dispatch Board (3 stories)
| ID | Title | Size | Priority |
|----|-------|------|----------|
| P6-025 | Wire drag-and-drop to create schedule proposals | S | HIGH |
| P6-026 | Conflict visibility badges on appointment cards | S | MEDIUM |
| P6-027 | Board refresh after proposal execution | S | MEDIUM |

### Phase 7 — Beta Hardening (7 stories)
| ID | Title | Size | Priority |
|----|-------|------|----------|
| P7-019 | E2E test suite for critical user journeys | M | HIGH |
| P7-020 | Dependency audit and vulnerability fixes | S | MEDIUM |
| P7-021 | Remove or integrate unused frontend libraries | XS | LOW |
| P7-022 | Rollback documentation and runbook | S | HIGH |
| P7-023 | Production smoke test script | S | MEDIUM |
| P7-024 | Fix `as any` type escapes | XS | LOW |
| P7-025 | Load test with realistic data | S | MEDIUM |

---

## RECOMMENDED EXECUTION ORDER

### Sprint 1 — Database & Auth (BLOCKERS)
**Stories:** P0-019, P0-020, P0-021, P0-022, P0-023, P0-024, P0-025, P0-026, P0-029, P0-030, P0-031
**Outcome:** Data persists. Users can sign in. Tenants are created. No more fake auth.

### Sprint 2 — AI & Voice Connection
**Stories:** P0-027, P0-028, P0-032, P2-032, P3-016, P3-017, P3-018
**Outcome:** AI assistant produces real responses. Voice transcription works. Toasts provide feedback.

### Sprint 3 — Settings, Payments, Dispatch
**Stories:** P1-018, P1-020, P1-021, P4-013, P5-016, P5-017, P6-025
**Outcome:** Settings save. Payments process. Drag-and-drop works.

### Sprint 4 — Polish & Hardening
**Stories:** P1-019, P2-033, P3-019, P4-014, P5-018, P5-019, P6-026, P6-027, P7-019, P7-020, P7-021, P7-022, P7-023, P7-024, P7-025
**Outcome:** E2E tests pass. Dependencies clean. Runbook documented. Load tested.

### Sprint 5 — Original P7 Stories (Integrations)
**Stories:** P7-001 through P7-018 (original, unbuilt)
**Outcome:** Twilio SMS, QuickBooks sync, support tooling, feature flags, degraded mode, backup/recovery, launch checklist.

---

## VERIFICATION PLAN

1. **Data persistence:** Create a customer via API, restart the server, verify customer persists
2. **Auth:** Sign up via Clerk, verify tenant created, verify JWT required for all API calls
3. **RLS:** Verify tenant A cannot see tenant B's data via API
4. **AI:** Send a message in assistant, verify real LLM response (not hardcoded)
5. **Voice:** Upload audio, verify real transcript returned
6. **Payments:** Pay an invoice via Stripe test mode, verify status updates
7. **Dispatch:** Drag appointment, verify proposal created and board refreshes
8. **Settings:** Save business profile, reload, verify persisted
9. **E2E:** Run Playwright: signup → create customer → create estimate → send → customer approves
10. **Load:** Simulate 50 concurrent users against staging
11. **Smoke:** Run `npm run smoke-test` against production after deploy
