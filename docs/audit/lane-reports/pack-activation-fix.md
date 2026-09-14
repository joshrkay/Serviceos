# Lane report — pack activation: guard scope (#1083) and tenant-scoped updates (#1095)

Branch: `fix/pack-activation-scope-and-race` (off `origin/main` @ `2a68465`)
Commits: RED tests (`142df7f`) → fixes (`5b2b112`) → report (`020a270`) →
round 2, after review: RED (`37040f5`) → fix (`c11a2f1`) →
round 3, after review: RED (`761d2a7`) → fix (`d13bb40`) → this update
Constraints honoured: no RLS policy changes, no migrations, no route or
permission changes.

**Round 2 (review response).** xhawk-ai's Medium correctness finding on PR
#1106 was right and is fixed: moving the settings write behind the pack
lock covered the *loser* of the lock, but the lock is keyed by (tenant,
pack) while `tenant_settings` is keyed by tenant, so the lock's **winner**
could still take the same 23505 from another first-row writer. Round 2 is
the fix for that; §"Defect 1, part 2" below has the mechanism and the RED.
It also subsumes what round 1 had listed under "not done" as the cross-pack
residual.

**Round 3 (review response).** Codex then found two defects in round 2's
recovery, both real and both reproduced before fixing: on the HTTP path the
23505 aborts the shared request transaction, so the catch cannot recover and
the route still 500s; and the read-merge-write is a lost update that drops a
concurrent different-pack activation from the mirror. The settings write is
now ONE atomic upsert-and-merge statement, which removes both failure modes
at the root rather than recovering from one of them. §"Defect 1, part 3".

---

## Defect 1 (#1083) — the loser of the pack lock wrote to `tenant_settings` before the guard was ever evaluated

### Mechanism

`activatePackWithSeed` (`packages/api/src/onboarding/activate-pack-with-seed.ts`)
ran, in this order, before the fix:

| order | step | old line |
|---|---|---|
| 1 | `settingsRepo.findByTenant(tenantId)` — does a settings row exist? | `:92` |
| 2 | `settingsRepo.update(...)` **or** `settingsRepo.create({...})` — a plain `INSERT INTO tenant_settings` | `:97` / `:100` |
| 3 | `pg_try_advisory_xact_lock('pack:{tenantId}:{packId}')` (request path) | `:128` |
| 4 | `pg_try_advisory_lock('pack:{tenantId}:{packId}')` on a dedicated connection (executor path, `lockPool`) | `:149` |
| 5 | `activatePack` + `seedPackDefaults` + audit, inside the held lock | `:160`–`:195` |

Steps 1–2 are a **read-then-write outside the guard**. Two sibling
proposals for the same tenant+pack (`onboarding_tenant_settings` and
`onboarding_service_category`, each on its own idempotency lock keyed by
proposal id) both reach step 1, both see "no settings row" for a brand-new
tenant, and both run step 2. `PgSettingsRepository.create`
(`packages/api/src/settings/pg-settings.ts:266`) is a plain `INSERT` with no
`ON CONFLICT`, so the loser dies at
`tenant_settings_tenant_id_key` (SQLSTATE 23505) — **before** the guard at
step 3/4 is evaluated. The handler's `catch`
(`packages/api/src/proposals/execution/onboarding-handlers.ts:248`,
`:326`) then returns the raw Postgres message as the execution error
instead of `PACK_ACTIVATION_IN_PROGRESS:<pack>` — exactly the CI symptom in
#1083 and its follow-up comment: "try again" degraded to a 500.

The three candidate causes named in the issue, answered:

1. **Is the `tenant_settings` write outside/before the lock the guard takes?**
   **Yes — this is the defect.** See the table above.
2. **Do the two handlers take the same lock key for the same pack?**
   **Yes, they already did.** Both call `activatePackWithSeed` with
   `lockPool: this.pool` (`onboarding-handlers.ts:239` and `:313`) and the
   key is built in one place as `` `pack:${tenantId}:${packId}` ``
   (`activate-pack-with-seed.ts:111`, `:131`, `:202`), hashed with
   `hashtextextended(…, 0)` — the same lock space as the HTTP route's xact
   lock. Not a contributor; unchanged by this fix.
3. **Can `pg_try_advisory_lock` on a pooled session be released by a
   different checkout before the loser's check?**
   **No.** The session lock is taken on a connection checked out
   exclusively for it (`activate-pack-with-seed.ts:147`), held across the
   whole critical section, and unlocked in a `finally` that destroys the
   connection (`release(true)`) if the unlock fails, so a client still
   holding the lock is never returned to the pool
   (`activate-pack-with-seed.ts:198`–`:214`, pre-fix numbering). Not a
   contributor; unchanged by this fix.

The T1 test already in
`test/integration/onboarding-pack-seed-concurrency.test.ts:167`–`:176`
describes this same gap in a comment and works around it by pre-seeding
`tenant_settings` rows — that workaround is now unnecessary (left in place:
it is harmless and out of this change's scope).

### The change

`packages/api/src/onboarding/activate-pack-with-seed.ts` — both lock
branches moved above the settings work; the settings read/update/create
moved inside the `try` that the lock's `finally` releases. Nothing else
changed: same lock key, same lock space, same two branches, same release
discipline.

```
  if (lockClient)  { …pg_try_advisory_xact_lock… }   // now :108
  if (lockPool)    { …pg_try_advisory_lock…     }    // now :127
  try {
    const existing = await settingsRepo.findByTenant(tenantId);   // now :144
    …update or create…                                            // now :148–:171
    await activatePack(…); await seedPackDefaults(…); await auditRepo.create(…);
  } finally { …unlock… }
```

Result: a loser returns `{ status: 'locked' }` → `PACK_ACTIVATION_IN_PROGRESS`
having written nothing at all, and the read and the write that depends on it
are one critical section.

### RED → GREEN

New deterministic test at real Postgres:
`packages/api/test/integration/onboarding-pack-seed-lock-scope.test.ts`.
A second session holds the exact `pack:{tenant}:hvac` advisory key, so the
handler under test is the guaranteed loser — no sleeps, no racing promises.
Test 2 additionally forces CI's interleaving deterministically (the winner's
`tenant_settings` INSERT commits between the loser's read and its own
INSERT) and asserts the hook never fires once the settings write is behind
the guard.

RED (before the fix) — note the second failure reproduces the CI error
string verbatim:

```
 × onboarding-pack-seed-lock-scope.test.ts > … > the loser of the (tenant, pack) lock writes NOTHING to tenant_settings — the whole settings write is behind the guard 90ms
   → expected 1 to be +0 // Object.is equality
 × onboarding-pack-seed-lock-scope.test.ts > … > the loser reports PACK_ACTIVATION_IN_PROGRESS, never a raw 23505, when the winner creates the tenant_settings row first 36ms
   → expected 'duplicate key value violates unique c…' not to match /duplicate key value/

AssertionError: expected 1 to be +0 // Object.is equality
- Expected
+ Received
- 0
+ 1
 ❯ test/integration/onboarding-pack-seed-lock-scope.test.ts:137:36

AssertionError: expected 'duplicate key value violates unique c…' not to match /duplicate key value/
- Expected:
/duplicate key value/
+ Received:
"duplicate key value violates unique constraint \"tenant_settings_tenant_id_key\""
 ❯ test/integration/onboarding-pack-seed-lock-scope.test.ts:190:30

 Test Files  1 failed (1)
      Tests  2 failed (2)
```

GREEN (after the fix), both new files:

```
 ✓ onboarding-pack-seed-lock-scope.test.ts > … > the loser of the (tenant, pack) lock writes NOTHING to tenant_settings — the whole settings write is behind the guard 49ms
 ✓ onboarding-pack-seed-lock-scope.test.ts > … > the loser reports PACK_ACTIVATION_IN_PROGRESS, never a raw 23505, when the winner creates the tenant_settings row first 13ms
 ✓ pack-activation-tenant-scoped-update.test.ts > … > tenant A cannot update tenant B's activation row, and B still can 43ms
 ✓ pack-activation-tenant-scoped-update.test.ts > … > an empty update under the wrong tenant returns null rather than reading the row back 9ms
 ✓ pack-activation-tenant-scoped-update.test.ts > … > deactivatePack and the reactivation path still work in-tenant, with their audit rows 19ms

 Test Files  2 passed (2)
      Tests  5 passed (5)
```

---

## Defect 1, part 2 (#1083, round 2) — the lock's WINNER could still take the same 23505

### Mechanism

Round 1 put the settings write behind the guard, which fixes the loser. It
does not fix the winner, because **the guard key and the contended row have
different grains**: the lock is `pack:{tenantId}:{packId}`, the row is
`tenant_settings` keyed by `tenant_id` alone. Two writers reach that row
without ever holding this pack's key:

1. **The sibling handler.**
   `OnboardingTenantSettingsExecutionHandler.execute` calls
   `settingsRepo.upsertIdentityFields`
   (`packages/api/src/proposals/execution/onboarding-handlers.ts:197`) —
   which `INSERT … ON CONFLICT (tenant_id) DO UPDATE`s the row — **before**
   it reaches its `activatePackWithSeed` loop and the pack lock (`:239`).
   So for the *same* pack, the sibling pair from #1083: the
   service-category handler wins the lock, reads "no settings row", the
   tenant-settings handler's upsert commits, and the winner's plain
   `INSERT` dies at `tenant_settings_tenant_id_key`.
2. **A different-pack activation**, which holds a different key entirely.

Both paths produce the exact CI symptom of #1083 on the winner's side.

### The change

`activate-pack-with-seed.ts` — the first-row `settingsRepo.create` is now
wrapped: a unique violation (`23505`) means "somebody else created the row",
so re-read, merge this pack into whatever they wrote, and `update`.
Re-reading rather than reusing the pre-INSERT union is what keeps a
concurrent different-pack activation from clobbering the other's entry in
`_activeVerticalPacks`. Any other unique violation, or one with no row
behind it, still propagates. Same insert-then-reconcile idiom as
`packages/api/src/ai/skills/find-or-create-lead.ts:146`. No change to
`PgSettingsRepository`'s contract, so no other caller is affected.

> **Superseded by round 3.** This recovery is sound only where each
> repository call owns its transaction (the executor path). Codex showed it
> cannot work inside the shared request transaction, and that the merge it
> performs is a lost update. The catch is gone; the write is now one atomic
> statement. Kept here because the mechanism it documents — the lock's grain
> not matching the row's — is still why the defect existed.

### RED → GREEN

Third test in
`packages/api/test/integration/onboarding-pack-seed-lock-scope.test.ts`,
deterministic: nobody holds the lock (this handler is the winner) and the
sibling's **real** call — `PgSettingsRepository.upsertIdentityFields` — is
driven into the window between the winner's read and its INSERT.

RED:

```
 ✓ … the loser of the (tenant, pack) lock writes NOTHING to tenant_settings … 55ms
 ✓ … the loser reports PACK_ACTIVATION_IN_PROGRESS, never a raw 23505 … 14ms
 × … the WINNER of the pack lock survives the sibling handler creating the tenant_settings row under it, and merges rather than clobbers 25ms
   → expected 'duplicate key value violates unique c…' to be undefined

AssertionError: expected 'duplicate key value violates unique c…' to be undefined
- Expected:
undefined
+ Received:
"duplicate key value violates unique constraint \"tenant_settings_tenant_id_key\""
 ❯ test/integration/onboarding-pack-seed-lock-scope.test.ts:246:26

 Test Files  1 failed (1)
      Tests  1 failed | 2 passed (3)
```

GREEN, with #1095's file alongside it:

```
 ✓ … the loser of the (tenant, pack) lock writes NOTHING to tenant_settings … 38ms
 ✓ … the loser reports PACK_ACTIVATION_IN_PROGRESS, never a raw 23505 … 13ms
 ✓ … the WINNER of the pack lock survives the sibling handler creating the tenant_settings row under it, and merges rather than clobbers 64ms
 ✓ … tenant A cannot update tenant B's activation row, and B still can 40ms
 ✓ … an empty update under the wrong tenant returns null rather than reading the row back 9ms
 ✓ … deactivatePack and the reactivation path still work in-tenant, with their audit rows 28ms

 Test Files  2 passed (2)
      Tests  6 passed (6)
```

The winner's settings row is asserted to keep **both** writers' work: the
sibling's `business_name` ('Sibling Co') and this activation's pack
(`_activeVerticalPacks: ['hvac']`), with the pack row and seeded catalog
present.

### Re-validation after round 2

| run | result |
|---|---|
| `npx tsc --project tsconfig.build.json --noEmit` | exit 0, no output |
| `npx vitest run test/settings test/proposals test/verticals test/audit test/onboarding test/shared/pack-config-loader.test.ts test/routes/pack-activation-mirror-sync.route.test.ts` | `Test Files 159 passed (159) / Tests 2287 passed (2287)` |
| integration: the 9 other files touching pack activation | `Test Files 9 passed (9) / Tests 47 passed (47)` |
| `onboarding-pack-seed-concurrency.test.ts`, 5 consecutive runs | `Tests 2 passed (2)` ×5 |

---

## Defect 1, part 3 (#1083, round 3) — round 2's recovery was unsound on the HTTP path, and lost updates

### Mechanism

Two findings from Codex, both verified before fixing.

**P1 — a caught 23505 cannot be recovered from inside the request
transaction.** On `POST /api/onboarding/pack` the route passes
`currentTenantContext()?.client` as `lockClient`
(`packages/api/src/routes/onboarding.ts:355`), and every repository reuses
that same client (`PgBaseRepository.withTenantTransaction` →
`tenantContextStore`, set up at
`packages/api/src/middleware/tenant-context.ts:259`). One transaction, so
the failed INSERT aborts *all* of it: round 2's `catch` runs, but its
re-read fails with `25P02 current transaction is aborted, commands ignored
until end of transaction block`, and the route still 500s. Round 2 only
ever fixed the executor path, where each repository call opens its own
transaction. The repo documents this exact hazard on
`TransactionScope.savepoint` (`packages/api/src/db/tenant-transaction.ts`).

**P2 — read-merge-write is a lost update.** The guard is keyed by (tenant,
pack); the row is keyed by tenant. Two activations for DIFFERENT packs are
therefore never serialized against each other, and each writes back a list
computed from its own earlier read — so the later write drops the earlier
one's pack from `_activeVerticalPacks`. Both `pack_activations` rows stay
active, so the authoritative table and the mirror consumed by the Templates
page (`LiveTemplatesSection`) and public intake (`routes/public-intake.ts`)
silently disagree.

### The change

`SettingsRepository.ensureActiveVerticalPack(tenantId, packId,
bootstrapAiModel)` — new, and the whole read/create/update/catch block in
`activatePackWithSeed` collapses to one call of it. Postgres implementation
(`packages/api/src/settings/pg-settings.ts`) is a single statement: INSERT
the row, or `ON CONFLICT (tenant_id) DO UPDATE` appending the pack to the
stored list with `jsonb_set` over `COALESCE(terminology_preferences,'{}')`.

- No exception, so nothing can abort the caller's transaction → P1 gone,
  for the HTTP path and the executor path alike.
- No read-modify-write: the merge is evaluated against the row version the
  statement locks, so a concurrent different-pack activation is merged, not
  overwritten → P2 gone.
- The append is guarded by `@>`, so re-activating a pack does not repeat it.
- Other terminology keys are preserved; `ai_model` is only backfilled when
  null, never overwritten.

The in-memory repository mirrors the semantics; the two test doubles that
implement `SettingsRepository`
(`test/voice-quality/voice-quality-driver-factory.ts`,
`test/voice/voice-smoke.synthetic.test.ts`) delegate or stub it. The
now-dead `isUniqueViolation` helper and the `uuid` import were removed with
the block they served.

### RED → GREEN

New file `packages/api/test/integration/onboarding-pack-settings-upsert.test.ts`.
Both tests force the interleaving through **real lock contention** — a
second session holds an uncommitted write to the tenant's settings row, the
code under test blocks on it in Postgres, and only then does the blocker
commit (`waitUntilBlocked` polls `pg_blocking_pids` until the waiter exists,
so nothing rides on a sleep landing in the right place). The round-2 tests
in `onboarding-pack-seed-lock-scope.test.ts` were rewritten the same way:
they had hooked `settingsRepo.findByTenant`, which this fix removes, so a
hook-based probe would have silently stopped proving anything.

RED (round-2 code):

```
 × P1 — inside the request-scoped transaction, another writer creating tenant_settings does not poison the caller 52ms
   → expected error: current transaction is aborted, co… { …(15) } to be undefined
+ Received:
error {
  "message": "current transaction is aborted, commands ignored until end of transaction block",
  "code": "25P02",
 × P2 — a concurrent activation of a DIFFERENT pack is merged into the mirror, not overwritten 64ms
   → expected [ 'hvac' ] to deeply equal [ 'hvac', 'plumbing' ]
- Expected
+ Received
  [
    "hvac",
-   "plumbing",
  ]
 ✓ re-activating a pack already in the mirror does not duplicate it 45ms
```

GREEN, with every other pack file alongside:

```
 ✓ P1 — inside the request-scoped transaction, another writer creating tenant_settings does not poison the caller 67ms
 ✓ P2 — a concurrent activation of a DIFFERENT pack is merged into the mirror, not overwritten 58ms
 ✓ re-activating a pack already in the mirror does not duplicate it 42ms
 ✓ the loser of the (tenant, pack) lock writes NOTHING to tenant_settings — the whole settings write is behind the guard 40ms
 ✓ the loser reports PACK_ACTIVATION_IN_PROGRESS, never a raw 23505, when the winner creates the tenant_settings row first 19ms
 ✓ the WINNER of the pack lock survives the sibling handler creating the tenant_settings row under it, and merges rather than clobbers 74ms
 ✓ onboarding-pack × 5 (incl. T1 and T3)
 ✓ onboarding-pack-seed-concurrency × 2 (incl. T1)
 ✓ pack-activation-tenant-scoped-update × 3

 Test Files  5 passed (5)
      Tests  16 passed (16)
```

### Re-validation after round 3

| run | result |
|---|---|
| `npx tsc --project tsconfig.build.json --noEmit` | exit 0, no output |
| `npx vitest run test/settings test/proposals test/verticals test/audit test/onboarding test/invariants test/shared/pack-config-loader.test.ts test/routes/pack-activation-mirror-sync.route.test.ts test/packs` | `Test Files 168 passed (168) / Tests 2403 passed \| 4 expected fail (2407)` |
| integration: the 9 other files touching pack activation (incl. mirror-sync and public-intake) | `Test Files 9 passed (9) / Tests 51 passed (51)` |
| `onboarding-pack-seed-concurrency.test.ts`, 5 consecutive runs | `Tests 2 passed (2)` ×5 |

Run on the branch **after Josh merged `main` in** (`537d28a`, base
`92a1653`), so these numbers are against the merged head, not the original
branch point. The merge also brought
`test/invariants/i16-telephony-acting-tenant-guarded.structural.test.ts`
from main — the tenant-predicate structural guard — and the now
tenant-predicated `pg-pack-activation.ts` passes it.

---

## Defect 2 (#1095) — `PgPackActivationRepository.update` was tenant-unscoped

### Mechanism

`packages/api/src/settings/pg-pack-activation.ts:76` (pre-fix) ran the
update under `withClient` — which takes a bare pool connection and sets
neither `app.current_tenant_id` nor the RLS runtime role
(`packages/api/src/db/pg-base.ts:96`) — with `WHERE id = $N` alone
(`:108`–`:110` pre-fix). Neither the predicate nor RLS scoped the write, so
any activation id from any tenant was accepted. The no-set-clauses branch
(`:98`–`:102` pre-fix) was the same: `SELECT … WHERE id = $1`, which would
hand back another tenant's row through the return value.

Not exploitable on today's call paths — both callers
(`pack-activation.ts:60`, `:108` pre-fix) source the id from a
tenant-scoped `findByTenantAndPack` first — but the next caller taking an id
from a request would reopen the class #1092 closed.

### The change

- `PackActivationRepository.update` (`packages/api/src/settings/pack-activation.ts:32`)
  now takes `tenantId` as its first argument — it identifies the row, not
  just the context.
- `PgPackActivationRepository.update`
  (`packages/api/src/settings/pg-pack-activation.ts:80`) runs under
  `withTenantTransaction(tenantId, …)` (`:85`) with `AND tenant_id = $N` on
  both the UPDATE (`:121`) and the read-back branch (`:110`), returning
  null on zero rows.
- `InMemoryPackActivationRepository.update`
  (`packages/api/src/settings/pack-activation.ts:210`) enforces the same
  scoping (`existing.tenantId !== tenantId` → null).
- Callers updated: `activatePack`'s reactivation branch
  (`pack-activation.ts:71`) and `deactivatePack` (`:119`).
- Signature-only test updates: three in-memory call sites in
  `test/verticals/resolve-active-pack.test.ts:95,303,305`.

### RED → GREEN

New test at real Postgres:
`packages/api/test/integration/pack-activation-tenant-scoped-update.test.ts`.
RED comes from the signature: on the pre-fix 2-arg `update(id, updates)`,
the test's `update(tenantId, id, updates)` shifts the arguments and blows up
inside the repository.

```
 × pack-activation-tenant-scoped-update.test.ts > … > tenant A cannot update tenant B's activation row, and B still can 52ms
   → Cannot use 'in' operator to search for 'deactivatedAt' in 0e121740-039c-471d-b1e3-378357eb2b8c
 × pack-activation-tenant-scoped-update.test.ts > … > an empty update under the wrong tenant returns null rather than reading the row back 11ms
   → Cannot use 'in' operator to search for 'deactivatedAt' in 1475a73e-a8cc-435a-b9a5-c9c0722ecc6b
 ✓ pack-activation-tenant-scoped-update.test.ts > … > deactivatePack and the reactivation path still work in-tenant, with their audit rows 32ms

TypeError: Cannot use 'in' operator to search for 'deactivatedAt' in 0e121740-039c-471d-b1e3-378357eb2b8c
 ❯ src/settings/pg-pack-activation.ts:92:18
 ❯ PgPackActivationRepository.withClient src/db/pg-base.ts:99:20
 ❯ test/integration/pack-activation-tenant-scoped-update.test.ts:53:25

 Test Files  1 failed (1)
      Tests  2 failed | 1 passed (3)
```

Stated plainly: the **third** test (deactivate → reactivate → audit legs)
passes before the fix — pre-fix `src` and its own 2-arg call are internally
consistent — so it is a regression guard for the signature change, not RED
evidence. The two cross-tenant/in-tenant tests are the RED. GREEN output is
in the #1083 section above (all 5 pass).

One honest caveat on the cross-tenant assertion: pre-fix it cannot be made
to *exercise* the unscoped UPDATE through the new signature (the argument
shift turns the call into a no-op read), so its protection is forward-looking
— it pins that a future implementation must return null for another tenant's
id. The unscoped SQL itself is proven gone by the source diff and by the
in-tenant leg passing under `withTenantTransaction` + `AND tenant_id = $N`.

---

## Full run log

All runs against a plain kept container
(`pgvector/pgvector:pg16 -c max_connections=300`,
`EXTERNAL_TEST_DB_URL=postgres://test:test@localhost:32768/serviceos_test`),
integration runs with `RLS_RUNTIME_ROLE=true`.

| run | result |
|---|---|
| new integration files (both) | `Test Files 2 passed (2) / Tests 5 passed (5)` |
| `npx vitest run test/settings test/proposals` | `Test Files 131 passed (131) / Tests 2016 passed (2016)` |
| `npx vitest run test/verticals test/audit test/shared/pack-config-loader.test.ts test/routes/pack-activation-mirror-sync.route.test.ts test/onboarding` | `Test Files 28 passed (28) / Tests 271 passed (271)` |
| integration: `onboarding-pack` + `onboarding-pack-seed-concurrency` + both new files | `Test Files 4 passed (4) / Tests 12 passed (12)` |
| integration: the other 8 files touching pack activation (mirror-sync, onboarding-status, -identity, -ai-check, -test-call-skip, -status-derived-gate, -conversation-parity, trial-provisioning) | `Test Files 8 passed (8) / Tests 42 passed (42)` |
| `npx tsc --project tsconfig.build.json --noEmit` | exit 0, no output |

`npx tsc --noEmit` (the default config, which includes tests) reports one
error, `test/routes/pack-activation-mirror-sync.route.test.ts(58,35)`. It is
**pre-existing on `main`** — verified by stashing this branch's changes and
re-running — and untouched here.

### 5 consecutive runs of the existing concurrency file

```
===== RUN 1 =====
 ✓ … two sibling proposals executing concurrently for the SAME pack do NOT duplicate catalog items or templates 105ms
 ✓ … T1 — a second tenant racing the SAME pack-seed concurrency scenario … 79ms
 Test Files  1 passed (1)
      Tests  2 passed (2)
===== RUN 2 =====
 ✓ … 101ms
 ✓ … 73ms
 Test Files  1 passed (1)
      Tests  2 passed (2)
===== RUN 3 =====
 ✓ … 104ms
 ✓ … 73ms
 Test Files  1 passed (1)
      Tests  2 passed (2)
===== RUN 4 =====
 ✓ … 104ms
 ✓ … 70ms
 Test Files  1 passed (1)
      Tests  2 passed (2)
===== RUN 5 =====
 ✓ … 92ms
 ✓ … 70ms
 Test Files  1 passed (1)
      Tests  2 passed (2)
```

---

## Dumps

Database dropped and recreated, then the two new files plus
`onboarding-pack-seed-concurrency.test.ts` run against it
(`Test Files 3 passed (3) / Tests 7 passed (7)`); dumped straight from the
container.

```
              tenant_id               |  pack_id   |   status    | has_deactivated_at
--------------------------------------+------------+-------------+--------------------
 10b09361-dd5e-4d4f-9b9b-70ee38d8faf6 | hvac       | active      | f
 3a684692-49ae-4a07-82d5-6d7bee58b12e | hvac       | active      | f
 6ea2ac36-230e-41bd-bf33-7e0b97a8e3e7 | electrical | active      | f
 81d2d3f3-7bce-406a-a760-67290079b4bb | plumbing   | active      | f
 8ebc8018-f11a-426c-8f26-8f309b367f42 | hvac       | active      | f
 a9a1bbfc-8a39-4b69-950d-0ba46ab82c1b | hvac       | deactivated | t
(6 rows)

              tenant_id               |    business_name    | active_packs_mirror
--------------------------------------+---------------------+---------------------
 10b09361-dd5e-4d4f-9b9b-70ee38d8faf6 | Concurrency HVAC Co | ["hvac"]
 3a684692-49ae-4a07-82d5-6d7bee58b12e | Concurrency HVAC Co | ["hvac"]
 8ebc8018-f11a-426c-8f26-8f309b367f42 | Concurrency HVAC Co | ["hvac"]
(3 rows)

              tenant_id               |   entity_type   |              entity_id               |         event_type          | n
--------------------------------------+-----------------+--------------------------------------+-----------------------------+---
 10b09361-dd5e-4d4f-9b9b-70ee38d8faf6 | tenant_packs    | hvac                                 | tenant.pack_activated       | 1
 10b09361-dd5e-4d4f-9b9b-70ee38d8faf6 | tenant_settings | 10b09361-dd5e-4d4f-9b9b-70ee38d8faf6 | tenant.identity_set         | 1
 3a684692-49ae-4a07-82d5-6d7bee58b12e | tenant_packs    | hvac                                 | tenant.pack_activated       | 1
 3a684692-49ae-4a07-82d5-6d7bee58b12e | tenant_settings | 3a684692-49ae-4a07-82d5-6d7bee58b12e | tenant.identity_set         | 1
 6ea2ac36-230e-41bd-bf33-7e0b97a8e3e7 | pack_activation | b6d652ca-4446-4dad-871f-f7ec7efd660c | pack_activation.activated   | 2
 6ea2ac36-230e-41bd-bf33-7e0b97a8e3e7 | pack_activation | b6d652ca-4446-4dad-871f-f7ec7efd660c | pack_activation.deactivated | 1
 8ebc8018-f11a-426c-8f26-8f309b367f42 | tenant_packs    | hvac                                 | tenant.pack_activated       | 1
 8ebc8018-f11a-426c-8f26-8f309b367f42 | tenant_settings | 8ebc8018-f11a-426c-8f26-8f309b367f42 | tenant.identity_set         | 1
(8 rows)

 pack_rows | settings_rows | audit_rows | tenants
-----------+---------------+------------+---------
         6 |             3 |          9 |      11
(1 row)
```

Reading the dump against the two fixes:

- **11 tenants, 3 `tenant_settings` rows.** The two tenants from
  `onboarding-pack-seed-lock-scope.test.ts` have **no** `tenant_settings`
  row, **no** `pack_activations` row and **no** audit event — the loser of
  the lock wrote nothing anywhere. That is #1083's fix, visible in the data.
  The three settings rows are the concurrency file's own tenants.
- **`a9a1bbfc…` / hvac / deactivated / `deactivated_at` set** — tenant B's
  row after the *in-tenant* update in the #1095 test. The preceding
  cross-tenant `update(tenantA, idOfBRow, …)` left it `active` with a null
  `deactivated_at` and returned null; the six tenant-A ids from that file
  own no rows at all.
- **`6ea2ac36…` / electrical / active, `deactivated_at` null**, with audit
  `pack_activation.activated ×2` + `pack_activation.deactivated ×1` — the
  activate → deactivate → reactivate cycle through the new signature, all
  three audit rows readable back through the tenant-scoped
  `PgAuditRepository.findByEntity` and invisible under another tenant.
- **One `tenant.pack_activated` per concurrency tenant** — the two siblings
  never both seeded; the loser short-circuited at the guard.

---

## Not done

1. ~~**Residual: two concurrent activations for the same tenant but
   DIFFERENT packs**, which take different lock keys and can still race the
   `settingsRepo.create` INSERT.~~ **Closed in round 2** (`c11a2f1`) —
   xhawk-ai's review showed the same gap also fires for the *same* pack via
   the sibling's pre-lock `upsertIdentityFields`, so it was not a
   deferrable residual. The insert-then-reconcile fix covers both shapes
   without changing `PgSettingsRepository.create`'s contract. See "Defect 1,
   part 2" above.
2. **The T1 workaround in
   `test/integration/onboarding-pack-seed-concurrency.test.ts:167`–`:183`**
   (pre-seeding `tenant_settings` to dodge this very race) is now
   unnecessary but left in place — removing it is a behaviour-neutral test
   cleanup outside this change.
3. **The optional structural guard from #1095** (extending the #1092 sweep
   into a build-time invariant so a future `pg-*.ts` write keyed on `id = $`
   without `tenant_id` fails the build, in the shape of
   `test/invariants/i16-telephony-acting-tenant-guarded.structural.test.ts`)
   is not implemented. It is a new invariant across 98 files, not part of
   fixing these two defects.
4. **No RLS policy change, no migration, no route or permission change** —
   per the lane's constraints. `pack_activations` already has
   `tenant_isolation_pack_act`; this change makes the repository actually
   run under it rather than around it.
5. The pre-existing `npx tsc --noEmit` error in
   `test/routes/pack-activation-mirror-sync.route.test.ts(58,35)` is left
   alone (present on `main`, unrelated to these files).
