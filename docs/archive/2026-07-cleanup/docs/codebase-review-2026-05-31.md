# ServiceOS — Codebase Review (2026-05-31)

Full-repo review of the canonical product (`packages/api`, `packages/web`,
`packages/shared`) plus a targeted refactor of the highest-leverage debt.
Conducted with four parallel deep-dive passes (build/test health, backend
architecture, frontend architecture, cross-cutting debt) cross-checked
against direct inspection. Where the passes disagreed, the disagreement was
resolved against `HEAD` — noted inline.

## TL;DR

The product is in good shape and **builds clean**. The canonical core
(money, persistence/RLS, auth, the proposal approval-gate, the LLM gateway)
is solid and disciplined. The dominant problem is **structural
concentration**, not correctness: a handful of multi-thousand-line files —
above all `packages/api/src/app.ts` (3,365 lines) — carry far too much, and
the web data layer is hand-rolled and cacheless. None of this blocks the
build or the test suite.

## What's working

- **Production build is green.** `cd packages/api && npx tsc --project
  tsconfig.build.json --noEmit` → **0 errors** (the same config Railway
  deploys). Web `tsc` and shared `tsc` are also 0 errors.
- **Tests pass.** API unit suite: **5,757 passed / 0 failed** (592 files,
  ~121s, no DB required). CI (`pr-checks.yml`) enforces build-config tsc +
  web tsc + lint + infra CDK tests + an AI-gateway guard + unit +
  Postgres-testcontainer integration + coverage.
- **Money = integer cents.** Zero `parseFloat` on money anywhere; every
  `toFixed` is display-only or a non-money ratio; fields are consistently
  `...Cents`. A single shared `billing-engine.ts` owns document totals and is
  imported by every estimate/invoice path.
- **Multi-tenant isolation is a strength.** `schema.ts` declares **74 ENABLE
  + 73 FORCE ROW LEVEL SECURITY + 83 CREATE POLICY**, applied at boot by the
  migrate step; Pg repos run tenant-scoped through `PgBaseRepository`
  (GUC set + reset, fail-closed). The production wiring **crashes fast** if
  `DATABASE_URL` is missing in prod/staging (`app.ts:732`), so the in-memory
  dev fallback can never silently ship.
  - *Reconciliation:* one review pass flagged "zero RLS policies = cross-tenant
    leak." That was a false negative — it searched `db/migrations/` while the
    policies live as raw SQL in `schema.ts`. Verified directly; **not a bug.**
- **AI calls route through the gateway.** The only `openai` import outside
  `ai/gateway` is the gateway's own provider adapter; a CI guard script
  enforces this.
- **Proposals are Zod-validated and human-gated.** 11 typed contracts; no
  auto-execute path; execution is idempotent with a worker-claim race guard.
- **Type discipline is high.** API: 17 `as any`, **0** `@ts-ignore`. Web: ~2
  non-test `as any`, **0** `@ts-ignore`/`@ts-nocheck`. Genuine `TODO/FIXME`
  markers in canonical source are in the single digits.

## What's not

1. **`app.ts` is a 3,365-line god composition-root** (every reviewer's #1).
   `createApp()` is a ~2,700-line function that builds ~120 repos/services,
   mounts ~110 routers, schedules sweeps, and — until this change — embedded a
   full repository class and inline raw SQL.
2. **Other oversized files:** `db/schema.ts` (3,541), `telephony/twilio-
   adapter.ts` (2,173), `webhooks/routes.ts` (1,741, and a partial-adherence
   to the P0-014 webhook base — each provider inlines verify/dedup).
3. **Web data layer is hand-rolled and cacheless.** No react-query; three
   overlapping fetch wrappers + ~19 raw `fetch()` sites; mutations don't
   invalidate, so the UI is stale-after-write. Several >1,000-line god
   components (`JobDetail` 1541, `NewJobFlow` 1488, `EstimatesPage` 1414).
4. **Inconsistent route error handling.** `asyncRoute` exists but only ~14 of
   51 route files use it; ~179 manual catch blocks remain.
5. **Operational debt:** no real ESLint (lint == `tsc --noEmit`); 3 high /
   5 moderate prod dependency vulns (axios, js-cookie via Clerk, qs, uuid,
   ws — mostly `npm audit fix`-able); Node version drift (one workflow pins
   22, Dockerfile is 20); API test files carry 138 stale-fixture type errors
   (test-only — `tsc -p tsconfig.build.json` excludes them, deploy unaffected).
6. **A few correctness seams:** `StubSkillMatcher` + in-memory-only
   availability ships in prod (scheduling conflict warnings silently
   degraded); webhook idempotency store and the idempotency middleware are
   in-memory (multi-instance hole); outbound voice has a TODO'd TCPA/DNC gate.
   These are tracked in `GO-LIVE-READINESS.md` / `BLOCKER-REMEDIATION-PLANS.md`.

## Doc accuracy note

`docs/codebase-readiness-assessment.md` (May 13, "85% built / 70% ready") is
content-stale — superseded by the deeper May 24 GO-LIVE review. Conversely the
GO-LIVE doc over-states three items now fixed at HEAD (FORCE-RLS, web approval
auth, estimate mock-data leak). Re-validate either before acting.

## Refactor applied in this change

Behavior-preserving, build-verified (`tsc -p tsconfig.build.json` → 0 errors;
billing-engine + deposit-rule tests 37/37; full API unit suite green):

1. **Extracted the inline `InMemoryWebhookEventRepository`** (~96 lines) out
   of `app.ts` into `webhooks/in-memory-webhook-event.ts`. First concrete
   step of the `app.ts` decomposition every reviewer called for — removes a
   class definition from the composition root with zero behavior change.
2. **Added `applyBps(amountCents, bps)` to `billing-engine.ts`** as the single
   home for percentage-of-money math, and routed the engine's own tax line
   through it.
3. **`jobs/deposit-rule.ts` now calls `applyBps`** instead of re-implementing
   `Math.round((totalCents * bps) / 10000)` inline — closing the one real
   "use the shared billing engine for all financial calculations" gap
   (CLAUDE.md). Identical formula, identical results.

## Recommended next steps (ranked)

1. **Continue decomposing `app.ts`** into `bootstrap/{repositories,webhooks,
   middleware,routers,sweeps}.ts`. Care required: webhook-* repo instances are
   deliberately separate from the main ones, and `jobRepo` is hoisted to keep
   one shared in-memory instance — preserve those.
2. **Adopt TanStack Query** on the web as the single data path; unify the
   fetch wrappers and the 19 raw `fetch()` sites; delete dead duplicate pages.
3. **Collapse `webhooks/routes.ts` onto the existing webhook base** (true
   P0-014 compliance) and finish `asyncRoute` adoption across route files.
4. **Operational:** add ESLint; `npm audit fix` the non-breaking vulns; pin
   Node 20 everywhere; refresh the 138 stale test fixtures.
