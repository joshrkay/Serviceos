# ServiceOS — Go-Live Readiness Report

_Date: 2026-05-24 · Scope: full codebase (~190K LOC) reviewed module-by-module across API core, AI/comms, ops domain, money domain, supporting/integrations, web frontend, and deployment/infra/CI._

## Overall verdict: NOT READY — but close

The product is genuinely built, not a demo. Provider integrations are real (OpenAI, Whisper, Twilio, SendGrid, Stripe, Google Business), the AI proposal-approval safety model holds, money math uses disciplined integer cents with a shared billing engine, and there is broad test coverage (~600+ test files). This is a serious, mostly production-grade system.

It is blocked by a small number of concrete, fixable defects — most importantly a **durability gap in webhook idempotency** (flagged independently by three reviewers), a **transaction-atomicity bug**, **incomplete tenant-isolation enforcement (RLS not FORCEd)**, and a **broken human-approval action in the web UI**. None require redesign. Estimated remediation is on the order of days, not weeks.

---

## 🔴 BLOCKERS — must fix before go-live

### 1. Stripe/Clerk webhook idempotency is in-memory, not durable
`packages/api/src/webhooks/routes.ts:34` uses a module-level `InMemoryWebhookRepository` for the **money path** (Stripe `checkout.session.completed`, `charge.refunded`) and Clerk `user.created`. The durable `PgWebhookEventRepository` (atomic `INSERT … ON CONFLICT`) was built and is already used for Twilio/SendGrid — but the Stripe/Clerk handlers were never switched over (`app.ts:1003-1010` explicitly defers it to "a follow-up PR").
**Impact:** on any restart or multi-instance deploy, the dedup map is wiped → Stripe's normal retries re-credit deposits/payments (double-charge) and Clerk re-bootstraps tenants. `recordPayment` has no independent idempotency.
**Fix:** route Stripe/Clerk through `deps.webhookEventRepo.recordReceipt/markProcessed` like the other providers.

### 2. Request transactions commit even on error (atomicity not enforced)
`middleware/tenant-context.ts:138-140` COMMITs on `res.finish` without checking `res.statusCode`; `middleware/async-route.ts:12-19` turns handler exceptions into a normal 500 response, which fires `finish` → COMMIT. A multi-write route that fails on the second write commits the first.
**Fix:** roll back when `res.statusCode >= 400`. (Existing test `test/middleware/tenant-context.test.ts:160-166` actually demonstrates the bug.)

### 3. Tenant isolation is silently OFF for 29 tables (RLS enabled but not FORCEd)
`db/schema.ts`: 74 `ENABLE ROW LEVEL SECURITY` vs only 45 `FORCE`. RLS is bypassed for the table owner unless FORCEd, and the app migrates+connects as one role (`DATABASE_URL`). On the standard single-role Railway/Supabase deploy, tenant isolation is off for `users`, `conversations`, `messages`, `proposals`, `audit_events`, `files`, `expenses`, `portal_sessions`, `voice_recordings`, and 20 more.
**Fix:** add `FORCE ROW LEVEL SECURITY` to all tenant-scoped tables (or run the app as a non-owner role).

### 4. AI proposal approval in the web UI is unauthenticated and fails silently
`packages/web/src/components/assistant/AssistantPage.tsx:257` calls bare `fetch('/api/proposals/:id/approve')` with no `Authorization` header (does not use `apiFetch`/`useApiClient`). Backend returns 401; the only handling is `console.error`. **This is the central human-approval flow and it is broken in production.** (The upload path in the same file uses `apiFetch` correctly — clear oversight.)

### 5. In-process cron sweeps + non-graceful shutdown break multi-instance
All tenant-wide sweeps run via `setInterval` inside the API process (recurring agreements `app.ts:2804`, overdue invoices `:2835`, appointment reminders `:2862`, estimate reminders `:2890`, Google reviews `:2956`). With >1 instance, **every instance runs every sweep** → duplicate invoices/reminders/review replies. Shutdown (`app.ts:3102`) never `clearInterval`s loops, never drains in-flight queue jobs, never stops the HTTP server.
**Fix:** gate sweeps behind a pg advisory lock (leader election) or a single worker process; implement real graceful shutdown. *(If launching on exactly one instance, this can be a documented constraint rather than a hard blocker — but it bites the moment you scale.)*

### 6. No payment is audited
CLAUDE.md mandates "all mutations emit audit events," but `recordPayment` (`invoices/payment.ts:144-225`) emits none. The audit-emitting wrapper `reconcilePayment` exists but is **called from nowhere**; all real callers hit `recordPayment` directly. Money arriving and invoices flipping to paid leaves no audit trail.

### 7. No double-booking protection at the data layer
Conflict detection (`scheduling/feasibility.ts`, `dispatch/validation.ts`) is advisory only. `createAppointment` and `POST /api/appointments` never call it; even the proposal path is TOCTOU (feasibility check + assign not in one transaction); `schema.ts` has no `EXCLUDE USING gist` constraint. Two concurrent bookings/reassigns can both succeed.
**Fix:** add a DB exclusion constraint as the backstop; enforce feasibility on the direct create route. Also: technician assignment mutations emit no audit events.

### 8. Customer-facing estimate page can leak another tenant's data
`packages/web/src/components/customer/EstimateApprovalPage.tsx:531-592`: on a network error fetching `/public/estimates/:id`, it silently falls back to `mock-data` `estimates[0]` and renders that customer's name, address, line items, and total on a public URL.
**Fix:** remove the mock fallback; show an error state.

### 9. Resolve the conflicting deployment story
Three architectures coexist: **Railway** (live, coherent), **AWS CDK** (`infra/` — fully built, deployed by nothing, drifts), and a **Supabase/LangGraph prototype** (`service-os-app` + `service-os-agent` — wired to no deploy target, writes directly to Supabase bypassing the proposal/audit gate, and `service-os-agent` has an unauthenticated `/process` endpoint and a guaranteed `NameError` crash at `clients/service_os_api.py:146`).
**Fix:** pick Railway as the one target; quarantine/delete CDK + the prototype or clearly label them `experiments/` so no operator runs `cdk deploy` or the orphaned `supabase_migration.sql`.

### 10. Verify build + tests + migrations actually pass in CI
`node_modules` was absent in this environment, so the mandatory `tsc --project tsconfig.build.json` build gate and the full test suite could not be executed locally. Additionally, the migrations directory in this checkout is pruned (only 5 SQL files; code references 012–108) — confirm migration 106 (portal token-lookup RLS) and the `webhook_events (source, idempotency_key)` unique index are applied in prod. **Do not go live without a green build + test run + confirmed migrations in CI.**

---

## 🟠 IMPORTANT — fix soon after / before scaling

- **Raw voice transcripts stored unencrypted** (base64, self-labeled `pending-kms-integration`) in JSONB — PII at rest (`workers/transcription.ts:59,212`). Finish KMS before handling real customer calls.
- **Outbound AI calling has no TCPA/consent or DNC opt-out gate** before placing calls (`voice/outbound-allowlist.ts` only blocks malformed/premium numbers) — legal exposure.
- **Money mis-rendered in web invoice/estimate detail** — cents→float with `.toLocaleString()` drops cents ($1,234.50 → "$1,234.5"); `InvoicesPage.tsx:288-289,307,…`, `EstimateApprovalPage.tsx:715-716`. Inconsistent with the correct formatter used elsewhere.
- **`/metrics` is unauthenticated** (`app.ts:694`) — exposes tenant IDs, volumes, connection counts.
- **Idempotency crash-window** in proposal executor (`execution/executor.ts:152-169`) — a handler that succeeds then crashes before the status write can re-execute (acknowledged in code).
- **Review-reply handler reports success but no-ops** if `googleReplyResolver` is unwired in prod (`proposals/execution/review-response-handler.ts:203`).
- **DB health returns `degraded` not `down`** (`app.ts:665`) so `/ready` never 503s during a DB outage — keeps taking traffic.
- **GUC leak in worker/public paths** (`pg-base.ts:35` uses `SET` not `set_config(...,true)`) — stale tenant context can persist on a pooled connection.
- **Appointment status transitions have no state-machine validation** (jobs do; appointments don't).
- **Web: two parallel auth-fetch mechanisms**; the weaker `apiFetch` (no 401 retry, races a token bridge) is used by most money pages. Consolidate on `useApiClient`. No router-level `errorElement` → white-screens on crashes in public pages. `VITE_STRIPE_PUBLISHABLE_KEY` missing from `.env.example`.
- **Timezone:** web renders browser-local time, not tenant timezone; tax/money dashboard buckets by UTC (known, documented in TODOS.md) — accountant-facing, acceptable for a US-Pacific beta only if the UI is labeled.
- **CI gaps:** per-module coverage check is `continue-on-error: true` (cannot gate); E2E journeys self-skip without `E2E_CLERK_SECRET_KEY`; Node version drift (20 vs 22 vs Dockerfile 20).
- **Webhook rate limit** (30/min/IP, `app.ts:629`) may throttle Stripe bursts → retries.
- **Several non-transactional multi-write paths** (`runDueAgreements` job+invoice, `transitionJobStatus` audit-before-confirm, deposit-credit + invoice update).

---

## 🟢 MINOR / cleanup

- Delete dead-but-dangerous code: `routes/proposals-execute.ts` (approve+execute in one call, bypasses undo/idempotency/registry — currently unmounted), `db/client.ts` (unsafe `setTenantContext`), stale "pg-boss"/migration comments.
- Web: `centsToDisplay` lacks thousands separators; hardcoded supplier list / "AI suggestions" fixtures / "Coming soon" no-ops in Settings; mock-data guard test doesn't cover `EstimateApprovalPage`/`JobSheets`.
- `CLAUDE.md` top-level structure is stale (omits `service-os-app`, `service-os-agent`, `qa-runner`).
- WS gateway has no cross-instance fan-out (fine for single instance).
- `recurrence.ts` operates on UTC date components, ignoring tenant TZ (fine for monthly+ cadences).

---

## What's genuinely solid (don't lose sleep here)

- **AI safety model:** LLM gateway makes real provider calls with retry/deadline/circuit-breaker/failover/per-tenant quota; mock provider is test-only and fail-fast-forbidden in prod. Proposals are Zod-validated, RBAC-gated, never auto-execute, honor a 5s undo window, and use advisory-lock idempotency. Auto-approve only for autonomous-tier capture-class proposals.
- **Auth:** real Clerk RS256/JWKS verification, dev-bypass hard-gated off in prod, DB-sourced platform-admin.
- **Money math:** shared billing engine, integer cents throughout, real Stripe with atomic CAS refund + over-refund guard.
- **Estimates public approval flow:** token-hashed, expiry, idempotent re-accept, optimistic version lock — production quality.
- **Files/portal:** SHA-256 token hashing, constant-time compare, S3 SigV4 presign with content-type binding, prod refuses dev storage provider.
- **Test coverage:** every in-scope module has tests; ~600+ test files.

---

## Recommended sequencing

1. **Day 1–2:** Blockers 1, 2, 3, 4, 6, 8 (webhook durability, txn rollback, FORCE RLS, web approval auth, payment audit, estimate leak) — all small, surgical fixes.
2. **Day 2–3:** Blocker 7 (booking exclusion constraint + audit), Blocker 9 (quarantine CDK/prototype), Blocker 5 (leader-lock sweeps or commit to single instance).
3. **Before flipping on:** Blocker 10 — green CI build + tests + confirmed prod migrations; finish KMS for transcripts and add the TCPA/DNC gate if outbound calling is enabled at launch.
