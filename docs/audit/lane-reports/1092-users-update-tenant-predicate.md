# #1092 — `PgUserRepository.update` has no tenant predicate (fix lane)

Branch: `fix/users-update-tenant-predicate`, cut from `origin/main`
(`48adcee` — "Merge pull request #1081 …").
Scope: the one-line tenant predicate + its RED-first integration test.
No RLS policy changes, no migrations, no route or permission changes, no
other product refactors. **Reviewed and merged by Josh only (auth change).**

---

## 1. The defect

`packages/api/src/users/pg-user.ts`, `update()` (was lines 299–335) ran:

```sql
UPDATE users SET <fields>, updated_at = NOW()
 WHERE id = $N
   AND deleted_at IS NULL
RETURNING …
```

with **no `tenant_id` predicate**. Every sibling method in the same file
carries one — `findById` (`AND tenant_id = $2`), `findByMobileNumber`,
`setMobileNumber`, `demoteOwnerIfAnotherExists`, `softDeleteSelf`,
`restoreAccount` — and `findByMobileNumber`'s own doc comment states the
convention: *"the WHERE clause filters on `tenant_id` explicitly in addition
to RLS … even if this runs in a context where RLS were ever misconfigured."*
This was an isolated omission, not a design choice.

`update()` backs `PATCH /api/users/:id` (`src/routes/users.ts:133-177`),
gated only by `requirePermission('users:edit_role')` — a permission every
owner holds **in their own tenant**. There is no per-row ownership check on
the route, and the service-layer last-owner guard
(`updateUser`, `src/users/user.ts:187-244`) is itself tenant-scoped: for a
foreign target, `repository.findById(tenantId, id)` returns null, so the
guard does not fire and the call falls straight through to `update()`.

**Blast radius:** any owner could change the `role`, `first_name`,
`last_name` or `can_field_serve` of any user id in any other tenant —
demote another tenant's sole owner (locking that tenant out of
`users:edit_role` / `users:invite`), or promote a foreign technician to
owner. User ids are UUIDs, so the attacker needs the victim's id, which
leaks through any surface that shows user ids.

Confirmed empirically below, through the real API at real Postgres: HTTP
200 and the victim row actually changed.

## 2. The exact change

`packages/api/src/users/pg-user.ts` — one parameter and one predicate, plus
a doc comment stating why the predicate is not redundant with RLS:

```diff
       setClauses.push(`updated_at = NOW()`);
       params.push(id);
+      params.push(tenantId);
       const result = await client.query(
         `UPDATE users SET ${setClauses.join(', ')}
          WHERE id = $${paramIndex}
+           AND tenant_id = $${paramIndex + 1}
            AND deleted_at IS NULL
          RETURNING id, tenant_id, clerk_user_id, email, role, first_name, last_name,
```

`RETURNING` is unchanged, and the existing `result.rows.length > 0 ? … :
null` tail is unchanged — so a non-matching row still yields `null` and the
route answers **404** for a foreign id exactly as it does for an unknown id
inside the caller's own tenant (`routes/users.ts:147-150`). The
zero-field early return (`if (setClauses.length === 0) return
this.findById(tenantId, id)`) was already tenant-scoped.

Nothing else in the repository, route, or permission layer changed.

## 3. RED → GREEN

New test: `packages/api/test/integration/users-update-tenant-predicate.test.ts`
— real Postgres (testcontainer / plain container), real `createApp()` boot,
real `PgUserRepository` + `PgAuditRepository`, no mocked DB anywhere.

Legs:

- **(a) THE HOLE at the real API** — tenant A's owner session PATCHes tenant
  B's owner id with `{role:'dispatcher'}` via supertest against `createApp()`
  (DEV_AUTH_BYPASS unsigned-JWT session, `DATABASE_URL` = the test DB):
  must 404, B's `users.role` unchanged on a **raw** read-back (role *and*
  `updated_at`), and no `audit_events` row under B.
- **(b) the repository seam** — `PgUserRepository.update(tenantA, userOfB,
  {role:'dispatcher', firstName:'Pwned'})` must return `null` and change
  nothing.
- **(c) control** — A's owner PATCHing A's own dispatcher still 200s, the row
  changes (`role`, `first_name`), and the `user.updated` audit row reads back
  through the real `PgAuditRepository.findByEntity`.
- **(d)** the tenant-scoped last-owner guard still refuses a demotion of the
  sole owner **within** the tenant (400, role unchanged).

Legs (a) and (b) each run **twice** — `RLS_RUNTIME_ROLE` off and on — against
their **own fresh victim tenant**, so no leg depends on a previous one having
left the row intact. See §5 for why the off case is the one that matters.

### RED (unfixed repository)

```
$ EXTERNAL_TEST_DB_URL=postgres://test:test@localhost:32768/serviceos_test \
  RLS_RUNTIME_ROLE=true npx vitest run --config vitest.integration.config.ts \
  --reporter=verbose test/integration/users-update-tenant-predicate.test.ts

 × …> (a) tenant A's owner cannot PATCH tenant B's owner through the real API [RLS_RUNTIME_ROLE=false] 160ms
   → expected 200 to be 404 // Object.is equality
 × …> (b) PgUserRepository.update(A, userOfB) returns null and changes nothing [RLS_RUNTIME_ROLE=false] 10ms
   → expected { …(13) } to be null
 ✓ …> (a) tenant A's owner cannot PATCH tenant B's owner through the real API [RLS_RUNTIME_ROLE=true] 19ms
 ✓ …> (b) PgUserRepository.update(A, userOfB) returns null and changes nothing [RLS_RUNTIME_ROLE=true] 6ms
 ✓ …> (c) control — A's owner PATCHing A's own dispatcher still succeeds and audits 18ms
 ✓ …> (d) the tenant-scoped last-owner guard still refuses a demotion within the tenant 13ms

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 2 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  … > (a) tenant A's owner cannot PATCH tenant B's owner through the real API [RLS_RUNTIME_ROLE=false]
AssertionError: expected 200 to be 404 // Object.is equality

- Expected
+ Received

- 404
+ 200

 ❯ test/integration/users-update-tenant-predicate.test.ts:178:28

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/2]⎯

 FAIL  … > (b) PgUserRepository.update(A, userOfB) returns null and changes nothing [RLS_RUNTIME_ROLE=false]
AssertionError: expected { …(13) } to be null

- Expected:
null

+ Received:
{
  "canFieldServe": false,
  "clerkUserId": "088c272e-6af6-406a-8cbc-6da3295324c5",
  "createdAt": 2026-09-12T21:05:49.993Z,
  "deletedAt": null,
  "email": "test@example.com",
  "firstName": "Pwned",
  "id": "088c272e-6af6-406a-8cbc-6da3295324c5",
  "lastName": undefined,
  "mobileNumber": undefined,
  "role": "dispatcher",
  "status": "active",
  "tenantId": "0f707118-65f6-469c-a4d3-1f6378a5f5bf",
  "updatedAt": 2026-09-12T21:06:00.517Z,
}

 ❯ test/integration/users-update-tenant-predicate.test.ts:213:25

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[2/2]⎯

 Test Files  1 failed (1)
      Tests  2 failed | 4 passed (6)
   Duration  12.11s
```

The received object in (b) is **tenant B's owner row** — `tenantId`
`0f707118…` is the victim tenant, not tenant A — returned with
`role: "dispatcher"` and `firstName: "Pwned"` already applied. The earlier
first RED run (single shared victim) also caught the route leg's raw
read-back: `expected 'dispatcher' to be 'owner'` on
`SELECT role FROM users WHERE id = <B's owner>`.

### GREEN (fixed repository, same command)

```
 ✓ …> (a) tenant A's owner cannot PATCH tenant B's owner through the real API [RLS_RUNTIME_ROLE=false] 126ms
 ✓ …> (b) PgUserRepository.update(A, userOfB) returns null and changes nothing [RLS_RUNTIME_ROLE=false] 6ms
 ✓ …> (a) tenant A's owner cannot PATCH tenant B's owner through the real API [RLS_RUNTIME_ROLE=true] 23ms
 ✓ …> (b) PgUserRepository.update(A, userOfB) returns null and changes nothing [RLS_RUNTIME_ROLE=true] 5ms
 ✓ …> (c) control — A's owner PATCHing A's own dispatcher still succeeds and audits 42ms
 ✓ …> (d) the tenant-scoped last-owner guard still refuses a demotion within the tenant 14ms

 Test Files  1 passed (1)
      Tests  6 passed (6)
   Duration  12.07s
```

## 4. Required runs

| Command | Result |
|---|---|
| the new file (GREEN, above) | `Test Files 1 passed (1)` / `Tests 6 passed (6)` |
| `npx vitest run test/users test/routes` | `Test Files 98 passed (98)` / `Tests 1178 passed (1178)` / `Duration 37.60s` |
| `RLS_RUNTIME_ROLE=true npx vitest run --config vitest.integration.config.ts test/integration/clerk-owner-membership.test.ts test/integration/users-update-tenant-predicate.test.ts` | `Test Files 2 passed (2)` / `Tests 12 passed (12)` / `Duration 13.00s` |
| `npx tsc --project tsconfig.build.json --noEmit` | exit 0, **no output** |

`npx tsc --noEmit` (the default tsconfig, which also compiles the test tree)
reports 572 errors — all pre-existing on `origin/main`, none in
`src/users/pg-user.ts` or the new test file. CLAUDE.md names
`tsconfig.build.json` as the deploy-parity gate; that one is clean.

## 5. Sweep — other `pg-*.ts` writes keyed on `id = $` without `tenant_id`

Method: every `packages/api/src/**/pg-*.ts` (98 files) scanned for
UPDATE/DELETE statements whose WHERE anchors on `id = $`; 106 such
statements, 12 without `tenant_id = $` in the WHERE. All 12 triaged below.
**Nothing else was fixed in this PR** — none of the residuals is both the
same one-liner and provable with the same kind of RED-first leg.

| file:line | statement | tenant predicate elsewhere in the statement? | verdict |
|---|---|---|---|
| `src/conversations/pg-conversation-link.ts:117` | `DELETE FROM conversation_links WHERE tenant_id = current_setting('app.current_tenant_id')::uuid AND id = $1` | **Yes** — via the GUC rather than a bind parameter | Scoped. Flagged only because the sweep pattern looks for `tenant_id = $`. No action. |
| `src/proposals/pg-proposal.ts:586` (`claimForExecution`) | `UPDATE proposals SET status='executing' … WHERE id = $1 AND status='approved'` | No | **Intentional cross-tenant.** Runs under `withCrossTenantSweep` (the auto-delivery worker); the method takes no `tenantId` and has no tenant context to filter on. Documented at `pg-proposal.ts:568-571`. No action. |
| `src/queues/pg-queue.ts:230` | `DELETE FROM _queue_messages WHERE id = $1` | No | `_queue_messages` has **no `tenant_id` column** (verified in the live schema). Infrastructure queue. No action. |
| `src/queues/pg-queue.ts:248` | `UPDATE _queue_messages SET last_error = $2 WHERE id = $1` | No | Same. No action. |
| `src/queues/pg-queue.ts:280` | `DELETE FROM _queue_messages WHERE id = $1` | No | Same. No action. |
| `src/settings/pg-pack-activation.ts:108` (`update(id, updates)`) | `UPDATE pack_activations SET … WHERE id = $N` | No | **The only genuine residual.** `pack_activations` **does** have `tenant_id`, and the statement runs under `withClient` — no tenant context at all, not even the GUC. Not exploitable on today's call paths: both callers (`activatePack`, `deactivatePack` — `src/settings/pack-activation.ts:60,108`) obtain the id from a tenant-scoped `findByTenantAndPack(tenantId, packId)` read, so the id is already proven to belong to the caller's tenant and is never attacker-supplied. Fixing it is **not** the same one-liner: the interface method (`PackActivationRepository.update`, `src/settings/pack-activation.ts:25`) takes no `tenantId`, so a fix changes the signature, both call sites, and the in-memory implementation. **Follow-up.** |
| `src/shared/pg-vertical-pack-registry.ts:236` | `UPDATE vertical_packs SET … WHERE id = $N` | No | `vertical_packs` is a **global** table with no `tenant_id` column (verified live); `pg-base.ts` documents `withClient` as the path "for global tables like vertical_packs". No action. |
| `src/users/pg-pending-invitation.ts:142` (`markAccepted(id)`) | `UPDATE pending_invitations SET accepted_at = NOW() WHERE id = $1` | No | Cross-tenant **by design** and documented in place: the Clerk `user.created` webhook identifies the invitation by id and has no tenant context (same case as `findById`/`findPendingByEmail` directly above it). The table does carry `tenant_id`, so this is a place where an id-guessing webhook forgery would mark a foreign invitation accepted — noted, but it is not a tenant-scoped method with a dropped filter, and it is outside this PR's scope. **Follow-up note only.** |
| `src/users/pg-user.ts:172` | `SELECT id FROM tenants WHERE id = $1 FOR UPDATE` | n/a | Not a write, and `tenants.id` **is** the tenant id (`tenants` is RLS-exempt by design — see the comment at `pg-user.ts:199-213`). No action. |
| `src/users/pg-user.ts:216` | `SELECT id FROM tenants WHERE id = $1 FOR UPDATE` | n/a | Same. No action. |
| `src/webhooks/pg-webhook.ts:96` | `UPDATE webhook_events SET status='processing' WHERE id = $1 AND …` | No | `webhook_events` has **no `tenant_id` column** (verified live). No action. |
| `src/webhooks/pg-webhook.ts:116` | `UPDATE webhook_events SET status = $1 … WHERE id = …` | No | Same. No action. |

## 6. RLS facts (report-only)

**Does `users` carry RLS policies?** Yes.

- `src/db/schema.ts:54-57`, migration `002_create_users`:
  `ALTER TABLE users ENABLE ROW LEVEL SECURITY;` and
  `CREATE POLICY tenant_isolation_users ON users USING (tenant_id =
  current_setting('app.current_tenant_id')::UUID);`
- `src/db/schema.ts:3260` (migration `130_force_rls_missing_tables`):
  `ALTER TABLE users FORCE ROW LEVEL SECURITY;`

Verified live on the evidence container:

```
 schemaname | tablename |       policyname       | cmd |                                 qual                                 | with_check
------------+-----------+------------------------+-----+----------------------------------------------------------------------+------------
 public     | users     | tenant_isolation_users | ALL | (tenant_id = (current_setting('app.current_tenant_id'::text))::uuid) |
(1 row)

 relname | rls_enabled | rls_forced
---------+-------------+------------
 users   | t           | t
(1 row)
```

**Would `RLS_RUNTIME_ROLE` have masked this hole in production?** **Yes, on a
correctly configured prod/staging deployment** — and no, anywhere the flag is
off.

- The app connects as a privileged principal, so the policy is a runtime
  no-op until the connection drops into the least-privilege, RLS-subject
  `rls_app_runtime` role, which `applyTenantContext` does **only** when
  `RLS_RUNTIME_ROLE=true` (`src/db/rls-runtime-role.ts:32-72`).
- `RLS_RUNTIME_ROLE=true` is a **hard prod/staging boot requirement**:
  `validateFeatureRequiredConfig` refuses to boot without it
  (`src/shared/config.ts:406-423`, SEC-01), and the boot probe
  `verifyRlsRuntimeRole` fails fast if the role is unprovisioned — so prod
  cannot silently run with enforcement absent
  (`docs/runbooks/rls-runtime-role-rollout.md`, "Go-live requirement
  (SEC-01)" and "Safety property").
- The same runbook states the flag is **default off in dev/test**. Every
  hermetic e2e/api path therefore runs unenforced — which is where the
  origin lane empirically demonstrated the hole, and where leg (a) of this
  PR's test reproduced it.

Empirically, both directions, at the evidence container (all statements
rolled back; the trailing `SELECT` shows the row untouched):

```
-- the UNFIXED statement, as the RLS runtime role, in tenant A's context
BEGIN; SET LOCAL ROLE rls_app_runtime;
SELECT set_config('app.current_tenant_id', '96a29b39-…', true);
UPDATE users SET role='dispatcher' WHERE id='e23c6f40-…' AND deleted_at IS NULL RETURNING id, tenant_id, role;
 id | tenant_id | role
----+-----------+------
(0 rows)
UPDATE 0
ROLLBACK

-- the same statement as the connection principal (what RLS_RUNTIME_ROLE=false gives)
BEGIN; SELECT set_config('app.current_tenant_id', '96a29b39-…', true);
UPDATE users SET role='dispatcher' WHERE id='e23c6f40-…' AND deleted_at IS NULL RETURNING id, tenant_id, role;
                  id                  |              tenant_id               |    role
--------------------------------------+--------------------------------------+------------
 e23c6f40-6ea7-4529-b8fa-d7ebe21b3912 | 360664c4-f161-4623-9fea-845d977fcbb5 | dispatcher
(1 row)
UPDATE 1
ROLLBACK

-- the FIXED statement, as the connection principal
BEGIN; SELECT set_config('app.current_tenant_id', '96a29b39-…', true);
UPDATE users SET role='dispatcher' WHERE id='e23c6f40-…' AND tenant_id='96a29b39-…' AND deleted_at IS NULL RETURNING …;
 id | tenant_id | role
----+-----------+------
(0 rows)
UPDATE 0
ROLLBACK

SELECT id, tenant_id, role FROM users WHERE id='e23c6f40-…';
                  id                  |              tenant_id               | role
--------------------------------------+--------------------------------------+-------
 e23c6f40-6ea7-4529-b8fa-d7ebe21b3912 | 360664c4-f161-4623-9fea-845d977fcbb5 | owner
(1 row)
```

`id='e23c6f40…'` is tenant B's owner; `96a29b39…` is tenant A. Same
statement, same row, same GUC — enforced only under the runtime role.

This is exactly why the fix is still required and why the test pins the
flag-off case: the repository's own stated convention is that the explicit
predicate holds as **defense in depth**, RLS is the second layer, and the
first layer was missing.

## 7. Evidence dumps (kept plain container, after the GREEN run)

```
docker run -d --rm -e POSTGRES_USER=test -e POSTGRES_PASSWORD=test \
  -e POSTGRES_DB=serviceos_test -p 127.0.0.1:0:5432 \
  pgvector/pgvector:pg16 -c max_connections=300     # → 127.0.0.1:32768
EXTERNAL_TEST_DB_URL=postgres://test:test@localhost:32768/serviceos_test …
```

`SELECT tenant_id, id, role FROM users` for the fixture tenants:

```
     fixture     |              tenant_id               |                  id                  |    role    | first_name
-----------------+--------------------------------------+--------------------------------------+------------+------------
 A (attacker)    | 96a29b39-c0ae-4c47-80d5-a8f0b3fa7e1f | 4724477e-81d3-409b-87bf-3f51f15bab49 | owner      |
 A (attacker)    | 96a29b39-c0ae-4c47-80d5-a8f0b3fa7e1f | 46f5de5e-d6a2-4086-8583-7b05e7c455bd | technician | Dana
 B repo  RLS off | 1f5f61d6-f271-4a91-825b-8e1d66a6e138 | f3b7e446-91de-47f1-a05d-007bc53ed2e1 | owner      |
 B repo  RLS on  | a43c1e4a-9898-4a4a-bd23-e50567189ee9 | 4a508960-0c2b-4daa-ad65-8d8af8e6ecda | owner      |
 B route RLS off | 360664c4-f161-4623-9fea-845d977fcbb5 | e23c6f40-6ea7-4529-b8fa-d7ebe21b3912 | owner      |
 B route RLS on  | 96592283-2f71-4fc3-9923-904689c1639d | d36f474e-3066-4c0a-8794-1a8c7678d044 | owner      |
(6 rows)
```

All four victim owners are still `owner`, with no `first_name` written —
the PATCH and the direct repository call left them untouched. Tenant A's
own dispatcher is the only row that moved (`dispatcher` → `technician`,
`first_name` → `Dana`), which is the positive control.

`audit_events` by tenant, same fixtures:

```
   fixture    |              tenant_id               | audit_rows | event_types
--------------+--------------------------------------+------------+--------------
 A (attacker) | 96a29b39-c0ae-4c47-80d5-a8f0b3fa7e1f |          1 | user.updated
(1 row)
```

One audit row in total, under tenant A, for tenant A's own successful edit.
**No audit row under any victim tenant** — the four victim tenants have no
`audit_events` rows at all, so they do not appear in the grouped result.

## 7b. A read-after-commit race in this test's own control leg (fixed)

PR CI on `41d02530` failed — in **this PR's new test**, not anywhere else:

```
 FAIL  test/integration/users-update-tenant-predicate.test.ts > #1092 … >
       (c) control — A's owner PATCHing A's own dispatcher still succeeds and audits
AssertionError: expected 'dispatcher' to be 'technician' // Object.is equality

Expected: "technician"
Received: "dispatcher"

 ❯ test/integration/users-update-tenant-predicate.test.ts:242:32

 Test Files  1 failed | 256 passed (257)
      Tests  1 failed | 1500 passed | 7 expected fail | 1 skipped (1509)
```

**Root cause, not a flake.** Under `/api` the `withTenantTransaction`
middleware COMMITs on `res.finish` — *after* the response is flushed
(`src/middleware/tenant-context.ts:24` and `:239`; the same asynchronous
response-time COMMIT that `routes/users.ts`'s account-deletion handler
documents at length). supertest resolves on the client side, so the raw
`SELECT` that leg (c) issued the instant the PATCH returned 200 ran on a
different pool connection and could still observe the pre-update row. The
assertion won that race on this machine and lost it on the slower CI runner.

**Fix:** a `readCommitted(read, settled)` helper that polls (25 ms, 10 s cap)
until the committed state is visible and otherwise returns the last value
seen, so a genuine failure still reports the real row. Applied to leg (c)'s
row read and its audit read — the two reads that follow a successful write.
Nothing was weakened: the value must still land in Postgres, it just isn't
required to have landed before the client socket closed. The cross-tenant
legs are untouched, because their primary detector is the response status (a
regression answers 200, not 404, and fails before any row is read).

**Re-verified both directions after the change**, since the test itself moved:

```
# product fix reverted (git checkout 3919dd9 -- packages/api/src/users/pg-user.ts)
 × (a) … [RLS_RUNTIME_ROLE=false]
 × (b) … [RLS_RUNTIME_ROLE=false]
 Test Files  1 failed (1)
      Tests  2 failed | 4 passed (6)

# fix restored
 Test Files  1 passed (1)
      Tests  6 passed (6)
```

and the whole suite, exactly as CI runs it (`npm run test:integration` →
`RLS_RUNTIME_ROLE=true vitest run --config vitest.integration.config.ts`):

```
 Test Files  257 passed (257)
      Tests  1501 passed | 7 expected fail | 1 skipped (1509)
   Duration  214.62s
```

## 8. Not done / notes for the reviewer

- **Not fixed:** `src/settings/pg-pack-activation.ts:108` (tenant-less
  `UPDATE pack_activations … WHERE id = $N`). Not exploitable on today's
  call paths (§5), and not the same one-liner — it needs an interface
  signature change plus both call sites and the in-memory implementation.
  Left for a follow-up issue rather than widened into this auth PR.
- **Not fixed:** `src/users/pg-pending-invitation.ts:142` `markAccepted(id)`
  — cross-tenant by design (webhook path, no tenant context). Noted, not
  changed.
- **Not touched:** RLS policies, migrations, routes, permissions, and the
  `users` route's 404 shape (the fix reuses the existing not-found path).
- **The pinned RED is now un-pinned, and that is the one change beyond the
  three commits above.** `e2e/journeys/accept-invitation.spec.ts` › *T1 — an
  owner cannot PATCH another tenant's user* (from `cloud/owner-surfaces-r5`,
  PR #1085) asserted the secure behavior under `test.fail(true, …)`. It
  reached this branch when the base merge to `41d02530` brought main's
  batch-5 merge in, and with the fix present the leg passes — which
  Playwright reports as a failure:

  ```
    1 failed
      [chromium] › e2e/journeys/accept-invitation.spec.ts:431:7 › … › T1 — an owner
      cannot PATCH another tenant's user …
      Expected to fail, but passed.
    4 passed (1.6m)
  ```

  Removing the `test.fail()` call (and rewriting its now-false comment into a
  regression note) is the only correct resolution: the leg's assertions were
  already the secure behavior. Nothing was skipped or weakened. Re-run of the
  same spec, unchanged otherwise:

  ```
    5 passed (1.5m)
  ```

  Command (the owner-surfaces lane's own recipe):
  ```bash
  TESTCONTAINERS_RYUK_DISABLED=true npx tsx e2e/fixtures/setup-test-db.ts
  CLERK_DEV_HMAC_TOKENS=true DB_SSL=false DATABASE_URL=<that url> \
    E2E_USE_TEST_DB=true \
    VITE_CLERK_PUBLISHABLE_KEY=pk_test_ZHVtbXkuY2xlcmsuYWNjb3VudHMuZGV2JA== \
    QA_CHROMIUM_PATH=/opt/pw-browsers/chromium-1194/chrome-linux/chrome \
    npx playwright test e2e/journeys/accept-invitation.spec.ts --project=chromium --reporter=line
  ```

  The base merge brought **no** `packages/api/src` or `packages/web/src`
  changes (`git diff --stat ff8dde7 41d0253 -- packages/api/src
  packages/web/src` is empty), so the API runs in §4 still stand.
- No PRD rung is claimed here — only Fable states rungs.
- The PR is a **draft** and must not be merged or marked ready by this lane.
