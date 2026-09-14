# Second-tenant-rows lane report — issue #995 (Sonnet, test-only rows)

Branch: `cloud/second-tenant-rows` (off `origin/main`, `137dc55`).
Scope: rows demoted to **3** by the §8.1/§8.9 entry audits for T0 (no
neighbour tenant) or a missing audit leg: **1.1, 1.11, 1.2, 1.4** (team
signup/onboarding), plus **9.10, 9.9** (correction-repetition lessons). No
file under `packages/api/src`, `packages/web/src`, or `packages/mobile/src`
was modified — every change in this lane is a test file or this report.

Per #995's map rules: **only Fable states a new rung.** This report gives
commands, raw output, evidence class, and tenant-grade grep per row; it does
not claim a rung.

All six rows were pinned test-first: each new assertion was first written
with a deliberately wrong expected value, run once (RED, failing for the
wrong-value reason only), then corrected and re-run (GREEN). Full raw
RED/GREEN logs for every row are kept in the session scrollback and excerpted
below; abbreviated JSON log lines (`{"level":"info",...}`) are the app's own
structured logger output, unrelated to the assertions.

Commits on this branch (one per row):

```
4bda29e test(1.1): neighbour tenant + audit leg + replay-window for clerk signup
f095601 test(1.11): Clerk-down invite persistence, last-owner guard, tenant isolation
491ef27 test(1.2): neighbour tenant isolation for onboarding identity upsert
ea4fe0b test(1.4): neighbour tenant isolation for derived onboarding status
f3dfd32 test(9.10): neighbour tenant threshold + meta-proposal read isolation
54a276e test(9.9): second undo of an already-reverted correction lesson is a no-op
```

---

## Row 1.1 — Clerk signup webhook: replay, audit, neighbour tenant

G1 (#1006): demoted to **3** — T0 (no neighbour tenant), no audit leg.

**File:** `packages/api/test/integration/clerk-owner-membership.test.ts`
**Command:**
```
cd packages/api && RLS_RUNTIME_ROLE=true npx vitest run --config vitest.integration.config.ts --reporter=verbose test/integration/clerk-owner-membership.test.ts
```

**What was added:** three assertions on the real `/webhooks/clerk` route
(`createWebhookRouter` + `PgTenantRepository` + `PgAuditRepository`, real
Postgres):
1. A **genuine re-delivery** (two distinct svix ids, same Clerk user —
   not a literal same-id replay, which the event-id dedup short-circuits
   before ever reaching `bootstrapTenant`) still yields exactly one tenant
   and one owner row — `bootstrapTenant`'s `findByOwner` guard, not just
   event-id dedup, is what's pinned. The `tenant.signup.bootstrap.completed`
   audit event is read back through `PgAuditRepository.findByEntity`, not a
   raw SELECT. A neighbour tenant (provisioned first, independently) is
   asserted unchanged (same single-owner row, same role) after tenant A's
   re-delivery.
2. The replay-window clause (`SVIX_TOLERANCE_SECONDS = 300` in
   `webhooks/routes.ts`) is exercised directly: a webhook signed 600s stale
   is rejected 400 before signature verification, and no user row is
   created.

**TDD — RED:**
```
✗ a genuinely re-delivered signup ... tenantCount.rows[0].n → expected 1 to be 2
✗ rejects a Clerk webhook whose svix-timestamp is outside the 5-minute replay window ... res.status → expected 400 to be 200
 Tests  2 failed | 1 passed (3)
```
(An intermediate RED also caught a setup gap: `bootstrapEvents.length toBeGreaterThanOrEqual(1)` failed with `0`, because `auditRepo` was not yet wired into `createWebhookRouter`'s deps in `beforeAll` — fixed by adding `auditRepo: new PgAuditRepository(pool)` to the router deps.)

**GREEN:**
```
✓ creates an owner users row (role=owner) and does not duplicate on replay 87ms
✓ a genuinely re-delivered signup (distinct svix ids, same Clerk user) still yields exactly one tenant, and a neighbour tenant is untouched 47ms
✓ rejects a Clerk webhook whose svix-timestamp is outside the 5-minute replay window 5ms
 Test Files  1 passed (1)
      Tests  3 passed (3)
```

**Evidence class:** D — real Postgres write + read-back through the
production webhook route + `PgTenantRepository` + `PgAuditRepository`, no
mocked DB, no in-memory audit repo.

**Tenant grade:** T1 confirmed —
```
grep -nE "tenantB|otherTenant|secondTenant|cross-tenant|another tenant|across tenants" test/integration/clerk-owner-membership.test.ts
113:    // The tenantB assertions below prove tenant A's re-delivery never
115:    const tenantBClerkUserId = `user_owner_${crypto.randomUUID()}`;
...
196:    const tenantBAfter = await pool.query(
200:    expect(tenantBAfter.rowCount).toBe(1);
201:    expect(tenantBAfter.rows[0].n).toBe(1);
202:    expect(tenantBAfter.rows[0].role).toBe(tenantBRoleBefore);
```
(full match list in the "Tenant-grade greps, final" section below).

---

## Row 1.11 — Team invitations: Clerk-down persistence, last-owner guard, isolation

G1 (#1006): demoted to **3** — T0, no audit leg. Same file as 1.1.
(Note: the PRD's row narrative originally flagged `/accept-invitation` as a
missing web route, but that was already fixed by #1010 — confirmed against
the current tree: `packages/web/src/routes.ts:286` registers the route,
`AcceptInvitationPage` implements it, and `e2e/journeys/accept-invitation
.spec.ts` exercises it. No 404 gap remains; no product code was touched in
this lane regardless.)

**File:** `packages/api/test/integration/clerk-owner-membership.test.ts`
(second `describe` block, same file as row 1.1)
**Command:** same as row 1.1 (both describes run together).

**What was added:** a second `describe` block drives the real
`createUsersRouter` (routes/users.ts) with two live tenants (A and B,
selected per-request via an `x-test-tenant` header) against real Postgres:
1. `POST /api/users/invitations` with `clerkSecretKey` set but `clerkFetch`
   stubbed to always throw (simulated Clerk outage) — the local
   `pending_invitations` row is still written (`inviteTeamMember`'s
   "local row first" ordering) and the `user.invited` audit event is read
   back through `PgAuditRepository.findByEntity`.
2. `PATCH /api/users/:id` demoting tenant A's only owner is rejected 400
   (`updateUser`'s last-owner guard in `src/users/user.ts`, backed by the
   real `PgUserRepository`) and the role is unchanged in the DB.
3. Tenant B's invitation is invisible under tenant A — both via the route's
   `GET /invitations` response and via a direct
   `PgPendingInvitationRepository.findByTenant` call.

**TDD — RED:**
```
✗ writes the local invitation row even when Clerk is down, and audits it ... res.status → expected 201 to be 500
✗ the last owner cannot be demoted (real PgUserRepository guard) ... res.status → expected 400 to be 200
✓ tenant B's invitation never appears under tenant A
 Tests  2 failed | 4 passed (6)
```

**GREEN:**
```
✓ creates an owner users row (role=owner) and does not duplicate on replay 106ms
✓ a genuinely re-delivered signup ... 47ms
✓ rejects a Clerk webhook whose svix-timestamp is outside the 5-minute replay window 5ms
✓ writes the local invitation row even when Clerk is down, and audits it 28ms
✓ the last owner cannot be demoted (real PgUserRepository guard) 12ms
✓ tenant B's invitation never appears under tenant A 27ms
 Test Files  1 passed (1)
      Tests  6 passed (6)
```

**Evidence class:** D — real Postgres write + read-back through the
production invitations route, `PgUserRepository`'s atomic
`demoteOwnerIfAnotherExists`/last-owner pre-check, and
`PgPendingInvitationRepository`; only the outbound `fetch` to
`api.clerk.com` is stubbed.

**Tenant grade:** T1 confirmed — see the combined grep above/below;
`tenantB`/`x-test-tenant` selection appears at lines 242, 247, 259, 349.

---

## Row 1.2 — Onboarding identity: neighbour-tenant isolation

G1 (#1006): demoted to **3** — T0, "printed rung 5 ... had no reachability
run behind them" per the map ticket.

**File:** `packages/api/test/integration/onboarding-identity.test.ts`
**Command:**
```
cd packages/api && RLS_RUNTIME_ROLE=true npx vitest run --config vitest.integration.config.ts --reporter=verbose test/integration/onboarding-identity.test.ts
```

**What was added:** one test acting as tenant A then tenant B (swapping the
shared `currentTenant` the request-auth middleware reads) against the real
`PUT /api/onboarding/identity` route + `PgSettingsRepository`:
- Tenant B upserts its own identity twice — once with `serviceAreaRadius:
  99`, once with an explicit `serviceAreaRadius: null` (the #874 tri-state)
  — and neither write changes tenant A's `tenant_settings` row
  (`business_name` stays `'Tenant A Co'`, `service_area_radius` stays `40`).
- `tenant.identity_set` audit events are read back per tenant through
  `PgAuditRepository.findByEntity`: tenant A has exactly 1 (from its own
  earlier PUT in this test), tenant B has exactly 2 (from its two PUTs).

**TDD — RED:**
```
✗ a neighbour tenant's identity upsert never changes tenant A's row, and audit events are per tenant
   rowA.rows[0].business_name → expected 'Tenant A Co' to be 'Tenant B Co'
 Tests  1 failed | 5 passed (6)
```

**GREEN:**
```
✓ rejects payload missing businessName with 400 59ms
✓ upserts on valid payload (no prior row) and step 2 becomes done 86ms
✓ updates an existing tenant_settings row in place (idempotent) 34ms
✓ serviceAreaRadius: omitted keeps the stored value, null clears it (#874) 33ms
✓ emits a tenant.identity_set audit event 14ms
✓ a neighbour tenant's identity upsert never changes tenant A's row, and audit events are per tenant 38ms
 Test Files  1 passed (1)
      Tests  6 passed (6)
```

**Evidence class:** D — real Postgres upsert through
`createOnboardingRouter` + `PgSettingsRepository` + `PgAuditRepository`.

**Tenant grade:** T1 confirmed —
```
grep -nE "tenantB|otherTenant|secondTenant|cross-tenant|another tenant|across tenants" test/integration/onboarding-identity.test.ts
149:    const tenantB = await createTestTenant(pool);
163:    currentTenant = tenantB;
190:    const auditB = await auditRepo.findByEntity(tenantB.tenantId, 'tenant_settings', tenantB.tenantId);
```

---

## Row 1.4 — Onboarding status: neighbour-tenant isolation

G1 (#1006): demoted to **3** — T0, "printed rung 5 on 1.2, 6.2 and 6.4 had
no reachability run behind them."

**File:** `packages/api/test/integration/onboarding-status.test.ts`
**Command:**
```
cd packages/api && RLS_RUNTIME_ROLE=true npx vitest run --config vitest.integration.config.ts --reporter=verbose test/integration/onboarding-status.test.ts
```

**What was added:** one test that first confirms tenant A is fresh
(`currentStep: 'identity'`), then drives a neighbour tenant B to full
onboarding completion (settings + pack + AI-check + Twilio integration +
subscription + a voice session — the same fixture as the existing
`isComplete=true` test), then re-checks tenant A's `GET /status` is
unchanged (`currentStep: 'identity'`, `isComplete: false`).

**No audit leg** — by design, not omission: `GET /status`
(`routes/onboarding.ts`) calls `deriveOnboardingStatus` over
`settingsRepo`/`packActivationRepo`/`pool` reads only; a targeted grep of
the entire GET handler body (lines 82–~230) found zero `auditRepo` calls —
`router.put` is the only place `auditRepo` appears in this file. The report
states this plainly rather than fabricating a read-back assertion.

**TDD — RED:**
```
✗ tenant A's derived status is unchanged by a neighbour tenant's configuration (T1)
   afterB.body.currentStep → expected 'identity' to be null
 Tests  1 failed | 3 passed (4)
```

**GREEN:**
```
✓ returns identity as current step for a fresh tenant (no settings row) 109ms
✓ marks identity done when all four fields present 18ms
✓ isComplete=true when all 7 steps satisfied 18ms
✓ tenant A's derived status is unchanged by a neighbour tenant's configuration (T1) 34ms
 Test Files  1 passed (1)
      Tests  4 passed (4)
```

**Evidence class:** D for the underlying fixtures (real Postgres rows
across `tenant_settings`, `tenant_integrations`, `tenants`, `voice_sessions`)
driving a real read path; the row itself has no audit leg to pin (see
above).

**Tenant grade:** T1 confirmed —
```
grep -nE "tenantB|otherTenant|secondTenant|cross-tenant|another tenant|across tenants" test/integration/onboarding-status.test.ts
102:    const tenantB = await createTestTenant(pool);
114..126: [tenantB.tenantId], ...
129:    currentTenant = tenantB;
```

---

## Row 9.10 — Correction-repetition meta-proposal: threshold + read isolation

G1: T0/no-neighbour-tenant demotion per the same audit sweep (§8.1/§8.9
correction-lesson rows).

**File:** `packages/api/test/integration/correction-repetition-meta-proposal.test.ts`
**Command:**
```
cd packages/api && RLS_RUNTIME_ROLE=true npx vitest run --config vitest.integration.config.ts --reporter=verbose test/integration/correction-repetition-meta-proposal.test.ts
```

**What was added:** one test with a second tenant (fresh catalog SKU,
independent of the cumulative count the earlier two tests in this file
build up on the shared `catalogItemId`):
- Tenant B logs exactly **two** same-target `part_price_changed`
  corrections — below the 3-strike threshold — and
  `detectCorrectionRepetition` emits **zero** proposals.
- Tenant A's **third** correction (on its own fresh SKU) still crosses the
  threshold and mints exactly one `update_catalog_item` meta-proposal.
- Tenant B cannot read tenant A's meta-proposal: `proposalRepo
  .findByCorrectionTarget(tenantB.tenantId, ...)` doesn't contain it, and
  `proposalRepo.findById(tenantB.tenantId, metaProposalId)` returns `null`.
- Audit read-back: `auditRepo.findByEntity(tenant.tenantId, 'proposal',
  metaProposalId)` contains `correction_repetition.proposed`; the same
  query under `tenantB.tenantId` returns an empty array.

**TDD — RED:**
```
✗ a second tenant's two corrections mint no meta-proposal; tenant A's third does; tenant B cannot read it
   emittedB → expected [] to have a length of 1 but got +0
 Tests  1 failed | 2 passed (3)
```

**GREEN:**
```
✓ countByTarget counts same-SKU part_price lessons (JSONB query, real columns) 14ms
✓ full loop: 3rd correction → meta-proposal → approve → executor updates catalog 60ms
✓ a second tenant's two corrections mint no meta-proposal; tenant A's third does; tenant B cannot read it 55ms
 Test Files  1 passed (1)
      Tests  3 passed (3)
```

**Evidence class:** D — real Postgres through `PgCatalogItemRepository`,
`PgProposalRepository` (including its tenant-scoped `findByCorrectionTarget`
and `findById`), `PgCorrectionLessonRepository`, `PgAuditRepository`; the
detector (`detectCorrectionRepetition`) is the production function, not a
stub.

**Tenant grade:** T1 confirmed —
```
grep -nE "tenantB|otherTenant|secondTenant|cross-tenant|another tenant|across tenants" test/integration/correction-repetition-meta-proposal.test.ts
156:    const tenantB = await createTestTenant(pool);
...
242:      tenantB.tenantId,
248:    const byIdFromB = await proposalRepo.findById(tenantB.tenantId, metaProposalId);
255:    const auditFromB = await auditRepo.findByEntity(tenantB.tenantId, 'proposal', metaProposalId);
```

---

## Row 9.9 — Correction-loop: second undo is a no-op

Scope note per the task: this row's gap was the **missing assertion
clause**, not a missing neighbour tenant (this file already had two
cross-tenant tests — `FORCE RLS isolates correction_lessons across
tenants` and the `findBySourceProposal` cross-tenant check — before this
lane). No new neighbour-tenant test was needed or added for 9.9 itself.

**File:** `packages/api/test/integration/correction-loop.test.ts`
**Command:**
```
cd packages/api && RLS_RUNTIME_ROLE=true npx vitest run --config vitest.integration.config.ts --reporter=verbose test/integration/correction-loop.test.ts
```

**What was added:** one test pinning `undoCorrectionLesson`'s existing
`if (lesson.status === 'reverted') return lesson;` short-circuit
(`src/learning/corrections/apply-undo.ts`): after a first undo reverts a
labor-rate lesson (catalog price back to 9000), the price is manually
bumped to 9999 (simulating an operator's subsequent edit), then the SAME
lesson is undone a second time. The test asserts:
- the catalog price is **still 9999** (the second undo did NOT re-run
  `revertLessonConfig` and stomp it back to 9000);
- exactly **one** `correction_lesson.reverted` audit row exists for that
  lesson (the second call did not write a duplicate).

**TDD — RED:**
```
✗ a second undo of an already-reverted lesson is a no-op
   afterSecond!.unitPriceCents → expected 9999 to be 9000
 Tests  1 failed | 4 passed (5)
```

**GREEN:**
```
✓ persists a lesson with real columns and a labor edit changes the next same-day draft 63ms
✓ FORCE RLS isolates correction_lessons across tenants 22ms
✓ executor path: a drafted-vs-executed payload edit cascades, and the next same-day draft reflects it 35ms
✓ findBySourceProposal returns every lesson a proposal recorded (drives undo) 24ms
✓ a second undo of an already-reverted lesson is a no-op 39ms
 Test Files  1 passed (1)
      Tests  5 passed (5)
```

**Evidence class:** D — real Postgres through `PgCorrectionLessonRepository`,
`PgCatalogItemRepository`, `PgAuditRepository`; `undoCorrectionLesson` is
the production function.

**Tenant grade:** N/A for this specific assertion (see scope note above);
the file overall is T1 (pre-existing cross-tenant coverage retained,
confirmed unaffected — see the combined regression run below).

---

## Full-suite regression (all 6 rows together)

```
cd packages/api && RLS_RUNTIME_ROLE=true npx vitest run --config vitest.integration.config.ts --reporter=verbose \
  test/integration/clerk-owner-membership.test.ts \
  test/integration/onboarding-identity.test.ts \
  test/integration/onboarding-status.test.ts \
  test/integration/correction-repetition-meta-proposal.test.ts \
  test/integration/correction-loop.test.ts

 Test Files  5 passed (5)
      Tests  24 passed (24)
```

## Build verification

```
cd packages/api && npx tsc --project tsconfig.build.json --noEmit
```
Clean (no output). Expected: this lane touches only `test/integration/*`
files, which `tsconfig.build.json` excludes by design (it's scoped to the
Railway production build) — the check confirms no production-code
regression, not that the new tests themselves type-check under this config
(vitest's own transpilation covers that; the GREEN runs above are proof the
tests execute).

`git status --porcelain` — empty (all six rows committed).

---

## Evidence (artifact-before-sign-off), fresh plain container

Per-row runs above used the shared testcontainer from vitest's own
`globalSetup`. For the sign-off artifact, a SEPARATE plain
`pgvector/pgvector:pg16` container was started fresh and kept running, and
all five touched files were re-run against it via `EXTERNAL_TEST_DB_URL`
(global-setup applies migrations to any externally-provided Postgres, same
migration path as the testcontainer):

```
docker run -d --rm -e POSTGRES_USER=test -e POSTGRES_PASSWORD=test -e POSTGRES_DB=serviceos_test -p 127.0.0.1:0:5432 pgvector/pgvector:pg16 -c max_connections=300
# → container 2b39c2b35296, host port 32768

cd packages/api && EXTERNAL_TEST_DB_URL=postgres://test:test@localhost:32768/serviceos_test RLS_RUNTIME_ROLE=true \
  npx vitest run --config vitest.integration.config.ts --reporter=verbose \
  test/integration/clerk-owner-membership.test.ts \
  test/integration/onboarding-identity.test.ts \
  test/integration/onboarding-status.test.ts \
  test/integration/correction-repetition-meta-proposal.test.ts \
  test/integration/correction-loop.test.ts

 Test Files  5 passed (5)
      Tests  24 passed (24)
```

### `audit_events` — grouped by tenant / event_type / entity_type

```
docker exec 2b39c2b35296 psql -U test -d serviceos_test -P pager=off -c \
  "SELECT left(tenant_id::text,8), event_type, entity_type, count(*) FROM audit_events GROUP BY 1,2,3 ORDER BY 2,1;"

   left   |            event_type             |    entity_type     | count
----------+-----------------------------------+--------------------+-------
 0271a236 | catalog_item.updated              | catalog_item       |     1
 716df236 | correction_lesson.applied         | correction_lesson  |     6
 716df236 | correction_lesson.reverted        | correction_lesson  |     3
 0271a236 | correction_repetition.proposed    | proposal           |     2
 0271a236 | proposal.executed                 | proposal           |     1
 12763e45 | tenant.identity_set               | tenant_settings    |     1
 18f31ce4 | tenant.identity_set               | tenant_settings    |     1
 8d330cb3 | tenant.identity_set               | tenant_settings    |     1
 ac49dfdc | tenant.identity_set               | tenant_settings    |     2
 df60959a | tenant.identity_set               | tenant_settings    |     3
 f714fa00 | tenant.identity_set               | tenant_settings    |     2
 57b2095b | tenant.signup.bootstrap.completed | tenant             |     1
 5cba8a4d | tenant.signup.bootstrap.completed | tenant             |     1
 9b968891 | tenant.signup.bootstrap.completed | tenant             |     2
 06cb37fd | user.invited                      | pending_invitation |     1
 893a7c91 | user.invited                      | pending_invitation |     1
(16 rows)
```

Sanity notes on this table:
- `716df236 / correction_lesson.reverted = 3`: three SUCCESSFUL reverts
  across `correction-loop.test.ts` (test 1's undo, the executor-path test's
  undo, and row 9.9's first undo) — the row 9.9 SECOND undo call correctly
  added no fourth row, which is exactly what that row's assertion pins.
- `0271a236 / correction_repetition.proposed = 2`: the pre-existing "full
  loop" test's proposal plus row 9.10's fresh-SKU tenant-A proposal — both
  under tenant A only; tenant B's two-correction run in row 9.10 correctly
  minted none.
- `9b968891 / tenant.signup.bootstrap.completed = 2`: row 1.1's
  genuinely-re-delivered-signup test — two distinct svix ids both reaching
  the (not `result.created`-gated) audit block, exactly as
  `webhooks/routes.ts` is written; `bootstrapTenant`'s own idempotency is
  what kept the tenant/owner-row counts at 1 despite this.

### `tenants`, `users`, `pending_invitations`, `tenant_settings`, `correction_lessons`, `proposals`

```
=== tenants (22 rows, ids truncated to 8 chars) ===
 id       | owner_id (trunc)      | name
----------+-----------------------+----------------------------------------------------
 a6fa780b | 3d48d3ee-a9c3-41b6-8  | Test Tenant
 8d330cb3 | a519637e-003e-4210-8  | Test Tenant
 f714fa00 | f61fe560-5863-4817-a  | Test Tenant
 df60959a | 35359740-db6c-4339-a  | Test Tenant
 12763e45 | 826cdb49-2610-4160-9  | Test Tenant
 18f31ce4 | 65c676e3-bb06-4176-8  | Test Tenant
 ac49dfdc | 2d699739-6a64-4e97-9  | Test Tenant
 716df236 | cdd439e2-cdd3-4fb6-9  | Test Tenant
 c1782b95 | 0f3c7caa-3f50-4dd7-a  | Test Tenant
 9e650543 | 4e1c47e4-a570-45a0-8  | Test Tenant
 0271a236 | 3e84d7a9-0d84-467e-b  | Test Tenant
 882af100 | b4256f1c-85b2-4e0c-8  | Test Tenant
 5cba8a4d | user_owner_7159e9ed-  | e0843719-61f6-4e06-9cb9-e58695141c4f's Organization
 57b2095b | user_owner_e4240f0f-  | 4a08573e-fc3a-4895-979d-93297b18d5c8's Organization
 9b968891 | user_owner_00a1067e-  | b657decc-a7c7-4c2b-a14e-ce0e9cf48a04's Organization
 893a7c91 | 897379fe-ed74-432d-8  | Test Tenant
 06cb37fd | 178c42ef-d52a-418f-b  | Test Tenant
 eba4b001 | ce158582-151c-4416-a  | Test Tenant
 0d66847c | 821d7e0e-282f-41d7-a  | Test Tenant
 09a55172 | 69e7c170-cb5b-4f2f-9  | Test Tenant  (subscription_status='trialing')
 59830c6c | 41746c79-7aab-4bc9-b  | Test Tenant
 addbee62 | ddbef368-61a6-4797-8  | Test Tenant  (subscription_status='trialing')
(22 rows)

=== users (22 rows) — every tenant above has exactly one owner row, all active, none deleted ===
(id, tenant_id, role='owner', deleted_at=NULL, status='active') × 22

=== pending_invitations (2 rows) ===
 id       | tenant_id | email                                                      | role       | accepted_at
----------+-----------+------------------------------------------------------------+------------+-------------
 0a5d24a6 | 893a7c91  | invitee-83903725-4580-4b00-b62f-0d3c27c0ef93@example.com    | technician |
 9ed4a741 | 06cb37fd  | otherco-c97e9cba-2f13-486c-ab6f-46fa16b71198@example.com    | technician |
(893a7c91 = row 1.11's tenant A "Clerk down" invite; 06cb37fd = row 1.11's
tenant B invite that must stay invisible under tenant A — confirmed, tenant
A's row is 0a5d24a6/893a7c91 only.)

=== tenant_settings (9 rows) ===
 tenant_id | business_name | service_area_radius
-----------+---------------+---------------------
 09a55172  | Acme          |
 0d66847c  | Acme          |
 12763e45  | A             |
 18f31ce4  | Tenant A Co   |                  40
 8d330cb3  | Acme HVAC     |                  25
 ac49dfdc  | Tenant B Co   |
 addbee62  | Neighbour Co  |
 df60959a  | Radius Co     |
 f714fa00  | V2            |
(18f31ce4 = row 1.2's tenant A, radius 40, untouched by ac49dfdc = tenant
B's radius-99-then-null writes, which correctly left tenant B's own row at
NULL and never touched tenant A's 40.)

=== correction_lessons (14 rows) ===
 id       | tenant_id | lesson_type         | status   | local_date
----------+-----------+---------------------+----------+------------
 cffae71d | 0271a236  | part_price_changed  | applied  | 2026-07-11
 eeef765e | 0271a236  | part_price_changed  | applied  | 2026-07-11
 07bb2b89 | 0271a236  | part_price_changed  | applied  | 2026-07-11
 7efe7f56 | 882af100  | part_price_changed  | applied  | 2026-07-12   ← row 9.10 tenant B, 1st
 ada7beae | 882af100  | part_price_changed  | applied  | 2026-07-12   ← row 9.10 tenant B, 2nd (no 3rd — no proposal)
 d6b18548 | 0271a236  | part_price_changed  | applied  | 2026-07-12
 dd0d3c87 | 0271a236  | part_price_changed  | applied  | 2026-07-12
 491be8de | 0271a236  | part_price_changed  | applied  | 2026-07-12   ← row 9.10 tenant A 3rd (fresh SKU) → proposal minted
 ada3fba3 | 716df236  | labor_rate_changed  | reverted | 2026-06-14
 2bddc94a | 716df236  | labor_rate_changed  | applied  | 2026-06-14
 d1ce262a | 716df236  | labor_rate_changed  | reverted | 2026-06-14
 89a3e8b6 | 716df236  | labor_rate_changed  | applied  | 2026-06-14
 5e836d35 | 716df236  | banned_phrase       | applied  | 2026-06-14
 77f04a96 | 716df236  | labor_rate_changed  | reverted | 2026-06-15   ← row 9.9's lesson, status stayed 'reverted' through BOTH undo calls
(14 rows)

=== proposals (update_catalog_item only) ===
 id       | tenant_id | proposal_type        | status
----------+-----------+----------------------+------------------
 6e90ea8c | 0271a236  | update_catalog_item  | executed          ← pre-existing "full loop" test
 0cd9f63e | 0271a236  | update_catalog_item  | ready_for_review  ← row 9.10's tenant-A meta-proposal
(2 rows; NONE under tenant 882af100 — row 9.10's tenant B correctly minted zero)
```

The evidence container (`2b39c2b35296...`, host port 32768) was left
running per the task's "start a plain container you keep" instruction — not
torn down as part of this report.

## Tenant-grade greps, final (all five touched files)

```
=== clerk-owner-membership.test.ts ===
113,115-136,196-202: tenantB* (row 1.1's neighbour-tenant block)
242,247,259,349: tenantB (row 1.11's describe-level neighbour tenant)

=== onboarding-identity.test.ts ===
149: const tenantB = await createTestTenant(pool);
163: currentTenant = tenantB;
190: const auditB = await auditRepo.findByEntity(tenantB.tenantId, 'tenant_settings', tenantB.tenantId);

=== onboarding-status.test.ts ===
102: const tenantB = await createTestTenant(pool);
114-126: [tenantB.tenantId], ...
129: currentTenant = tenantB;

=== correction-repetition-meta-proposal.test.ts ===
156: const tenantB = await createTestTenant(pool);
161,197,199,201,204,242,248,255: tenantB.*

=== correction-loop.test.ts ===
5: * - correction_lessons columns + FORCE RLS isolate across tenants. (doc comment, pre-existing)
145: it('FORCE RLS isolates correction_lessons across tenants', ...) (pre-existing test, row 9.9 added no new tenantB — see scope note in row 9.9 above)
```

## Not done / judgment calls

- **1.11 scope correction (post-review):** the PRD narrative for 1.11
  originally flagged `/accept-invitation` as a missing web route (a 404 on
  every invite email). That was stale — #1010 already added it (route +
  `AcceptInvitationPage` + a passing e2e spec), confirmed against the
  current tree. This lane's earlier draft repeated the stale claim; it is
  corrected here rather than silently fixed, per Codex review on PR #1074.
  No product code was touched in this lane either way.
- **1.4 has no audit leg by design**, not an oversight — see the row's
  section above for the grep basis (`GET /status` never calls
  `auditRepo.create`).
- **9.9 has no new tenant-isolation assertion** — the file already carried
  two (kept, and confirmed still green); row 9.9's gap was specifically the
  missing "second undo" clause, which is what was added.
- Evidence-container `tenants`/`users` totals (22 each) include the
  bootstrap and per-file fixture tenants from ALL FIVE files' full test
  suites (not just the new assertions) — this is expected: the evidence run
  re-executes every existing test in each file too, not only the new ones.
