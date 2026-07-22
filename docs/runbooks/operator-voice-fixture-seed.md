# Operator voice QA fixture seed

This seed is only for the explicitly named Development QA tenant used by the
authenticated operator-voice Top-50 run. It does not create a tenant or actor.

## Prerequisites

- `QA_TENANT_ID` is the canonical QA tenant UUID. The tenant's canonical name
  must contain the standalone marker `QA` (or `Quality Assurance`).
- `QA_ACTOR_ID` is the canonical `users.id` UUID for an actor in that same
  tenant. It is not a Clerk subject such as `user_...`.
- The QA tenant already has exactly one active technician whose canonical name
  is `Carlos`. Provision that teammate through the normal Clerk invitation
  flow. The fixture runner deliberately does not fabricate a Clerk identity.
- `DATABASE_URL` points at the intended Development database.
- The deployment target resolves to `development` through
  `RAILWAY_ENVIRONMENT_NAME`, `RAILWAY_ENVIRONMENT`, or `NODE_ENV`.

## Run

From `packages/api`:

`QA_TENANT_ID=<uuid> QA_ACTOR_ID=<users.id-uuid> NODE_ENV=development DATABASE_URL=<development-url> npx tsx scripts/seed-operator-voice-fixtures.ts`

Run the same command twice before the Top-50 probe. The first run reports 28
created fixture registrations. A healthy second run reports 0 created and 28
reused, with the same IDs.

The runner rejects an unknown target, any non-Development target, a tenant not
marked QA, or an actor outside that tenant before canonical writes. Production
also fails closed. The break-glass override is:

`ALLOW_OPERATOR_VOICE_FIXTURE_SEED_OUTSIDE_DEVELOPMENT=true`

Use that override only after independently verifying the database, QA tenant,
and actor IDs. It permits the target check; it does not bypass tenant-name or
actor-membership checks.

## Seed contents

The versioned catalog creates only the required reference data:

- customers `Khan`, `Johnson`, `Mrs Lee`, two exact `Smith` records, and
  `Garcia`;
- one location and job for each customer;
- Khan estimate `EST-0001` and Garcia estimate `EST-0042`;
- Johnson invoice `INV-0042`, two Smith invoices, and one Garcia invoice;
- one Garcia appointment on Tuesday, `2026-07-28T14:00:00.000Z`;
- the Greenfield Property Management lead; and
- a fixture registration for the existing Carlos technician.

It intentionally does not seed Maria Alvarez or James Patel. Their corpus
workflows test customer creation.

All prices and values are integer cents. Catalog timestamps are UTC ISO values.
Line items use the shared billing engine and are marked as manually priced.

## Idempotency and audit behavior

Canonical creates use the production customer, location, job, estimate,
invoice, appointment, and lead domain/repository paths. The runner performs no
raw-SQL canonical writes and adds no schema.

Every fixture has stable provenance
`qa-operator-voice:v1:<key>`, stored in both the audit event correlation ID and
audit metadata. A tenant-scoped transaction advisory lock serializes each key.
Inside that transaction the runner checks provenance before writing, performs
the canonical write and audit atomically, and rejects stale or duplicate
provenance rather than guessing. The appointment also uses the same provenance
as its existing unique idempotency key. Invoice and estimate numbers use their
existing tenant-scoped unique keys.

Each fixture commits independently. If a later fixture fails, rerunning safely
reuses earlier records and resumes at the missing fixture. The Greenfield lead
uses the `phone_call` source so the production lead path does not emit a
duplicate owner push if a database commit has to be retried.

## Current limitations

- Team-member creation belongs to Clerk and `PgUserRepository` has no
  production create path. This runner therefore validates and registers an
  existing active Carlos technician; it never inserts a `users` row.
- `PgEntityResolver` currently returns `skipped` for estimates. The integration
  test pins the real `EST-0042` row instead of faking resolver success. U5 adds
  estimate resolver support.
- Leads are not an `EntityKind` in `PgEntityResolver`; the Greenfield row is
  pinned through the real lead repository.
- The current appointment resolver treats weekday words relative to the
  process clock. The fixture is a fixed UTC Tuesday for reproducibility, so U3
  resolves it by ISO date. U5 adds the intent-conditioned appointment bridge
  used by the spoken `Tuesday` workflow.

## Verification

From `packages/api`:

- `npx vitest run test/seed/operator-voice-fixture-plan.test.ts`
- `RLS_RUNTIME_ROLE=true npx vitest run --config vitest.integration.config.ts test/integration/operator-voice-fixtures.test.ts test/integration/operator-voice-fixture-idempotency.test.ts`
- `npx tsc --project tsconfig.build.json --noEmit`
