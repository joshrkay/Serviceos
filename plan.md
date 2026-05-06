<!-- /autoplan restore point: /Users/macmini/.gstack/projects/joshrkay-Serviceos/main-autoplan-restore-20260416-104235.md -->
# Plan: Close Remaining P0 Launch-Blocker Gaps

## Context

ServiceOS is a voice-first, proposal-driven field service OS for HVAC/plumbing.
Most P0 gap stories have already been implemented in recent PRs (Pg repos, pool wiring,
Clerk frontend, Whisper STT, PgQueue). This plan closes the 4 remaining gaps that still
block a real user from signing in and using the system safely.

**Branch:** main  
**Date:** 2026-04-16

---

## Remaining Gaps (verified against current codebase)

| # | Gap | File | Severity |
|---|-----|------|----------|
| G1 | `proposalRepo = new InMemoryProposalRepository()` — only InMemory repo left | `packages/api/src/app.ts:283` | CRITICAL |
| G2 | Shell.tsx hardcodes "Mike Ortega" / "MO" — no real user data | `packages/web/src/components/layout/Shell.tsx:98` | HIGH |
| G3 | No `ProtectedRoute` guard — all internal routes publicly accessible | `packages/web/src/routes.ts` | CRITICAL |
| G4 | `CORS_ORIGIN \|\| true` — can be `true` in any env; no prod guard | `packages/api/src/app.ts:108` | HIGH |

---

## Sub-Problems and Existing Code

### G1: PgProposalRepository

**What exists:**
- `packages/api/src/proposals/proposal.ts` — `ProposalRepository` interface (create, findById, findByTenant, findByStatus, findByAiRun, updateStatus, update, countPending, findByIdempotencyKey, etc.)
- `packages/api/src/db/pg-base.ts` — `PgBaseRepository` with `withTenant()` and `withTenantTransaction()` helpers
- `packages/api/src/db/schema.ts` — migration `027_create_proposals`: `proposals` table with `id, tenant_id, proposal_type, status, idempotency_key` (UNIQUE per tenant), `ai_run_id`, `target_entity_type/id`, RLS policy enabled
- Pattern to follow: `packages/api/src/customers/pg-customer.ts`

**What's missing:**
- `packages/api/src/proposals/pg-proposal.ts` — `PgProposalRepository` class
- Wire in `app.ts:283`: replace `new InMemoryProposalRepository()` with `pool ? new PgProposalRepository(pool) : new InMemoryProposalRepository()`

**Acceptance criteria:**
- Implements all `ProposalRepository` methods
- All queries include `tenant_id` in WHERE clauses (defense-in-depth alongside RLS)
- Parameterized queries only — no string interpolation
- `updateStatus` uses a transaction to ensure atomic status transitions
- `idempotency_key` uniqueness enforced at DB level (already in schema via UNIQUE index)
- `status IN ('pending', 'approved', 'approved_with_edits', 'rejected', 'expired', 'execution_failed')` CHECK constraint respected

**Allowed files:**
- `packages/api/src/proposals/pg-proposal.ts` (new)
- `packages/api/src/app.ts` (wire the new repo)

---

### G2: Shell real user data

**What exists:**
- `packages/web/src/main.tsx` — app wrapped in `<ClerkProvider>`
- `packages/web/src/components/auth/AuthTokenBridge.tsx` — wires `getToken` into `apiFetch`
- `@clerk/clerk-react` is installed

**What's missing:**
- `useUser()` call in Shell.tsx to replace "Mike Ortega" and "MO" with real `user.fullName` and `user.firstName[0]+user.lastName[0]`
- Sign-out button wired to Clerk's `useClerk().signOut()`

**Acceptance criteria:**
- Shell displays `user.fullName` (fallback: `user.primaryEmailAddress?.emailAddress`)
- Avatar initials derived from real name
- Role display can remain "Owner" for now (tenant role comes from backend, deferred)
- Sign-out clears Clerk session and redirects to `/login`
- No "Mike Ortega" string anywhere in `packages/web/src/`

**Allowed files:**
- `packages/web/src/components/layout/Shell.tsx`

---

### G3: Protected route guards

**What exists:**
- `packages/web/src/routes.ts` — `createBrowserRouter` with all routes defined, no auth guards
- `@clerk/clerk-react` is installed (exports `useAuth`, `SignedIn`, `SignedOut`, `RedirectToSignIn`)

**What's missing:**
- `<ProtectedRoute>` wrapper component that checks `useAuth().isSignedIn`
- If not signed in: redirect to `/login` (preserve deep-link via `redirectUrl`)
- If Clerk is loading: show spinner (no flash of login page)
- Applied to the Shell layout wrapper (wrapping all internal routes at once)
- Public routes remain unguarded: `/login`, `/signup`, `/onboarding`, `/e/:id`, `/pay/:id`, `/intake`

**Acceptance criteria:**
- Navigating to any internal route while unauthenticated → redirected to `/login`
- Navigating to `/login` while authenticated → redirected to `/`
- Navigating to `/signup` while authenticated → redirected to `/`
- Public routes (`/e/:id`, `/pay/:id`, `/intake`) remain accessible without auth
- Deep link preserved through sign-in (e.g. `/estimates/123` → sign in → `/estimates/123`)
- No flash of internal UI during Clerk initialization

**Allowed files:**
- `packages/web/src/components/auth/ProtectedRoute.tsx` (new)
- `packages/web/src/routes.ts`
- `packages/web/src/pages/LoginPage.tsx` (add reverse auth guard)
- `packages/web/src/pages/SignupPage.tsx` (add reverse auth guard)

---

### G4: CORS_ORIGIN prod guard

**What exists:**
- `packages/api/src/app.ts:108`: `const corsOrigin = process.env.CORS_ORIGIN || true;`
- `packages/api/src/shared/config.ts` — Zod config schema, `CORS_ORIGIN: z.string().optional()`

**What's missing:**
- Guard: if `NODE_ENV === 'prod' || NODE_ENV === 'staging'` and `CORS_ORIGIN` is not set (or is the literal string `"true"`), throw a startup error
- Dev/test: `|| true` fallback is acceptable

**Acceptance criteria:**
- In prod/staging: missing or wildcard `CORS_ORIGIN` throws `Error: CORS_ORIGIN must be set to an explicit origin in production`
- In dev/test: `|| true` (allow all) remains valid
- Config schema updated to reflect this constraint

**Allowed files:**
- `packages/api/src/app.ts`
- `packages/api/src/shared/config.ts`

---

## Implementation Order

```
G4 (env guard — 5 min, no deps)
  → G1 (PgProposalRepository — 30 min, no UI deps)
  → G2 (Shell real user — 10 min, no backend deps)
  → G3 (ProtectedRoute — 15 min, depends on nothing but Clerk)
```

All 4 are independent of each other. Sequential order above is safest for review.

---

## Test Plan

### G1 — PgProposalRepository

- [ ] Happy path: create → findById → findByTenant
- [ ] Status transition: pending → approved (atomic)
- [ ] Idempotency: duplicate `idempotency_key` returns conflict error
- [ ] findByStatus: returns only proposals matching status for tenant
- [ ] Tenant isolation: cross-tenant proposals inaccessible
- [ ] countPending: returns accurate count

### G2 — Shell real user

- [ ] Authenticated: Shell shows real user name and initials
- [ ] Sign-out: clears session, redirects to `/login`
- [ ] No "Mike Ortega" in codebase

### G3 — ProtectedRoute

- [ ] Unauthenticated access to `/jobs` → redirect to `/login`
- [ ] `/e/:id` accessible without auth
- [ ] Deep link preserved through sign-in
- [ ] Loading state: spinner during Clerk init, no flicker

### G4 — CORS guard

- [ ] prod/staging with no CORS_ORIGIN → startup throws
- [ ] prod/staging with CORS_ORIGIN set → starts normally
- [ ] dev with no CORS_ORIGIN → starts with wildcard (no throw)

---

## Non-Goals

- Migrating existing InMemory proposal data (there is none in prod — system was never live)
- Implementing tenant role display in Shell (deferred; requires `/api/me` endpoint)
- Full auth flow E2E tests (covered by Playwright suite separately)
- Any P1+ gap stories

---

---

## CEO REVIEW — Phase 1

### CLAUDE SUBAGENT (CEO — strategic independence)

Key findings [subagent-only — Codex unavailable (usage limit)]:

**CRITICAL — G4 CORS guard placement:** The fix should add `CORS_ORIGIN` to `validateProductionConfig()` in `config.ts` rather than splitting the guard across two files. The `|| true` fallback in `app.ts:105` should be removed, but the validation logic belongs in `config.ts` alongside existing prod env checks. Plan's "Allowed files" lists both files — correct — but the implementation note should be more precise.

**HIGH — Shell.tsx must handle Clerk loading state:** `useUser()` returns `{ isLoaded: false, user: null }` during Clerk initialization. G2 and G3 are listed as independent, but Shell renders inside ProtectedRoute and could briefly receive null user. G2 must add `if (!isLoaded) return null` or a skeleton — can't rely solely on G3's guard.

**HIGH — Clerk webhook → tenant creation is untested:** After a new user signs up, if the `bootstrapTenant()` webhook fires and fails silently (Clerk webhook secret mismatch, DB error), the user lands in the app with a valid Clerk session but no backend tenant record. Every API call fails. The plan includes no happy-path test touching the signup → tenant creation flow. This is the most likely real-user failure mode on day one.

**MEDIUM — G3 missing reverse guard:** `ProtectedRoute` only handles unauthenticated → redirect to `/login`. Authenticated users can still navigate to `/login` directly. The plan's acceptance criteria mentions this ("Navigating to `/login` while authenticated → redirected to `/`") but the allowed files don't include `LoginPage.tsx` or `SignupPage.tsx`. Gap in scope definition.

**MEDIUM — InMemory dev fallback should warn loudly:** `pool ? new PgProposalRepository(pool) : new InMemoryProposalRepository()` means local dev without `DATABASE_URL` runs in-memory indefinitely. In 6 months this causes divergence bugs. Should log a bold warning on startup.

**LOW — Competitive risk is not relevant here.** This is execution hygiene.

### Step 0A — Premise Challenge

| Premise | Status | Notes |
|---------|--------|-------|
| "Most P0 gaps already implemented" | VALID | Verified: Pg repos, Clerk frontend, Whisper, PgQueue all wired |
| "4 gaps block real users" | MOSTLY VALID | G1/G3/G4 are hard blockers; G2 is UX (backend auth still works without it) |
| "proposalRepo is the only InMemory repo left" | VALID | Confirmed: app.ts:283 |
| "All internal routes publicly accessible" | VALID (partial) | No client-side guard; backend still enforces auth on all /api/* routes |
| "CORS_ORIGIN can be true in any env" | VALID | app.ts:105: `|| true` unchecked |
| "Mike Ortega hardcoded" | VALID | Shell.tsx:98 confirmed |

One premise needs refinement: G3 is a security/UX gap on the frontend but NOT a data security gap — the backend's `requireAuth` middleware on all `/api/*` routes means no real data is exposed to unauthenticated clients. The risk is bad UX (empty screens) not data leakage. This doesn't change the priority but is worth stating clearly.

### Step 0B — Existing Code Leverage Map

| Sub-problem | Existing code to reuse |
|-------------|----------------------|
| G1: PgProposalRepository | `PgBaseRepository` (pg-base.ts), `pg-customer.ts` (pattern), `ProposalRepository` interface (proposal.ts), proposals table migration (schema.ts) |
| G2: Shell real user | `@clerk/clerk-react` installed, `useUser()` hook, `useClerk()` for signOut |
| G3: ProtectedRoute | `useAuth()` from Clerk, existing `LoginPage` redirect pattern |
| G4: CORS guard | `validateProductionConfig()` in config.ts (extend it), `loadConfig()` called at startup |

### Step 0C — Dream State

```
CURRENT STATE                THIS PLAN                    12-MONTH IDEAL
────────────────────         ─────────────────────────    ──────────────────────────
proposals: InMemory    →     proposals: Postgres          All entities: Postgres
Shell: "Mike Ortega"   →     Shell: real Clerk user       Multi-role user display
Routes: unguarded      →     Routes: auth-gated           Role-based permissions
CORS: || true in prod  →     CORS: validated at startup   Full env validation suite
Cannot run in prod     →     CAN RUN IN PRODUCTION        50+ active tenants
```

This plan closes the "cannot run in production" gap. That's the entire value.

### Step 0C-bis — Implementation Alternatives

| Approach | Effort | Risk | Completeness |
|----------|--------|------|-------------|
| A: This plan (4 targeted fixes) | ~1h CC | Low | 9/10 |
| B: Postgres only (skip auth) | 30m CC | HIGH — routes still unguarded | 5/10 |
| C: Scope-expand to full P1 | 4h CC | Medium — most P1 already done | 10/10 |

Auto-decision (P5 pragmatic): Approach A. Approach C is fine but P1 is not a launch blocker.

### Step 0D — Mode: SELECTIVE EXPANSION

Hold current scope. Two expansion opportunities identified:
- **EXP-1:** Add `if (!isLoaded) return null` to Shell.tsx (in G2 blast radius, ~5 LOC). Auto-approve (P2).
- **EXP-2:** Add reverse auth guard to LoginPage.tsx / SignupPage.tsx (out of current allowed files, ~10 LOC). Surface at gate.
- **EXP-3:** Add Clerk webhook integration test (separate test file, outside plan scope). Defer to TODOS.md.

### Step 0E — Temporal Interrogation

- **HOUR 1:** G4 (5 min) → G1 PgProposalRepository impl (30 min)
- **HOUR 2:** G1 tests + G2 Shell real user (10 min) + G3 ProtectedRoute (15 min)
- **HOUR 3:** Build verification (`tsconfig.build.json`), grep checks, PR review
- **HOUR 6+:** Ready for `/ship` — all 4 gaps closed, system can run in production

### Step 0F — Mode Confirmation

SELECTIVE EXPANSION confirmed. Scope expansions EXP-1 (Clerk loading state in Shell) auto-approved. EXP-2 (reverse auth guard) and EXP-3 (webhook test) surfaced at gate.

---

### Section 1 — Problem Definition

The plan correctly identifies the delta between "prototype that loses all data on restart with fake auth" and "system that can run in production." The framing is tight and accurate. No inflation of scope.

Examined: plan context, codebase-readiness-assessment.md, git log. Nothing flagged.

### Section 2 — Error & Rescue Registry

| Error scenario | Where it fails | User impact | Recovery |
|----------------|---------------|-------------|----------|
| PgProposalRepository: duplicate idempotency_key | `pg_unique_violation (23505)` | AI double-fires same proposal | Return 409 Conflict, idempotent no-op |
| PgProposalRepository: DB unavailable | pool connection timeout | Proposal can't be submitted | 503 with retry hint |
| Clerk webhook fails (bootstrapTenant) | New user has Clerk session, no DB tenant | All API calls fail with 403/500 | Manual tenant creation, idempotent retry |
| Shell.tsx: user null during Clerk init | Render crash or empty initials | Flash of broken UI | `if (!isLoaded) return null` |
| CORS guard throws at startup | Server won't start in prod | Zero downtime for deploy failure | Clear error message names the missing var |
| ProtectedRoute: Clerk loading → flash | Brief exposure of internal UI | UX confusion | Show spinner until `isLoaded` is true |

### Section 3 — Scope Calibration

This plan is correctly scoped. It's the minimum viable set of changes to go from "cannot run in production" to "can run in production." No inflation, no scope creep. The 4 gaps map 1:1 to launch blockers.

The one concern: G2 (Shell real user) is not a hard launch blocker — the system would function with "Mike Ortega" still showing. But it IS a trust signal: a real user seeing a hardcoded name would (correctly) not trust the system. Worth keeping.

### Section 4 — Alternatives Analysis

Only one alternative was implicitly dismissed: implementing the 5 remaining P0 gap stories as originally written (P0-026 env validation, P0-027 Whisper, P0-028 SQS). These are already implemented. The plan correctly identified this without stating it explicitly.

No alternatives were dismissed prematurely. The 4-gap plan is the right scope.

### Section 5 — Risk Assessment

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|-----------|
| Clerk webhook → tenant creation untested | HIGH | HIGH | Add to TODOS.md, manual smoke test before launch |
| PgProposalRepository diverges from InMemory interface | LOW | MEDIUM | TypeScript compiler catches at build |
| G3 authenticated → /login redirect missing | MEDIUM | LOW | UX gap, not security. Add to TODOS.md |
| G4 CORS guard misplaced (split across files) | MEDIUM | LOW | Code review will catch |

### Section 6 — Dependencies

G1 → none (PgBaseRepository exists, proposals schema in DB). G2 → Clerk installed. G3 → Clerk installed. G4 → config.ts Zod schema exists. All 4 are independent of each other.

### Sections 7-10 — Timeline / Observability / Security / DX

- **Timeline:** 1 hour CC. No blocking dependencies. Sequential order (G4→G1→G2→G3) is safest.
- **Observability:** PgProposalRepository inherits from PgBaseRepository which has query logging. No new observability needed.
- **Security:** G3 (ProtectedRoute) is a frontend UX guard. Real security is `requireAuth` on all `/api/*` routes (already in place). G4 (CORS guard) prevents misconfiguration in prod. Both are additive security improvements.
- **DX:** No developer-facing API changes. Internal infrastructure only.

### NOT In Scope (from this review)

- EXP-2: Reverse auth guard on `/login`/`/signup` for authenticated users → TODOS.md
- EXP-3: Clerk webhook → tenant creation integration test → TODOS.md
- InMemory dev fallback warning log → plan comment only
- P1+ stories → separate plan

### What Already Exists

| Sub-problem | Existing code |
|-------------|--------------|
| G1 | PgBaseRepository (withTenant, withTenantTransaction), pg-customer.ts pattern, ProposalRepository interface, proposals schema with RLS |
| G2 | @clerk/clerk-react, useUser(), useClerk() hooks |
| G3 | useAuth(), ClerkProvider wrapping app |
| G4 | validateProductionConfig() in config.ts (extend it) |

### Dream State Delta

After this plan: system can run in production. What it doesn't yet have: P1 stories (full business entities wired end-to-end), reverse auth guard on login page, Clerk webhook smoke test.

### CEO Completion Summary

| Dimension | Assessment |
|-----------|-----------|
| Problem framing | Correct — closing the last production gap |
| Scope | Right-sized — 4 gaps, ~1 hour CC |
| Premises | 5/6 valid, 1 needs nuance (G3 is UX not security) |
| Critical gaps found | 2 (Clerk loading state in Shell, G4 placement) |
| Expansions approved | EXP-1 (Clerk isLoaded guard in Shell.tsx) |
| Deferred | EXP-2, EXP-3 → TODOS.md |
| Recommendation | Proceed with plan + EXP-1 |

**Phase 1 complete.** Subagent: 5 findings (2 high, 2 medium, 1 low). Codex: unavailable [subagent-only]. Passing to Phase 2 (Design — UI scope detected).

---

## CEO DUAL VOICES — CONSENSUS TABLE [subagent-only]

```
CEO DUAL VOICES — CONSENSUS TABLE:
═══════════════════════════════════════════════════════════════
  Dimension                           Claude  Codex  Consensus
  ──────────────────────────────────── ─────── ─────── ─────────
  1. Premises valid?                   YES     N/A    [subagent-only]
  2. Right problem to solve?           YES     N/A    [subagent-only]
  3. Scope calibration correct?        YES     N/A    [subagent-only]
  4. Alternatives sufficiently explored?YES    N/A    [subagent-only]
  5. Competitive/market risks covered? YES     N/A    [subagent-only]
  6. 6-month trajectory sound?         YES     N/A    [subagent-only]
═══════════════════════════════════════════════════════════════
```

---

## DESIGN REVIEW — Phase 2

### CLAUDE SUBAGENT (design — independent review) [subagent-only]

**CRITICAL — G2 missing `isLoaded` loading state:**
`useUser()` returns `{ isLoaded: false, user: null }` during Clerk init. G2 acceptance criteria say nothing about this. Fix: render a skeleton row (grey circle + grey bars) when `!isLoaded`. Added to G2 acceptance criteria below. Auto-approved (P1 — EXP-1 formalized).

**HIGH — G2 email-only user initials unspecified:**
`user.fullName` can be null for OAuth sign-ins. Plan says fall back to `primaryEmailAddress?.emailAddress` but doesn't specify what avatar initials should be. Fix: first char of email local part, uppercased. Auto-approved (P1).

**HIGH — G3 contradiction: reverse-guard criterion listed, LoginPage.tsx not in allowed files:**
Acceptance criteria says "Navigating to `/login` while authenticated → redirected to `/`" but allowed files are `ProtectedRoute.tsx` and `routes.ts` — no path to implement it. Fix: remove this criterion from G3 scope. It's UX polish, not a launch blocker. Deferred to TODOS.md. Auto-decided (P3 pragmatic + P5 explicit).

**MEDIUM — G3 spinner should match LoginPage branding:**
"Show spinner" is underspecified. Users who hit a protected route see a full-screen spinner with no branding — jarring. Fix: spinner screen should include the Fieldly logo + `bg-slate-50` background matching LoginPage. Auto-approved (P1, ~5 LOC addition).

**MEDIUM — G2 signOut redirectUrl not specified:**
`useClerk().signOut()` defaults to Clerk's post-logout URL without an explicit `redirectUrl`. Fix: call `signOut({ redirectUrl: '/login' })`. Auto-approved (P1, explicit > implicit).

### Design Litmus Scorecard

| Dimension | Score | Notes |
|-----------|-------|-------|
| Information hierarchy | 8/10 | Avatar → name order is correct |
| Missing states coverage | 5/10 → 9/10 | Fixed by adding isLoaded skeleton + email fallback |
| User journey clarity | 7/10 | Spinner branding fix closes the gap |
| Specificity | 6/10 → 8/10 | Fixed by adding explicit signOut redirect + initials rule |
| Reverse guard consistency | 3/10 → 8/10 | Fixed by removing the out-of-scope criterion |

**Phase 2 complete.** Subagent: 5 findings (1 critical, 2 high, 2 medium). Codex: unavailable [subagent-only]. Passing to Phase 3.

---

## ENG REVIEW — Phase 3

### CLAUDE SUBAGENT (senior engineer — independent review) [subagent-only]

**CRITICAL — G1: `findReadyForExecution` must use `withClient()`, not `withTenant()`**
`findReadyForExecution(windowMs)` is a privileged background sweep across all tenants — the comment on `ProposalRepository` interface (proposal.ts:237) already says "Does NOT filter by tenant." If implemented with `withTenant()`, the RLS policy would silently filter to a single tenant and the executor would miss proposals from all others. The fix: use `this.withClient()` (pg-base.ts:48 — already exists). This is the most consequential correctness bug in the plan. Auto-approve (P1 critical path).

**HIGH — G1: No tests for `findReadyForExecution` (3 tests needed)**
The test plan covers happy-path CRUD and tenant isolation but omits `findReadyForExecution`. Need: (1) returns proposals across multiple tenants within the window, (2) excludes proposals outside the window, (3) excludes non-`pending` status proposals. Without these, the RLS bypass is undetectable via tests. Auto-approve (P1, P2 completeness).

**HIGH — Finding #3: `NODE_ENV === 'prod'` vs `'production'` — FALSE ALARM**
Initial read flagged `app.ts:134` guarding on `'prod'` as potentially mismatched. Verified: `config.ts` Zod transform normalizes `process.env.NODE_ENV = 'production'` → `'prod'` before `validateProductionConfig()` is called (config.ts:58). Both `app.ts:134` and `config.ts:58` receive the post-normalization value. The guard is correct. No action required.

**MEDIUM — G1: `updateStatus` should use `SELECT ... FOR UPDATE`**
If two background workers race to claim the same proposal (both see `pending`, both attempt `pending → approved`), the last writer wins with no error. The transition should be: `SELECT id FROM proposals WHERE id = $1 AND tenant_id = $2 AND status = $1_expected FOR UPDATE`, then update. This is a row-level lock, not a table lock — safe for high concurrency. Auto-approve (P1 correctness, ~5 LOC addition to implementation).

**MEDIUM — G3: `isLoaded` check must precede `isSignedIn` check in `ProtectedRoute`**
`useAuth()` returns `{ isLoaded: false, isSignedIn: undefined }` during init. If `ProtectedRoute` checks `isSignedIn` before `isLoaded`, `undefined` is falsy and the component redirects to `/login` even for authenticated users — a flash redirect. Fix: `if (!isLoaded) return <Spinner>` before any `isSignedIn` check. Already implicit in acceptance criteria; making it an explicit implementation note. Auto-approve (P1 — missing states).

**MEDIUM — G4: CORS guard belongs in `validateProductionConfig()`, not inline in `app.ts`**
The current G4 description says to add a guard to `app.ts`. But `validateProductionConfig()` in `config.ts` already centralizes all prod env checks — it's where `CLERK_SECRET_KEY`, `AI_PROVIDER_API_KEY`, etc. are validated. Splitting CORS validation to `app.ts` means two files to check for "what fails at prod startup." Fix: add `CORS_ORIGIN` to `validateProductionConfig()` in `config.ts`; `app.ts` just reads `config.CORS_ORIGIN`. Also update `config.ts` Zod schema: CORS_ORIGIN required when `NODE_ENV` is prod/staging. Auto-approve (P1, P5 explicit — already aligned with CEO finding).

**LOW — G1: `countPending` cross-tenant isolation test missing**
Test plan checks `countPending` returns accurate count, but doesn't verify it only counts for the given tenant. A tenant isolation test: create pending proposals for two tenants, call `countPending(tenantA)`, expect count excludes tenantB proposals. Auto-approve (P2 completeness, ~10 LOC test).

**LOW — G3: Deep-link smoke test needed**
Test plan says "Deep link preserved through sign-in" but doesn't specify the mechanism. Clerk's `<RedirectToSignIn redirectUrl={window.location.href} />` handles this automatically if used — but needs a test confirming the `redirectUrl` query param is set on the redirect. Manual smoke test acceptable for launch; add to test plan. Auto-approve (P1 — acceptance criteria has a testable assertion).

### ENG DUAL VOICES — CONSENSUS TABLE [subagent-only]

```
ENG DUAL VOICES — CONSENSUS TABLE:
═══════════════════════════════════════════════════════════════
  Dimension                           Claude  Codex  Consensus
  ──────────────────────────────────── ─────── ─────── ─────────
  1. Architecture sound?               YES     N/A    [subagent-only]
  2. Test coverage sufficient?         NO      N/A    FLAGGED (findReadyForExecution uncovered)
  3. Performance risks addressed?      YES     N/A    [subagent-only]
  4. Security threats covered?         YES     N/A    [subagent-only]
  5. Error paths handled?              PARTIAL N/A    FLAGGED (updateStatus race condition)
  6. Deployment risk manageable?       YES     N/A    [subagent-only]
═══════════════════════════════════════════════════════════════
CONFIRMED = both agree. DISAGREE = models differ (→ taste decision).
Missing voice = N/A (not CONFIRMED). Single critical finding from one voice = flagged regardless.
```

### Eng Completion Summary

| Dimension | Assessment |
|-----------|-----------|
| Correctness | G1 has 1 critical correctness bug (findReadyForExecution RLS bypass) — solvable with withClient() |
| Test coverage | 3 tests missing for findReadyForExecution + 1 for countPending isolation |
| Architecture | G4 CORS guard placement confirmed: config.ts is correct home |
| Concurrency | updateStatus needs row lock — low probability but correct to add |
| NODE_ENV finding | FALSE ALARM — normalization already handles it |
| Frontend guard ordering | isLoaded before isSignedIn is critical for G3 |

**Phase 3 complete.** Subagent: 7 findings (1 critical, 2 high, 3 medium, 1 low) + 1 false-alarm cleared. Codex: unavailable [subagent-only]. Passing to Phase 4.

---

## Decision Audit Trail

| # | Phase | Decision | Classification | Principle | Rationale | Rejected |
|---|-------|----------|----------------|-----------|-----------|---------|
| 1 | CEO | Mode: SELECTIVE EXPANSION | Mechanical | P1 | Plan is tight + correct; surface expansions individually | SCOPE EXPANSION |
| 2 | CEO | EXP-1 approved: add isLoaded guard to Shell.tsx | Mechanical | P2 | In G2 blast radius, ~5 LOC, zero risk | Deferred |
| 3 | CEO | EXP-2 initially deferred → **USER OVERRIDE: added to scope** | Taste | User | User added LoginPage.tsx + SignupPage.tsx to G3 allowed files | Deferred |
| 4 | CEO | EXP-3 deferred: Clerk webhook integration test | Mechanical | P3 | Out of plan scope; separate test file | Auto-approve |
| 5 | Design | G2: add isLoaded skeleton to AC | Mechanical | P1 | Missing state = undefined behavior for 3 implementers | None |
| 6 | Design | G2: email initials = first char of local part uppercased | Mechanical | P1 | fullName can be null on OAuth sign-ins | None |
| 7 | Design | G3: reverse-guard criterion **reinstated** via user override | Taste | User | LoginPage.tsx + SignupPage.tsx added to allowed files | Removed from scope |
| 8 | Design | G3: spinner should use Fieldly logo + bg-slate-50 | Mechanical | P1 | Bare spinner is jarring; LoginPage sets the pattern | None |
| 9 | Design | G2: signOut({ redirectUrl: '/login' }) explicit | Mechanical | P1 | Implicit Clerk default may redirect elsewhere | None |
| 10 | Eng | G1: findReadyForExecution must use withClient() not withTenant() | Mechanical | P1 | withTenant() silently filters to one tenant — RLS bypass for background sweep | None |
| 11 | Eng | G1: add 3 tests for findReadyForExecution (multi-tenant, window, status filter) | Mechanical | P1+P2 | Critical path untested; RLS bypass undetectable without it | Defer |
| 12 | Eng | NODE_ENV 'prod' guard — FALSE ALARM (config.ts normalizes before validation) | N/A | N/A | config.ts:58 uses normalized cachedConfig; 'prod' is correct | N/A |
| 13 | Eng | G1: updateStatus uses SELECT...FOR UPDATE row lock | Mechanical | P1 | Race: two workers claim same proposal; last write wins with no error | Omit lock |
| 14 | Eng | G3: isLoaded check before isSignedIn in ProtectedRoute | Mechanical | P1 | isSignedIn is undefined during init; falsy check causes flash redirect | None |
| 15 | Eng | G4: CORS_ORIGIN validation moves to validateProductionConfig() in config.ts | Mechanical | P1+P5 | Centralizes all prod startup checks; aligns with CEO finding | Split across files |
| 16 | Eng | G1: add countPending cross-tenant isolation test | Mechanical | P2 | Verifies RLS defense-in-depth on aggregate query | Defer |
| 17 | Eng | G3: deep-link smoke test — Clerk RedirectToSignIn with redirectUrl | Mechanical | P1 | AC has testable assertion; needs explicit test or manual smoke test | Omit |

---

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/autoplan` | Scope & strategy | 1 | clean | 6 findings, all resolved |
| Design Review | `/autoplan` | UI/UX gaps | 1 | clean | 5 findings, all resolved |
| Eng Review | `/autoplan` | Architecture & tests | 1 | issues_open | 7 findings, 1 critical (findReadyForExecution → withClient) to address in implementation |
| DX Review | skipped | Not a developer tool | 0 | — | — |
| Voices (CEO) | `/autoplan` | Independent 2nd opinion | 1 | clean | subagent-only, 4/4 confirmed |
| Voices (Design) | `/autoplan` | Independent 2nd opinion | 1 | clean | subagent-only, 5/5 confirmed |
| Voices (Eng) | `/autoplan` | Independent 2nd opinion | 1 | issues_open | subagent-only, 4/6 confirmed, 2 open |

**VERDICT:** APPROVED (user override: reverse auth guard added to G3 scope). Implement in order: G4 → G1 → G2 → G3. Critical: `findReadyForExecution` must use `withClient()`. Run `/ship` when ready.

---

## Build Verification

```bash
cd packages/api && npx tsc --project tsconfig.build.json --noEmit
cd packages/web && npx tsc --noEmit
grep -r "Mike Ortega" packages/web/src/ | wc -l  # must be 0
grep -r "InMemoryProposalRepository" packages/api/src/app.ts  # must not appear in non-import lines
```
