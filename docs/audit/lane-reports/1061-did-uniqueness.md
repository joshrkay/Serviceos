# Lane report — #1061: one tenant per DID

Branch: `fix/tenant-integrations-did-uniqueness`
Issue: [#1061](https://github.com/joshrkay/Serviceos/issues/1061)
Date: 2026-09-13
**This lane ships a MIGRATION (274). Run the pre-flight in §2 against production before merging.**

---

## 1. The defect

`tenant_integrations.provider_data->>'phoneE164'` had no uniqueness
constraint. Two tenants could each be provisioned with the same Twilio DID,
and three separate call sites then pick one of the duplicate rows with
`LIMIT 1` and **no `ORDER BY`** — so not even deterministically:

| Call site | file:line | Consequence of a tie |
|---|---|---|
| `PgPhoneNumberRepository.findByNumber` | `src/integrations/twilio/phone-number-repository.ts:73-79` | Inbound `/voice` lands in an arbitrary tenant |
| `resolveTenantIdByPhoneNumber` | `src/app.ts:3790-3796` | `/gather` + `/dial-result` routing, and every audit write, lands in an arbitrary tenant |
| Tenant credential selection | `src/integrations/credentials.ts` (since PR #1082) | The reply goes out on an arbitrary tenant's Twilio credentials |

Each of these resolves the tenant **from** the DID. There is therefore no
tenant scope inside which application code could check for the conflict — the
guarantee has to be a database constraint. That is what this lane adds.

Scope note: the issue also asks for `/gather` to resolve through
`phoneNumberRepo` rather than the legacy resolver (its item 2). This lane was
scoped to the uniqueness half only; item 2 is untouched and still open. With
the index in force, the two resolvers can no longer disagree about *which*
tenant owns a DID, which removes the sharpest edge of that bug but not the
`TWILIO_DEFAULT_TENANT_ID` fallback it describes.

---

## 2. OPERATOR PRE-FLIGHT — run this against production before merging

`tenant_integrations` is `FORCE ROW LEVEL SECURITY` (migration 074), so the
cross-tenant read needs `app.system_lookup` (or a `BYPASSRLS` role):

```sql
SET app.system_lookup = 'true';

SELECT provider_data->>'phoneE164'               AS phone_e164,
       count(*)                                  AS claim_count,
       array_agg(tenant_id  ORDER BY created_at) AS tenant_ids,
       array_agg(status     ORDER BY created_at) AS statuses,
       array_agg(created_at ORDER BY created_at) AS created_ats
  FROM tenant_integrations
 WHERE provider = 'twilio'
   AND provider_data->>'phoneE164' IS NOT NULL
   AND coalesce(provider_data->>'stub', 'false') <> 'true'
 GROUP BY 1
HAVING count(*) > 1
 ORDER BY claim_count DESC, phone_e164;
```

**Zero rows → migration 274 applies cleanly; merge and deploy.**

**Any rows → do NOT merge yet.** Each row is a DID two or more live tenants
believe they own. Decide which tenant keeps it (the `created_ats` and
`statuses` arrays are ordered oldest-first to help), then clear the loser's
`phoneE164` and re-provision that tenant onto a new number. Re-run the
pre-flight until it returns zero rows.

### Why this is deploy-blocking rather than merely untidy

The runner has **no ledger**: `getMigrationSQL()` re-executes every migration
on every boot, and `applyMigrations()` sends the entire corpus as **one**
`client.query()`. A `CREATE UNIQUE INDEX` that fails on pre-existing
duplicates therefore fails the whole migration run, and `migrate.ts` sets
`process.exitCode = 1` — which blocks the new deploy (the previous one keeps
serving). This is demonstrated live in §6.5.

---

## 3. The migration (274, additive)

Added to `MIGRATIONS` in `packages/api/src/db/schema.ts` after
`273_material_items_urgency_index`. The full pre-flight and the reasoning
below are reproduced in the migration's own header comment.

```js
'274_tenant_integrations_unique_twilio_did': `
  CREATE UNIQUE INDEX IF NOT EXISTS uq_tenant_integrations_twilio_phone_e164
    ON tenant_integrations (provider, (provider_data->>'phoneE164'))
    WHERE provider = 'twilio'
      AND provider_data->>'phoneE164' IS NOT NULL
      AND coalesce(provider_data->>'stub', 'false') <> 'true';
`,
```

**Additive.** It creates an index and drops nothing — the runner has no
ledger, so a `CREATE` in one migration plus a `DROP` in another would rebuild
and destroy the object on every boot (the rule migration 273's own header
spells out). Migration 070's `UNIQUE (tenant_id, provider)` is untouched: it
forbids two twilio rows for **one tenant**, while this forbids one DID across
**two tenants** — complementary, not overlapping.

### 3a. Why NOT `CONCURRENTLY`: the runner does not support it

`applyMigrations()` issues the whole corpus through a single
`client.query(getMigrationSQL())`, which node-pg sends as a *simple query* —
an implicit transaction block — and `CREATE INDEX CONCURRENTLY` is rejected
inside one (SQLSTATE 25001). The runner also sets `statement_timeout = '25s'`.

So the migration uses a plain build. On this table that is free:
`tenant_integrations` holds at most one row per tenant per provider, so the
build is milliseconds and the `ACCESS EXCLUSIVE` lock is negligible.

**If `tenant_integrations` ever grows large enough for that to matter**, an
operator can build the index out-of-band *before* the deploy; the
`IF NOT EXISTS` then finds it present and no-ops:

```sql
CREATE UNIQUE INDEX CONCURRENTLY uq_tenant_integrations_twilio_phone_e164
  ON tenant_integrations (provider, (provider_data->>'phoneE164'))
  WHERE provider = 'twilio'
    AND provider_data->>'phoneE164' IS NOT NULL
    AND coalesce(provider_data->>'stub', 'false') <> 'true';
```

### 3b. Deviation from the specified predicate — the `stub` carve-out

The predicate I was given was `WHERE provider = 'twilio' AND
provider_data->>'phoneE164' IS NOT NULL`. I added a third clause. The reason:

`workers/provision-twilio.ts:29` defines

```ts
const STUB_DEV_PHONE_E164 = '+15005550006';
```

and assigns **that same number to every tenant** provisioned without real
Twilio credentials, tagging the row `stub: true`
(`provision-twilio.ts:147`). It is a Twilio *magic test number* — not
dialable, and it never routes a real inbound call, so it is not part of this
defect. Under the literal predicate, the **second dev/CI tenant onward would
fail to provision**, breaking local onboarding and the test suite.

Real DIDs are never tagged `stub` (the worker refuses to persist a magic
number as a real line — `provision-twilio.ts:342`, #880), so the carve-out
cannot be used to smuggle a real duplicate past the index. A test pins this
both ways (§5, "still allows every dev tenant to share the Twilio magic stub
number").

---

## 4. The provisioning path surfaces the violation cleanly

With the index in force, the `provider_data || {phoneNumberSid, phoneE164}`
write in `provision-twilio.ts` raises 23505 when the DID is taken. Unhandled,
that produced:

- `last_error` = `duplicate key value violates unique constraint
  "uq_tenant_integrations_twilio_phone_e164"` — not something an operator can
  act on, and
- a **rethrow**, so the queue retries the job. Forever: the DID will never
  free itself.

The fix mirrors the two operator-actionable failure branches already in the
same handler (unavailable-preferred-number, magic-test-number): record an
actionable `last_error` and return cleanly, so the queue does not retry.

```ts
export function isDidAlreadyClaimed(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { code?: string; constraint?: string };
  return e.code === '23505' && e.constraint === 'uq_tenant_integrations_twilio_phone_e164';
}
```

Matched on **both** SQLSTATE and constraint name deliberately:
`tenant_integrations` also carries 070's `UNIQUE (tenant_id, provider)`, which
raises the same 23505 for a different — and genuinely retryable — reason, so
the code alone would misclassify it. A unit-level case pins that distinction.

The operator message:

> Phone number +1512… is already assigned to another tenant — a DID can serve
> only one tenant (inbound routing resolves the tenant from the number).
> Release it from the other tenant, or provision this tenant on a different
> number, then re-run provisioning.

---

## 5. RED → GREEN (raw output)

### 5a. RED — the uniqueness test before migration 274

`test/integration/tenant-integrations-did-uniqueness.test.ts`. Note the rows
must belong to two **different** tenants: 070's `UNIQUE (tenant_id, provider)`
already forbids one tenant holding two twilio rows, so cross-tenant
duplication is both the only reachable shape and exactly the production
incident described.

```
$ RLS_RUNTIME_ROLE=true npx vitest run --config vitest.integration.config.ts \
    --reporter=verbose test/integration/tenant-integrations-did-uniqueness.test.ts

 × … > refuses a second tenant claiming the same phoneE164 (unique violation) 15ms
   → promise resolved "undefined" instead of rejecting
 × … > leaves exactly one row holding the DID, so the LIMIT 1 lookup is deterministic 5ms
   → expected [ …(2) ] to have a length of 1 but got 2
 ✓ … > still allows a different tenant to hold a different DID 5ms
 ✓ … > still allows many tenants with no phoneE164 yet (partial index skips NULLs) 5ms
 ✓ … > still allows every dev tenant to share the Twilio magic stub number 8ms
 × … > the index exists, is UNIQUE, and is partial 4ms
   → expected [] to have a length of 1 but got +0
 × … > surfaces as a DatabaseError with the constraint name, so callers can classify it 5ms
   → expected undefined to be an instance of DatabaseError

 Test Files  1 failed (1)
      Tests  4 failed | 3 passed (7)
```

**The second insert succeeding is the bug.** The three that already pass are
the must-not-regress cases.

### 5b. GREEN — after migration 274

```
 ✓ … > refuses a second tenant claiming the same phoneE164 (unique violation) 11ms
 ✓ … > leaves exactly one row holding the DID, so the LIMIT 1 lookup is deterministic 4ms
 ✓ … > still allows a different tenant to hold a different DID 6ms
 ✓ … > still allows many tenants with no phoneE164 yet (partial index skips NULLs) 7ms
 ✓ … > still allows every dev tenant to share the Twilio magic stub number 10ms
 ✓ … > the index exists, is UNIQUE, and is partial 3ms
 ✓ … > surfaces as a DatabaseError with the constraint name, so callers can classify it 5ms

 Test Files  1 passed (1)
      Tests  7 passed (7)
```

### 5c. RED — the provisioning path before the handler fix

`test/integration/provision-twilio-did-conflict.test.ts`, run with only the
`try/catch` reverted (the exported helper kept so the import still resolves):

```
{"level":"error","message":"Twilio provisioning failed", … ,"error":"duplicate key value violates unique constraint \"uq_tenant_integrations_twilio_phone_e164\""}

 × … > records an operator-actionable failure and does not retry 68ms
   → promise rejected "error: duplicate key value violates uniqu… { …(15) }" instead of resolving

Caused by: error: duplicate key value violates unique constraint "uq_tenant_integrations_twilio_phone_e164"
 ❯ tenantQuery src/workers/provision-twilio.ts:62:20
 ❯ Object.handle src/workers/provision-twilio.ts:377:11

Serialized Error: { … code: '23505', … constraint: 'uq_tenant_integrations_twilio_phone_e164', … }

 Test Files  1 failed (1)
      Tests  1 failed | 2 passed (3)
```

Both failure modes visible at once: the raw Postgres text in `last_error`,
and the rethrow that makes the queue retry.

### 5d. GREEN — after the handler fix

```
{"level":"error","message":"Twilio DID already claimed by another tenant", … ,"phoneE164":"+15125559901","phoneNumberSid":"PN555"}

 ✓ … > records an operator-actionable failure and does not retry 64ms
 ✓ … > leaves the incumbent tenant untouched — it keeps the DID 1ms
 ✓ … > isDidAlreadyClaimed distinguishes the DID index from the tenant/provider unique 0ms

 Test Files  1 passed (1)
      Tests  3 passed (3)
```

---

## 6. Dumps at a kept plain container

```
$ docker run -d --rm -e POSTGRES_USER=test -e POSTGRES_PASSWORD=test \
    -e POSTGRES_DB=serviceos_test -p 127.0.0.1:0:5432 \
    pgvector/pgvector:pg16 -c max_connections=300
$ EXTERNAL_TEST_DB_URL=postgres://test:test@localhost:32768/serviceos_test \
    RLS_RUNTIME_ROLE=true npx vitest run --config vitest.integration.config.ts \
    test/integration/tenant-integrations-did-uniqueness.test.ts
 Test Files  1 passed (1)
      Tests  7 passed (7)
```

### 6.1 The index exists

```
$ psql -c "\d tenant_integrations"

Indexes:
    "tenant_integrations_pkey" PRIMARY KEY, btree (id)
    "idx_tenant_integrations_tenant" btree (tenant_id)
    "tenant_integrations_tenant_id_provider_key" UNIQUE CONSTRAINT, btree (tenant_id, provider)
    "uq_tenant_integrations_twilio_phone_e164" UNIQUE, btree (provider, (provider_data ->> 'phoneE164'::text)) WHERE provider = 'twilio'::text AND (provider_data ->> 'phoneE164'::text) IS NOT NULL AND COALESCE(provider_data ->> 'stub'::text, 'false'::text) <> 'true'::text
…
Policies (forced row security enabled):
    POLICY "tenant_isolation_integrations"
      USING (((tenant_id = (current_setting('app.current_tenant_id'::text, true))::uuid) OR (current_setting('app.system_lookup'::text, true) = 'true'::text)))
```

Both the new index and 070's `UNIQUE (tenant_id, provider)` are present —
the migration added, it did not replace.

### 6.2 Index definition

```
indexname | uq_tenant_integrations_twilio_phone_e164
indexdef  | CREATE UNIQUE INDEX uq_tenant_integrations_twilio_phone_e164 ON public.tenant_integrations USING btree (provider, ((provider_data ->> 'phoneE164'::text))) WHERE ((provider = 'twilio'::text) AND ((provider_data ->> 'phoneE164'::text) IS NOT NULL) AND (COALESCE((provider_data ->> 'stub'::text), 'false'::text) <> 'true'::text))
```

### 6.3 The duplicate is refused

```
--- tenant A takes +15125557777: ---
INSERT 0 1
COMMIT

--- tenant B now claims the SAME DID: ---
ERROR:  duplicate key value violates unique constraint "uq_tenant_integrations_twilio_phone_e164"
DETAIL:  Key (provider, (provider_data ->> 'phoneE164'::text))=(twilio, +15125557777) already exists.

--- a DIFFERENT DID for tenant B is still accepted: ---
INSERT 0 1
```

### 6.4 The pre-flight on a clean database

```
 phone_e164 | claim_count | tenant_ids | statuses | created_ats
------------+-------------+------------+----------+-------------
(0 rows)
```

### 6.5 The pre-flight catches a duplicate — and the migration fails on it

Index dropped to recreate pre-migration production state, then a duplicate
seeded:

```
--- the PRE-FLIGHT finds it: ---
  phone_e164  | claim_count |                                 tenant_ids                                  |            statuses
--------------+-------------+-----------------------------------------------------------------------------+---------------------------------
 +15125557777 |           2 | {aaaaaaaa-0000-0000-0000-000000000001,bbbbbbbb-0000-0000-0000-000000000002} | {full_readiness,full_readiness}
(1 row)

--- and migration 274 FAILS against that state (this is what blocks the deploy): ---
ERROR:  could not create unique index "uq_tenant_integrations_twilio_phone_e164"
DETAIL:  Key (provider, (provider_data ->> 'phoneE164'::text))=(twilio, +15125557777) is duplicated.
```

This is precisely the production risk, reproduced: **run the §2 pre-flight
first.** It returns the same rows the index build would choke on.

---

## 7. Other checks run

```
$ npx tsc --project tsconfig.build.json --noEmit
(exit 0, no output)

$ RLS_RUNTIME_ROLE=true npx vitest run --config vitest.integration.config.ts \
    test/integration/provision-twilio-vapi.test.ts \
    test/integration/phone-lookups-shared-dispatch.test.ts \
    test/integration/tenant-integrations-did-uniqueness.test.ts \
    test/integration/provision-twilio-did-conflict.test.ts
 Test Files  4 passed (4)
      Tests  24 passed (24)

$ npx vitest run test/workers/provision-twilio.test.ts test/db/ test/integrations/
 Test Files  34 passed (34)
      Tests  196 passed (196)

$ RLS_RUNTIME_ROLE=true npx vitest run --config vitest.integration.config.ts   # FULL suite
 Test Files  219 passed (219)
      Tests  1262 passed (1262)

$ npx vitest run                                                              # FULL unit suite
 Test Files  1180 passed | 5 skipped (1185)
      Tests  14764 passed | 6 expected fail | 12 skipped | 38 todo (14820)
```

### 7a. Four test-fixture changes the migration forced

A schema-wide constraint reaches every fixture in a suite that shares one
database, so the full integration run — not the four files named in the brief
— is what actually established this. All four are fixture artefacts rather
than behaviour changes, but they are edits to tests this lane did not
otherwise own, so each is called out:

1. **`test/integration/provision-twilio-vapi.test.ts`** provisioned three
   different tenants onto one hardcoded number (`+15125550123`). Under the new
   index tenants 2 and 3 collided; two of its three tests failed.
   `stubTwilioFetch()` now takes the purchased number as a parameter and each
   test passes a distinct one. In production every tenant buys its own number,
   so the shared literal was never a behaviour under test.
2. **`test/integration/rls-tenant-isolation.test.ts`** seeded tenant A and
   tenant B with the same `+15125550000`, guarded by
   `ON CONFLICT (tenant_id, provider) DO NOTHING` — which does not cover the
   new index. The block asserts that `vapiAssistantId` is not readable across
   tenants; the number is incidental, so each tenant now gets its own. Two
   live tenants sharing a DID is precisely the state the schema now forbids.
3. **`test/integration/public-intake.test.ts`** seeded `+15125550123`, the same
   literal `provision-twilio-vapi.test.ts` provisions — a cross-file collision
   in the shared database. Moved to an otherwise-unused number.
4. **`test/db/migration-immutability.test.ts`** requires every new migration to
   be locked into its snapshot deliberately. Added
   `['274_tenant_integrations_unique_twilio_did', '1d8a28be…dd6e1bb0']`.

A general consequence worth knowing: **the integration suite shares one
database, so any two files reusing a DID literal now collide.** A new test that
provisions a number must pick an unused one. Items 1–3 were all found this way;
none of them was visible from the four files the brief named.

---

## 8. Production rollout note

1. **Run the §2 pre-flight against production.** This is the gate.
2. Zero rows → merge and deploy normally. The index builds in milliseconds on
   a table with one row per tenant per provider.
3. Any rows → reconcile first (§2). Do not merge until the pre-flight is
   clean: the index build fails, which fails the whole migration corpus and
   blocks the deploy (§6.5).
4. **Rollback:** reverting the code alone does not drop the index, because the
   runner has no ledger and migrations are never removed. If the index must go,
   drop it manually (`DROP INDEX uq_tenant_integrations_twilio_phone_e164;`)
   **and** revert the schema.ts entry in the same change — otherwise the next
   boot recreates it.
5. **After deploy**, provisioning a tenant onto a taken DID no longer silently
   half-succeeds: `tenant_integrations.status = 'failed'` with the operator
   message in `last_error`, and the job does not retry. Worth a look at any
   `status = 'failed'` rows post-deploy.

## 9. Still open on #1061

- **Item 2 of the issue** — `/api/telephony/gather` resolving the tenant
  through the legacy `resolveTenantIdByPhoneNumber` rather than
  `phoneNumberRepo`, and the `TWILIO_DEFAULT_TENANT_ID` fallback that makes
  audit writes land under the wrong tenant and fail their FK. Untouched here.
- **The missing `ORDER BY`** on both `LIMIT 1` lookups. With the index in
  force at most one row can match, so the tie is gone at the source — but the
  queries are still written in a way that would silently pick one if a future
  change reintroduced duplicates. Adding `ORDER BY created_at` is cheap
  belt-and-braces.
