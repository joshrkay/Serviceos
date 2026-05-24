# Onboarding Module Assessment

_Date: 2026-05-24. Scope: the onboarding module (API + web). Assessment across four lenses —
architecture, code health, code review (correctness), and QA/functional. Findings are
prioritized P0 (ship-blocker) / P1 (fix soon) / P2 (cleanup)._

> **Resolution (2026-05-24):** All three P1s were fixed in the same change set.
> #1 — `/configure` was removed entirely (see #3). #2 — onboarding reads/writes now use the
> request-scoped, GUC-bound client (`currentTenantContext()`). #3 — the v1 wizard was retired:
> the `/configure` endpoint, `OnboardingPage.tsx`, and the `VITE_ONBOARDING_V2_ENABLED` flag are
> gone; v2 is the only flow. This also resolves P2 #4, #6, and #7. The web changes were verified
> by typecheck + unit tests but NOT browser-tested in this environment.

## How onboarding works (baseline)
Onboarding status is **derived**, not stored: `deriveOnboardingStatus()` computes a 6-step flow
(`signup → identity → pack → phone → billing → test_call`) from real entities loaded by
`loadOnboardingFacts()`. There is no `onboarding_progress` table — each step's "done" is read
from `tenants`, `tenant_settings`, `pack_activations`, `tenant_integrations`, and `voice_sessions`.
Two flows exist: **v2** (`OnboardingShell`, form-based, endpoints `/identity` + `/pack`) and the
flag-gated default **v1** (`OnboardingPage`, 9-step wizard, endpoint `/configure`). The web client
polls `GET /api/onboarding/status` every 3s.

Key files: `packages/api/src/routes/onboarding.ts`, `packages/api/src/onboarding/{derive-status,load-facts,contracts}.ts`,
`packages/api/src/workers/provision-twilio.ts`, `packages/web/src/components/onboarding/**`,
`packages/web/src/routes.ts:132`.

---

## P1 — Fix soon

### 1. `/configure` has no error handling and no input validation
`routes/onboarding.ts:84-171`. Unlike every other handler in the file (which has a `try/catch`
and a `pool` guard), `/configure` has neither. It does `body.services.map(...)` at L114/L130/L168
after only checking `businessName`. If `services` is missing/not an array, this throws a
`TypeError`; with no `try/catch` and Express 4's lack of async-rejection handling, the request
hangs/500s without a structured error. It also trusts `body` shape with no Zod schema (contrast
`/identity` and `/pack`, which use `BusinessIdentityInputSchema` / `PackPickInputSchema`).
- **Fix:** wrap in `try/catch`, add a Zod contract for the configure body, validate `services` is
  an array before mapping.

### 2. Onboarding routes bypass the request-scoped RLS client
`load-facts.ts` and `routes/onboarding.ts:197,367,414,453,493` issue **raw `pool.query(...)`**
against `tenant_settings` and `tenant_integrations`. Both tables are `FORCE ROW LEVEL SECURITY`
(`db/schema.ts:298-301`, and the tenant_integrations policy). The app mounts
`withTenantTransaction(pool)` (`app.ts:2354`) which opens a transaction, sets
`app.current_tenant_id` **LOCAL**, and stashes that client in AsyncLocalStorage for repositories
(`middleware/tenant-context.ts`). But `pool.query` checks out a **different** pooled connection
that has **no GUC set** — so the RLS policy `current_setting('app.current_tenant_id')::UUID`
either errors (unset GUC) or, if it "works" in the deployed environment, only does so because the
runtime DB role **bypasses RLS** (superuser / Supabase service role). In that case the sole tenant
guard for these queries is the explicit `WHERE tenant_id = $1`.
- **Why it matters:** this is inconsistent with the rest of the codebase (which routes tenant
  reads through `PgBaseRepository.withTenant` to inherit the GUC), and it's a latent isolation +
  correctness risk: the day the app runs under a least-privilege, RLS-enforced role, these
  endpoints break or, worse, a missing `WHERE` clause silently leaks. The codebase already has
  the correct escape hatch for legitimate cross-tenant reads (dedicated txn + `set_config(...)`,
  see `app.ts:1861-1884`).
- **Fix:** route these reads/writes through the request-scoped client (the repo pattern) instead
  of the raw pool, or — where a raw query is unavoidable — open a short transaction and
  `set_config('app.current_tenant_id', tenantId, true)` first. **Verify the deployed app role's
  RLS posture** to gauge current exposure.

### 3. v1 `/configure` cannot satisfy the derived `identity` step
`isIdentityDone()` (`derive-status.ts:30-36`) requires `businessName` **and** `jobBufferMinutes`
**and** `hourlyRateCents` **and** a non-empty `businessHours`. But `/configure` (the v1 path,
still the default when the v2 flag is off — `routes.ts:132`) writes only `businessName`,
`terminologyPreferences`, and `activeVerticalPacks`. It never sets `business_hours`,
`job_buffer_minutes`, or `hourly_rate_cents`. A tenant who onboards purely through v1 therefore
can **never** reach `identity: done`, so `isComplete` stays false.
- **Fix:** either have v1 collect/write those fields, relax `isIdentityDone` for the v1 flow, or
  confirm v1 is fully retired and remove it (see #7).

---

## P2 — Cleanup / consistency

### 4. Ambiguous source of truth for "pack activated"
`packActivated = activePackCount > 0 || settingsPacks > 0` (`load-facts.ts:74`) reads from **both**
`pack_activations` and `tenant_settings.active_vertical_packs`. `/configure` writes both but
**swallows** `activatePack` errors (`routes/onboarding.ts:144`), so `pack_activations` can be empty
while the settings array is populated — the step shows `done` even though the canonical
`pack_activations` row (which the E2E suite asserts on, `e2e/qa-matrix/provisioning.spec.ts`) is
missing. Pick one source of truth; don't dual-write/dual-read with divergent failure handling.

### 5. "retry" is the only Twilio enqueue path
The only place that enqueues `PROVISION_TWILIO_JOB_TYPE` is `POST /phone/retry`
(`routes/onboarding.ts:479-542`). There's no automatic enqueue when `identity`/`pack` complete —
the initial provisioning is kicked off by the frontend calling an endpoint named "retry" before
any attempt has happened. Consider an explicit `/phone/provision` (or auto-enqueue on pack
activation) so the semantics match the action.

### 6. `/pack` supports fewer verticals than `/configure`
`PackPickInputSchema` is `z.enum(['hvac','plumbing'])` (`contracts.ts:28-31`), but `SERVICE_TO_PACK`
(`routes/onboarding.ts:35-41`) maps five verticals (adds painting/electrical/contracting). So
`/configure` can activate verticals that `/pack` rejects. Align the two.

### 7. Two parallel onboarding flows = maintained tech debt
v1 (`OnboardingPage.tsx`, ~964 lines, `/configure`) and v2 (`OnboardingShell` + `/identity`/`/pack`)
are both live, gated by `isOnboardingV2Enabled()`. If v2 is the target, v1 + `/configure` is dead
weight carrying its own bugs (#1, #3). Confirm the flag rollout and delete the loser.

### 8. Minor
- Status polling every 3s has no backoff; fine at current scale.
- `normalizeSubscriptionStatus` accepts `incomplete` as valid but `isBillingDone` only treats
  `trialing`/`active` as done — intended, but worth a comment.

---

## Test coverage
Good: `test/onboarding/derive-status.test.ts` covers step transitions; integration tests exist for
`/identity`, `/pack`, `/status`, `/test-call/skip`; `useOnboardingStatus` hook is tested.
Gaps: no test for the `/configure` error path (missing `services`) — would have caught #1; nothing
asserts the raw-pool RLS behavior (#2); no test for the v1→`identity` completion divergence (#3).

## Suggested fix order
1. #1 (`/configure` guard+validation) and #3 (v1 identity completion) — correctness, small.
2. #2 (RLS client consistency) — after verifying the deployed role's RLS posture.
3. #7 (retire v1) — collapses #3, #4, #6 if v1 is removed.
4. #4, #5, #6 — consistency cleanups.

_Assessment only — no fixes applied. Recommend triaging #1–#3 before the next onboarding change._
