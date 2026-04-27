# Repository Conventions

**Status:** Locked for multi-agent waves. Do not change method shapes without first updating this doc and notifying every running agent.

This doc codifies the existing repository / persistence seam so multiple agents can implement Postgres-backed repositories in parallel without drift.

## Canonical method shape

Every entity repository defines its operations with `tenantId` as the **first argument** of every read/write method. The interface lives in the entity's own file (e.g. `customers/customer.ts`); InMemory and Postgres implementations both satisfy it.

```ts
interface CustomerRepository {
  create(customer: Customer): Promise<Customer>;
  findById(tenantId: string, id: string): Promise<Customer | null>;
  findByTenant(tenantId: string, options?: CustomerListOptions): Promise<Customer[]>;
  update(
    tenantId: string,
    id: string,
    updates: Partial<Customer>,
  ): Promise<Customer | null>;
  search(tenantId: string, query: string): Promise<Customer[]>;
}
```

Rules:

- All methods are `async`.
- Single-record reads return `Promise<T | null>` (never `undefined`).
- Multi-record reads return `Promise<T[]>` (never `null`).
- `create` accepts the full entity (caller is responsible for setting `tenantId` on the entity itself).
- Mutations take `(tenantId, id, updates)`. `tenantId` is **always** first.
- Cross-tenant or system-level methods (e.g. `findReadyForExecution`) are explicitly named and documented inline.

## RLS / tenant scoping pattern

Every Postgres implementation extends `PgBaseRepository` (`packages/api/src/db/pg-base.ts`) and wraps each query in `withTenant()`:

```ts
async findById(tenantId: string, id: string): Promise<Customer | null> {
  return this.withTenant(tenantId, async (client) => {
    const { rows } = await client.query(
      'SELECT * FROM customers WHERE id = $1',
      [id],
    );
    return rows[0] ? mapRow(rows[0]) : null;
  });
}
```

`withTenant()` calls `setTenantContext(tenantId)` on the connection (sets the Postgres GUC consumed by RLS policies) before running the callback, then releases the connection. Two implications:

- **Never** concatenate `tenantId` into SQL — RLS is the enforcement, the GUC is the channel. The one exception is `setTenantContext` itself, which validates tenantId is a UUID before interpolation (`db/schema.ts:999-1004`).
- **Never** call `pool.connect()` directly inside a repo method — always go through `withTenant()` (or `withTenantTransaction()` for multi-statement work).

System-level / cross-tenant queries use `withClient()` (no tenant context). Use sparingly and document why.

## InMemory contract is also locked

InMemory implementations exist for two reasons: tests and dev mode without `DATABASE_URL`. **Do not change InMemory signatures during a Pg implementation wave** — Wave 1A agents are concurrently doing Pg work against the same interface, and a signature change forces re-merge across every agent.

If a method's signature genuinely needs to evolve, file a separate "interface-evolution" story that runs alone in its own wave.

## Entities that already have both impls (do not touch in Wave 1A)

These 17 entities already have InMemory + Pg impls and are conditionally wired in `app.ts:251-280`:

```
Customers, Locations, Jobs, JobTimeline, Appointments,
Estimates, Invoices, Payments, Notes, Conversations,
Settings, Audit, EstimateTemplates, ServiceBundles,
QualityMetrics, Voice, TechnicianLocationPing,
Approvals, EditDeltas, PackActivation, Files, JobFiles,
CatalogItems, FeatureFlags, Queue, Proposals
```

(That count adds up to >17 because some sub-entities ride on parent stories. The point is: every name above already has a `pg-*.ts` and is in the `app.ts` ternary.)

## Entities that need a Pg impl (Wave 1A scope)

These currently have only an InMemory implementation. Each needs a `pg-*.ts` that satisfies the existing interface, plus migration SQL in `db/schema.ts`:

| Entity | InMemory file | Interface name |
|---|---|---|
| Assignments | `appointments/assignment.ts:256` | `AssignmentRepository` |
| DispatchAnalytics | `dispatch/analytics.ts:388` | `DispatchAnalyticsRepository` |
| DocumentRevisions | `ai/document-revision.ts:350` | `DocumentRevisionRepository` |
| DiffAnalysis | `ai/diff-analysis.ts:351` | `DiffAnalysisRepository` |
| DelayNoticeState | `notifications/delay-notifications.ts:401` | `DelayNoticeStateRepository` |
| Webhooks (idempotency) | `webhooks/routes.ts:9` | `WebhookEventRepository` |

Stories in `docs/stories/phase-0-gap-stories.md` (P0-019..P0-022) split these by domain. Each story owns its entity's `pg-*.ts` file plus the migration that creates its table.

## What changes in `app.ts` (Wave 1C only)

`packages/api/src/app.ts` is the **integration point** — it's the file where every repo gets instantiated based on whether `pool` is set. Wave 1A agents writing Pg impls **must not touch it**. Only the Wave 1C wiring agent (story P0-023) edits this file, after every Wave 1A story has merged.

The pattern is already established at `app.ts:251-280`:

```ts
const customerRepo = pool
  ? new PgCustomerRepository(pool)
  : new InMemoryCustomerRepository();
```

P0-023's job is to extend the same ternary to the 6 remaining InMemory-only repos.

## Migration ordering

Every Wave 1A story includes a migration. Migration filenames are sequenced (`0001_*.sql`, `0002_*.sql`, …). Two agents writing the same number = merge conflict.

**Rule:** Each story declares its migration number range in its "Allowed files" line. Numbers are reserved by the wave coordinator before agents launch. See `multi-agent-runbook.md` for the reservation table.
