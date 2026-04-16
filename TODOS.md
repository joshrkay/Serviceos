# TODOS — Deferred from /autoplan (2026-04-16)

These items were identified during the autoplan review pipeline and deferred.
They are not launch blockers but should be addressed after the P0 gaps close.

## EXP-3: Clerk webhook → tenant creation integration test (from CEO Phase 1)

The `bootstrapTenant()` webhook path is untested. If the Clerk webhook fires and
fails (secret mismatch, DB error), the user has a valid Clerk session but no backend
tenant record — every API call fails with 403/500. A smoke test should verify the
signup → webhook → tenant creation flow end-to-end.

Effort: ~1 hour. Requires test webhook secret setup.

---

## InMemory dev fallback startup warning (from CEO Phase 1)

`pool ? new PgProposalRepository(pool) : new InMemoryProposalRepository()` silently
falls back to InMemory when `DATABASE_URL` is unset. After 6 months this causes
divergence bugs. Add a bold `console.warn` on startup when the fallback is used.

Effort: 2 min. File: `packages/api/src/app.ts`.

---

## G3: Deep-link smoke test (from Eng Phase 3)

Verify that `<RedirectToSignIn redirectUrl={window.location.href} />` correctly
preserves the deep link through sign-in. The acceptance criteria assert this but
there's no explicit test. Manual smoke test acceptable for launch; add to Playwright
suite post-launch.

---

## countPending cross-tenant isolation test (from Eng Phase 3)

Add a test: create pending proposals for two tenants, call `countPending(tenantA)`,
verify count excludes tenantB proposals. Confirms RLS defense-in-depth on aggregate
queries.

Effort: ~10 min. File: `packages/api/src/proposals/pg-proposal.test.ts`.
