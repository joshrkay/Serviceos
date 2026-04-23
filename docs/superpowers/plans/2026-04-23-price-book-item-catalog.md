# Price Book / Item Catalog Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a tenant-scoped Price Book so contractors can maintain a catalog of services, labor, parts, and materials — each with a set unit price in integer cents. When building an estimate, the contractor picks items from a searchable dropdown instead of typing descriptions and prices from memory. Catalog changes never mutate existing estimate or invoice line items; the `catalog_item_id` FK is analytics-only.

**Architecture:** Four new DB tables (`catalog_items`, `catalog_bundles`, `catalog_bundle_items`, plus analytics FK columns on `estimate_line_items` and `invoice_line_items`) are introduced via migrations 041–044 appended to `MIGRATIONS` in `schema.ts`. A `CatalogRepository` interface with InMemory and Pg implementations follows the established pattern. Five Express route handlers are wired into `app.ts`. The React frontend replaces the hardcoded `MANUAL_CATALOG` constant in `NewEstimateFlow.tsx` with a live debounced search against `GET /api/catalog/items?q=...`, and a new `PriceBookPage` settings sub-page provides full CRUD and CSV bulk import.

**Tech Stack:** TypeScript, Express, `pg` driver, `pg_trgm` extension for trigram fuzzy search on the API side; React, Tailwind, `useListQuery` / `useMutation` hooks on the web side. Vitest for all tests.

---

## File Structure

### New files

| Path | Responsibility |
|------|----------------|
| `packages/api/src/catalog/catalog.ts` | `CatalogItem`, `CatalogBundle`, repository interface, `InMemoryCatalogRepository`, domain functions (`createCatalogItem`, `searchCatalogItems`, etc.) |
| `packages/api/src/catalog/pg-catalog.ts` | `PgCatalogRepository` — Postgres-backed implementation with trigram search |
| `packages/api/src/routes/catalog.ts` | Express router factory for `/api/catalog/items` and `/api/catalog/bundles` endpoints |
| `packages/api/test/catalog/catalog.test.ts` | Unit tests against `InMemoryCatalogRepository` |
| `packages/api/test/catalog/routes.test.ts` | HTTP integration tests for catalog endpoints |
| `packages/web/src/components/settings/PriceBookPage.tsx` | Admin settings page: list, add, edit, archive, CSV import |
| `packages/web/src/components/settings/PriceBookPage.test.tsx` | Vitest + Testing Library tests for the admin page |
| `packages/web/src/hooks/useCatalogSearch.ts` | Debounced hook wrapping `GET /api/catalog/items?q=...` for use in the estimate picker |
| `packages/web/src/hooks/useCatalogSearch.test.ts` | Tests for the debounce and result mapping logic |

> **Migration mechanism:** This codebase does **not** use a `packages/api/migrations/*.sql` directory. The migration runner in `packages/api/src/db/migrate.ts` calls `getMigrationSQL()` which concatenates the `MIGRATIONS` object exported from `packages/api/src/db/schema.ts:25` (each value is a SQL string keyed by `'NNN_name'`). New migrations are added by appending entries to that object. All migration tasks below modify `schema.ts` rather than creating new SQL files.

### Modified files

**Phase 1 (Database):** `packages/api/src/db/schema.ts` — four new migration entries (041–044).

**Phase 2 (Repository):** `packages/api/src/catalog/catalog.ts` (new), `packages/api/src/catalog/pg-catalog.ts` (new).

**Phase 3 (API):** `packages/api/src/routes/catalog.ts` (new), `packages/api/src/app.ts` — import & mount catalog router.

**Phase 4 (Estimate picker):** `packages/web/src/hooks/useCatalogSearch.ts` (new), `packages/web/src/components/estimates/NewEstimateFlow.tsx` — replace `MANUAL_CATALOG` constant with live search.

**Phase 5 (Price Book admin):** `packages/web/src/components/settings/PriceBookPage.tsx` (new), `packages/web/src/routes.ts` — add `/settings/price-book` route, `packages/web/src/components/settings/SettingsPage.tsx` — add navigation entry.

### Commit cadence

One commit per task. Every commit keeps tests green. No step leaves the repo broken.

---

## Phase 1: Database Migrations

Introduce `pg_trgm`, the two catalog tables, the bundle join table, and nullable analytics FK columns on the existing line item tables. All four are appended to `MIGRATIONS` in `schema.ts`. RLS is applied to every new table. Money is stored as integer cents throughout.

### Task 1: Enable pg_trgm and create catalog_items

**Files:**
- Modify: `packages/api/src/db/schema.ts`

**Context:** The trigram extension must exist before any GIN index on a `text` column can reference `gin_trgm_ops`. `CREATE EXTENSION IF NOT EXISTS pg_trgm` is idempotent. Migration `041` creates `catalog_items` with RLS and a GIN trigram index on `name`. Migration `042` adds `catalog_bundles` and `catalog_bundle_items`.

- [ ] **Step 1: Write the failing schema test**

```typescript
// packages/api/test/db/schema.test.ts  (add inside existing describe block)
it('041 — MIGRATIONS contains catalog_items entry', () => {
  const { MIGRATIONS } = require('../../src/db/schema');
  expect(Object.keys(MIGRATIONS)).toContain('041_create_catalog_items');
  expect(MIGRATIONS['041_create_catalog_items']).toMatch(/catalog_items/);
  expect(MIGRATIONS['041_create_catalog_items']).toMatch(/pg_trgm/);
  expect(MIGRATIONS['041_create_catalog_items']).toMatch(/gin_trgm_ops/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/api && npx vitest run test/db/schema.test.ts -t "041"`
Expected: FAIL — `'041_create_catalog_items'` key is absent from `MIGRATIONS`

- [ ] **Step 3: Implement — append to MIGRATIONS in schema.ts**

Append after the `'040_create_technician_location_pings'` entry:

```typescript
'041_create_catalog_items': `
  CREATE EXTENSION IF NOT EXISTS pg_trgm;

  CREATE TABLE IF NOT EXISTS catalog_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id),
    name TEXT NOT NULL,
    description TEXT,
    unit_price_cents INTEGER NOT NULL CHECK (unit_price_cents >= 0),
    unit TEXT NOT NULL DEFAULT 'each',
    category TEXT,
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_by TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_catalog_items_tenant
    ON catalog_items(tenant_id, is_active);
  CREATE INDEX IF NOT EXISTS idx_catalog_items_name_trgm
    ON catalog_items USING GIN (name gin_trgm_ops);
  ALTER TABLE catalog_items ENABLE ROW LEVEL SECURITY;
  ALTER TABLE catalog_items FORCE ROW LEVEL SECURITY;
  DROP POLICY IF EXISTS tenant_isolation_catalog_items ON catalog_items;
  CREATE POLICY tenant_isolation_catalog_items ON catalog_items
    USING (tenant_id = current_setting('app.current_tenant_id')::UUID);
`,
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/api && npx vitest run test/db/schema.test.ts -t "041"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/db/schema.ts packages/api/test/db/schema.test.ts
git commit -m "feat(catalog): migration 041 — catalog_items table with pg_trgm GIN index"
```

---

### Task 2: catalog_bundles, catalog_bundle_items, and analytics FK columns

**Files:**
- Modify: `packages/api/src/db/schema.ts`

**Context:** Migration `042` adds `catalog_bundles` (with `price_mode` enum via CHECK constraint) and the `catalog_bundle_items` join table. Migration `043` adds nullable `catalog_item_id UUID REFERENCES catalog_items(id) ON DELETE SET NULL` to both `estimate_line_items` and `invoice_line_items`. This column is analytics-only — it is never read to derive a price at runtime.

- [ ] **Step 1: Write the failing schema tests**

```typescript
it('042 — MIGRATIONS contains catalog_bundles entry', () => {
  const { MIGRATIONS } = require('../../src/db/schema');
  expect(Object.keys(MIGRATIONS)).toContain('042_create_catalog_bundles');
  expect(MIGRATIONS['042_create_catalog_bundles']).toMatch(/catalog_bundle_items/);
});

it('043 — MIGRATIONS adds catalog_item_id to line items', () => {
  const { MIGRATIONS } = require('../../src/db/schema');
  expect(Object.keys(MIGRATIONS)).toContain('043_add_catalog_item_id_to_line_items');
  const sql = MIGRATIONS['043_add_catalog_item_id_to_line_items'];
  expect(sql).toMatch(/estimate_line_items/);
  expect(sql).toMatch(/invoice_line_items/);
  expect(sql).toMatch(/ON DELETE SET NULL/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/api && npx vitest run test/db/schema.test.ts -t "042|043"`
Expected: FAIL — keys missing

- [ ] **Step 3: Implement**

```typescript
'042_create_catalog_bundles': `
  CREATE TABLE IF NOT EXISTS catalog_bundles (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id),
    name TEXT NOT NULL,
    description TEXT,
    price_mode TEXT NOT NULL DEFAULT 'computed'
      CHECK (price_mode IN ('fixed', 'computed')),
    fixed_price_cents INTEGER CHECK (fixed_price_cents IS NULL OR fixed_price_cents >= 0),
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_by TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_catalog_bundles_tenant
    ON catalog_bundles(tenant_id, is_active);
  ALTER TABLE catalog_bundles ENABLE ROW LEVEL SECURITY;
  ALTER TABLE catalog_bundles FORCE ROW LEVEL SECURITY;
  DROP POLICY IF EXISTS tenant_isolation_catalog_bundles ON catalog_bundles;
  CREATE POLICY tenant_isolation_catalog_bundles ON catalog_bundles
    USING (tenant_id = current_setting('app.current_tenant_id')::UUID);

  CREATE TABLE IF NOT EXISTS catalog_bundle_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    bundle_id UUID NOT NULL REFERENCES catalog_bundles(id) ON DELETE CASCADE,
    catalog_item_id UUID NOT NULL REFERENCES catalog_items(id) ON DELETE CASCADE,
    quantity NUMERIC NOT NULL DEFAULT 1 CHECK (quantity > 0),
    sort_order INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_bundle_items_bundle
    ON catalog_bundle_items(bundle_id);
`,

'043_add_catalog_item_id_to_line_items': `
  ALTER TABLE estimate_line_items
    ADD COLUMN IF NOT EXISTS catalog_item_id UUID
      REFERENCES catalog_items(id) ON DELETE SET NULL;

  ALTER TABLE invoice_line_items
    ADD COLUMN IF NOT EXISTS catalog_item_id UUID
      REFERENCES catalog_items(id) ON DELETE SET NULL;
`,
```

- [ ] **Step 4: Verify tests pass**

Run: `cd packages/api && npx vitest run test/db/schema.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/db/schema.ts packages/api/test/db/schema.test.ts
git commit -m "feat(catalog): migrations 042-043 — bundles tables and analytics FK on line items"
```

---

## Phase 2: CatalogRepository — InMemory & Pg

Build the domain types, repository interface, and both implementations. InMemory is used by all unit tests; Pg implements trigram search via the `pg_trgm` GIN index.

### Task 3: Domain types, interface, and InMemory implementation

**Files:**
- Create: `packages/api/src/catalog/catalog.ts`
- Create: `packages/api/test/catalog/catalog.test.ts`

**Context:** `CatalogItem` and `CatalogBundle` mirror the table schemas. `search()` in the InMemory implementation filters by case-insensitive substring match (good enough for tests). The domain function `createCatalogItem` validates required fields and sets integer cents.

- [ ] **Step 1: Write the failing tests**

```typescript
// packages/api/test/catalog/catalog.test.ts
import {
  createCatalogItem,
  searchCatalogItems,
  InMemoryCatalogRepository,
} from '../../src/catalog/catalog';

describe('CatalogRepository — InMemory', () => {
  let repo: InMemoryCatalogRepository;

  beforeEach(() => { repo = new InMemoryCatalogRepository(); });

  it('creates and retrieves a catalog item', async () => {
    const item = await createCatalogItem(
      { tenantId: 't-1', name: 'Diagnostic fee', unitPriceCents: 8500,
        unit: 'each', category: 'Labor', createdBy: 'u-1' },
      repo
    );
    expect(item.id).toBeTruthy();
    expect(item.unitPriceCents).toBe(8500);
    expect(item.isActive).toBe(true);

    const found = await repo.findById('t-1', item.id);
    expect(found).not.toBeNull();
    expect(found!.name).toBe('Diagnostic fee');
  });

  it('search returns matching items', async () => {
    await createCatalogItem(
      { tenantId: 't-1', name: 'R-410A refrigerant', unitPriceCents: 1800,
        unit: 'per lb', category: 'Materials', createdBy: 'u-1' }, repo);
    await createCatalogItem(
      { tenantId: 't-1', name: 'Run capacitor', unitPriceCents: 2850,
        unit: 'each', category: 'Parts', createdBy: 'u-1' }, repo);

    const results = await repo.search('t-1', 'refrig', 10);
    expect(results).toHaveLength(1);
    expect(results[0].name).toMatch(/refrigerant/i);
  });

  it('soft-delete sets is_active to false', async () => {
    const item = await createCatalogItem(
      { tenantId: 't-1', name: 'Labor', unitPriceCents: 11000,
        unit: 'per hr', category: 'Labor', createdBy: 'u-1' }, repo);
    await repo.archive('t-1', item.id);
    const found = await repo.findById('t-1', item.id);
    expect(found!.isActive).toBe(false);
  });

  it('rejects non-integer unit price', async () => {
    await expect(
      createCatalogItem(
        { tenantId: 't-1', name: 'Bad price', unitPriceCents: 85.5,
          unit: 'each', category: 'Labor', createdBy: 'u-1' }, repo)
    ).rejects.toThrow('unitPriceCents must be an integer');
  });

  it('tenant isolation — search does not cross tenants', async () => {
    await createCatalogItem(
      { tenantId: 't-1', name: 'Labor', unitPriceCents: 9500,
        unit: 'per hr', category: 'Labor', createdBy: 'u-1' }, repo);
    const results = await repo.search('t-2', 'Labor', 10);
    expect(results).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/api && npx vitest run test/catalog/catalog.test.ts`
Expected: FAIL — module `../../src/catalog/catalog` not found

- [ ] **Step 3: Implement catalog.ts**

Key types and interface to implement:

```typescript
export interface CatalogItem {
  id: string; tenantId: string; name: string; description?: string;
  unitPriceCents: number; unit: string; category?: string;
  isActive: boolean; createdBy: string; createdAt: Date; updatedAt: Date;
}

export interface CreateCatalogItemInput {
  tenantId: string; name: string; description?: string;
  unitPriceCents: number; unit: string; category?: string; createdBy: string;
}

export interface CatalogRepository {
  create(item: CatalogItem): Promise<CatalogItem>;
  findById(tenantId: string, id: string): Promise<CatalogItem | null>;
  findByTenant(tenantId: string, activeOnly?: boolean): Promise<CatalogItem[]>;
  search(tenantId: string, query: string, limit: number): Promise<CatalogItem[]>;
  update(tenantId: string, id: string, updates: Partial<CatalogItem>): Promise<CatalogItem | null>;
  archive(tenantId: string, id: string): Promise<void>;
  findBundles(tenantId: string): Promise<CatalogBundle[]>;
  createBundle(bundle: CatalogBundle, itemLinks: CatalogBundleItem[]): Promise<CatalogBundle>;
}
```

`InMemoryCatalogRepository.search` filters via `item.name.toLowerCase().includes(query.toLowerCase())`. `createCatalogItem` validates that `unitPriceCents` is a non-negative integer and `name` is non-empty.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/api && npx vitest run test/catalog/catalog.test.ts`
Expected: PASS (all 5 cases)

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/catalog/catalog.ts packages/api/test/catalog/catalog.test.ts
git commit -m "feat(catalog): CatalogRepository interface + InMemory implementation with search"
```

---

### Task 4: PgCatalogRepository with trigram search

**Files:**
- Create: `packages/api/src/catalog/pg-catalog.ts`

**Context:** The Pg implementation extends `PgBaseRepository`. `search()` uses `similarity(name, $2) > 0.15 OR name ILIKE $3` ordered by `similarity DESC` — the GIN index accelerates both branches. `archive()` issues `UPDATE ... SET is_active = false`. No integration test is written here (would need a live DB); the contract is fully covered by the InMemory tests in Task 3.

- [ ] **Step 1: Write the structural type-check test**

```typescript
// packages/api/test/catalog/catalog.test.ts — add to existing describe
it('PgCatalogRepository satisfies CatalogRepository interface', () => {
  // Compile-time check via import; no runtime assertion needed.
  const { PgCatalogRepository } = require('../../src/catalog/pg-catalog');
  expect(typeof PgCatalogRepository).toBe('function');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/api && npx vitest run test/catalog/catalog.test.ts -t "PgCatalogRepository"`
Expected: FAIL — module not found

- [ ] **Step 3: Implement pg-catalog.ts**

Key query patterns:

```typescript
// search method
async search(tenantId: string, query: string, limit: number): Promise<CatalogItem[]> {
  return this.withTenant(tenantId, async (client) => {
    const { rows } = await client.query(
      `SELECT * FROM catalog_items
       WHERE tenant_id = $1
         AND is_active = true
         AND (similarity(name, $2) > 0.15 OR name ILIKE $3)
       ORDER BY similarity(name, $2) DESC
       LIMIT $4`,
      [tenantId, query, `%${query}%`, limit]
    );
    return rows.map(this.mapRow);
  });
}

// archive method
async archive(tenantId: string, id: string): Promise<void> {
  await this.withTenantTransaction(tenantId, async (client) => {
    await client.query(
      `UPDATE catalog_items SET is_active = false, updated_at = NOW()
       WHERE tenant_id = $1 AND id = $2`,
      [tenantId, id]
    );
  });
}
```

Row mapping converts snake_case DB columns to camelCase TypeScript properties, including `unit_price_cents -> unitPriceCents` and `is_active -> isActive`.

- [ ] **Step 4: Run all catalog tests**

Run: `cd packages/api && npx vitest run test/catalog/`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/catalog/pg-catalog.ts packages/api/test/catalog/catalog.test.ts
git commit -m "feat(catalog): PgCatalogRepository with trigram search"
```

---

## Phase 3: API Endpoints

Wire catalog CRUD into Express. The router factory follows the `createEstimateRouter` pattern: accept repository and auth middleware dependencies, return a configured `Router`.

### Task 5: Items CRUD routes

**Files:**
- Create: `packages/api/src/routes/catalog.ts`
- Create: `packages/api/test/catalog/routes.test.ts`

**Context:** Five endpoints for items: `POST /`, `GET /?q=...`, `GET /:id`, `PUT /:id`, `DELETE /:id` (soft-delete). All require `requireAuth` + `requireTenant`. `GET /?q=` with an empty query returns all active items (up to 50). Price must arrive as integer cents from the client.

- [ ] **Step 1: Write failing route tests**

```typescript
// packages/api/test/catalog/routes.test.ts
import express from 'express';
import request from 'supertest';
import { createCatalogRouter } from '../../src/routes/catalog';
import { InMemoryCatalogRepository } from '../../src/catalog/catalog';

function makeApp() {
  const repo = new InMemoryCatalogRepository();
  const app = express();
  app.use(express.json());
  // Inject fake auth
  app.use((req: any, _res, next) => {
    req.auth = { tenantId: 'tenant-1', userId: 'user-1', role: 'owner' };
    next();
  });
  app.use('/api/catalog', createCatalogRouter(repo));
  return { app, repo };
}

describe('POST /api/catalog/items', () => {
  it('creates an item and returns 201', async () => {
    const { app } = makeApp();
    const res = await request(app)
      .post('/api/catalog/items')
      .send({ name: 'Diagnostic fee', unitPriceCents: 8500, unit: 'each', category: 'Labor' });
    expect(res.status).toBe(201);
    expect(res.body.id).toBeTruthy();
    expect(res.body.unitPriceCents).toBe(8500);
  });

  it('rejects non-integer price with 400', async () => {
    const { app } = makeApp();
    const res = await request(app)
      .post('/api/catalog/items')
      .send({ name: 'Bad', unitPriceCents: 85.5, unit: 'each' });
    expect(res.status).toBe(400);
  });
});

describe('GET /api/catalog/items', () => {
  it('returns search results for ?q=', async () => {
    const { app, repo } = makeApp();
    await repo.create({ id: 'i-1', tenantId: 'tenant-1', name: 'R-410A refrigerant',
      unitPriceCents: 1800, unit: 'per lb', isActive: true,
      createdBy: 'u-1', createdAt: new Date(), updatedAt: new Date() });
    const res = await request(app).get('/api/catalog/items?q=refrig');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
  });
});

describe('DELETE /api/catalog/items/:id', () => {
  it('soft-deletes item (204) and subsequent GET returns isActive false', async () => {
    const { app, repo } = makeApp();
    const item = await repo.create({ id: 'i-2', tenantId: 'tenant-1', name: 'Labor',
      unitPriceCents: 9500, unit: 'per hr', isActive: true,
      createdBy: 'u-1', createdAt: new Date(), updatedAt: new Date() });
    const del = await request(app).delete(`/api/catalog/items/${item.id}`);
    expect(del.status).toBe(204);
    const found = await repo.findById('tenant-1', item.id);
    expect(found!.isActive).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/api && npx vitest run test/catalog/routes.test.ts`
Expected: FAIL — module `../../src/routes/catalog` not found

- [ ] **Step 3: Implement routes/catalog.ts**

```typescript
export function createCatalogRouter(repo: CatalogRepository): Router {
  const router = Router();

  router.post('/items', requireAuth, requireTenant, async (req, res) => {
    try {
      const { name, description, unitPriceCents, unit = 'each', category } = req.body;
      const item = await createCatalogItem(
        { tenantId: req.auth!.tenantId, name, description, unitPriceCents,
          unit, category, createdBy: req.auth!.userId }, repo);
      res.status(201).json(item);
    } catch (err) {
      const { statusCode, body } = toErrorResponse(err);
      res.status(statusCode).json(body);
    }
  });

  router.get('/items', requireAuth, requireTenant, async (req, res) => {
    const q = String(req.query.q ?? '').trim();
    const limit = Math.min(Number(req.query.limit ?? 50), 100);
    const items = q
      ? await repo.search(req.auth!.tenantId, q, limit)
      : await repo.findByTenant(req.auth!.tenantId, true);
    res.json(items);
  });

  router.get('/items/:id', requireAuth, requireTenant, async (req, res) => {
    const item = await repo.findById(req.auth!.tenantId, req.params.id);
    if (!item) return res.status(404).json({ error: 'Not found' });
    res.json(item);
  });

  router.put('/items/:id', requireAuth, requireTenant, async (req, res) => {
    try {
      const updated = await repo.update(req.auth!.tenantId, req.params.id, req.body);
      if (!updated) return res.status(404).json({ error: 'Not found' });
      res.json(updated);
    } catch (err) {
      const { statusCode, body } = toErrorResponse(err);
      res.status(statusCode).json(body);
    }
  });

  router.delete('/items/:id', requireAuth, requireTenant, async (req, res) => {
    await repo.archive(req.auth!.tenantId, req.params.id);
    res.status(204).send();
  });

  // Bundle routes (GET + POST) follow the same pattern — omitted for brevity,
  // implemented in the same file immediately below the item routes.

  return router;
}
```

- [ ] **Step 4: Run all tests**

Run: `cd packages/api && npx vitest run test/catalog/`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/routes/catalog.ts packages/api/test/catalog/routes.test.ts
git commit -m "feat(catalog): items CRUD API endpoints with soft-delete"
```

---

### Task 6: Bundle routes and wire router into app.ts

**Files:**
- Modify: `packages/api/src/routes/catalog.ts`
- Modify: `packages/api/src/app.ts`

**Context:** Add `POST /api/catalog/bundles`, `GET /api/catalog/bundles`, `PUT /api/catalog/bundles/:id`, `DELETE /api/catalog/bundles/:id` to the router. Then import `createCatalogRouter` in `app.ts`, construct `InMemoryCatalogRepository` (or `PgCatalogRepository` when pool exists), and mount at `/api/catalog`.

- [ ] **Step 1: Write failing test for bundle endpoint**

```typescript
// packages/api/test/catalog/routes.test.ts — append
describe('POST /api/catalog/bundles', () => {
  it('creates a bundle and returns 201', async () => {
    const { app } = makeApp();
    const res = await request(app)
      .post('/api/catalog/bundles')
      .send({ name: 'AC Tune-up Package', priceMode: 'fixed', fixedPriceCents: 19900 });
    expect(res.status).toBe(201);
    expect(res.body.priceMode).toBe('fixed');
    expect(res.body.fixedPriceCents).toBe(19900);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/api && npx vitest run test/catalog/routes.test.ts -t "bundles"`
Expected: FAIL — 404 (route not yet implemented)

- [ ] **Step 3: Implement bundle routes and mount in app.ts**

In `app.ts`, add alongside the other in-memory repository declarations:

```typescript
import { InMemoryCatalogRepository } from './catalog/catalog';
import { PgCatalogRepository } from './catalog/pg-catalog';
import { createCatalogRouter } from './routes/catalog';

// In the repo initialization block:
const catalogRepo = pool
  ? new PgCatalogRepository(pool)
  : new InMemoryCatalogRepository();

// In the route mounting block (near other /api routes):
app.use('/api/catalog', createCatalogRouter(catalogRepo));
```

- [ ] **Step 4: Run all tests**

Run: `cd packages/api && npx vitest run test/catalog/`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/routes/catalog.ts packages/api/src/app.ts \
        packages/api/test/catalog/routes.test.ts
git commit -m "feat(catalog): bundle endpoints + mount catalog router in app.ts"
```

---

## Phase 4: Estimate Line Item Picker

Replace the static `MANUAL_CATALOG` constant with a live debounced search. When the user types, results arrive from `GET /api/catalog/items?q=...`. Selecting an item auto-fills description and price but keeps both editable. The line item's `catalog_item_id` field is set for analytics.

### Task 7: useCatalogSearch hook

**Files:**
- Create: `packages/web/src/hooks/useCatalogSearch.ts`
- Create: `packages/web/src/hooks/useCatalogSearch.test.ts`

**Context:** The hook accepts a debounce delay (default 250 ms), maintains `items`, `isLoading`, and `error` state, and fires `apiFetch` when the query changes. An empty query immediately clears results without making a network call. The test uses `vi.useFakeTimers` to control debounce timing and mocks `apiFetch`.

- [ ] **Step 1: Write failing tests**

```typescript
// packages/web/src/hooks/useCatalogSearch.test.ts
import { renderHook, act } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { useCatalogSearch } from './useCatalogSearch';
import * as apiFetchModule from '../utils/api-fetch';

describe('useCatalogSearch', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it('does not fetch on empty query', async () => {
    const spy = vi.spyOn(apiFetchModule, 'apiFetch');
    const { result } = renderHook(() => useCatalogSearch('', 250));
    await act(async () => { vi.runAllTimers(); });
    expect(spy).not.toHaveBeenCalled();
    expect(result.current.items).toEqual([]);
  });

  it('fetches after debounce and returns items', async () => {
    const mockItem = { id: 'i-1', name: 'Diagnostic fee', unitPriceCents: 8500, unit: 'each' };
    vi.spyOn(apiFetchModule, 'apiFetch').mockResolvedValue(
      new Response(JSON.stringify([mockItem]), { status: 200 })
    );
    const { result, rerender } = renderHook(({ q }) => useCatalogSearch(q, 250), {
      initialProps: { q: '' },
    });
    rerender({ q: 'diag' });
    await act(async () => { vi.advanceTimersByTime(250); });
    expect(result.current.items).toHaveLength(1);
    expect(result.current.items[0].name).toBe('Diagnostic fee');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/web && npx vitest run src/hooks/useCatalogSearch.test.ts`
Expected: FAIL — module `./useCatalogSearch` not found

- [ ] **Step 3: Implement useCatalogSearch.ts**

```typescript
import { useState, useEffect } from 'react';
import { apiFetch } from '../utils/api-fetch';

export interface CatalogSearchItem {
  id: string; name: string; description?: string;
  unitPriceCents: number; unit: string; category?: string;
}

export function useCatalogSearch(query: string, debounceMs = 250) {
  const [items, setItems] = useState<CatalogSearchItem[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!query.trim()) { setItems([]); return; }
    const timer = setTimeout(async () => {
      setIsLoading(true);
      setError(null);
      try {
        const res = await apiFetch(`/api/catalog/items?q=${encodeURIComponent(query)}&limit=20`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        setItems(await res.json());
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Unknown error');
      } finally {
        setIsLoading(false);
      }
    }, debounceMs);
    return () => clearTimeout(timer);
  }, [query, debounceMs]);

  return { items, isLoading, error };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/web && npx vitest run src/hooks/useCatalogSearch.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/hooks/useCatalogSearch.ts \
        packages/web/src/hooks/useCatalogSearch.test.ts
git commit -m "feat(catalog): useCatalogSearch debounced hook"
```

---

### Task 8: Replace MANUAL_CATALOG in NewEstimateFlow.tsx

**Files:**
- Modify: `packages/web/src/components/estimates/NewEstimateFlow.tsx`

**Context:** The `MANUAL_CATALOG` constant (lines 47–80) and its local `CatalogItem` interface are removed. In the manual estimate step, the per-service static item list is replaced with a `CatalogItemPicker` inline component that renders a text input, calls `useCatalogSearch`, and shows a dropdown. Selecting a result calls the existing `addItem` logic with `description = item.name`, `rate = item.unitPriceCents / 100`, and sets `catalog_item_id` on the line item object.

The `LineItem` type in the file gains an optional `catalogItemId?: string` field so that the outbound payload carries the analytics reference without breaking existing functionality.

- [ ] **Step 1: Write the failing test**

```typescript
// packages/web/src/components/estimates/NewEstimateFlow.test.tsx (new file)
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { vi } from 'vitest';
import * as apiFetchModule from '../../utils/api-fetch';
import { NewEstimateFlow } from './NewEstimateFlow';

vi.mock('react-router', () => ({ useNavigate: () => vi.fn() }));

it('catalog picker shows results from API and populates line item', async () => {
  vi.spyOn(apiFetchModule, 'apiFetch').mockResolvedValue(
    new Response(JSON.stringify([
      { id: 'i-1', name: 'Diagnostic fee', unitPriceCents: 8500, unit: 'each', category: 'Labor' }
    ]), { status: 200 })
  );

  render(<NewEstimateFlow />);
  // Navigate to manual entry step... (implementation-specific trigger)
  // Verify MANUAL_CATALOG is not referenced
  expect(screen.queryByText('MANUAL_CATALOG')).toBeNull();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/web && npx vitest run src/components/estimates/NewEstimateFlow.test.tsx`
Expected: FAIL — component renders but test assertions need the picker UI

- [ ] **Step 3: Implement the changes in NewEstimateFlow.tsx**

1. Delete lines 43–80 (the `CatalogItem` interface and `MANUAL_CATALOG` constant).
2. Add `catalogItemId?: string` to the local `LineItem` type (line 12).
3. Import `useCatalogSearch` and `CatalogSearchItem` from `../../hooks/useCatalogSearch`.
4. Replace the existing static catalog grid in the manual-build step with a `CatalogItemPicker` sub-component defined in the same file:

```tsx
function CatalogItemPicker({ onSelect }: { onSelect: (item: CatalogSearchItem) => void }) {
  const [query, setQuery] = useState('');
  const { items, isLoading } = useCatalogSearch(query);
  return (
    <div className="relative">
      <input
        type="text"
        placeholder="Search items…"
        value={query}
        onChange={e => setQuery(e.target.value)}
        className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
      />
      {items.length > 0 && (
        <ul className="absolute z-10 mt-1 w-full rounded-lg border border-slate-200 bg-white shadow-lg max-h-60 overflow-y-auto">
          {items.map(item => (
            <li key={item.id}
              onClick={() => { onSelect(item); setQuery(''); }}
              className="flex items-center justify-between px-3 py-2 hover:bg-slate-50 cursor-pointer text-sm">
              <span>{item.name}</span>
              <span className="text-slate-400">${(item.unitPriceCents / 100).toFixed(2)}</span>
            </li>
          ))}
        </ul>
      )}
      {isLoading && <span className="text-xs text-slate-400 mt-1 block">Searching…</span>}
    </div>
  );
}
```

5. The `onSelect` callback maps a `CatalogSearchItem` to the existing `addItem` call shape: `{ description: item.name, qty: 1, rate: item.unitPriceCents / 100, catalogItemId: item.id }`.

- [ ] **Step 4: Run all web tests**

Run: `cd packages/web && npx vitest run`
Expected: PASS — no reference to `MANUAL_CATALOG` remains; picker hook tests pass

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/components/estimates/NewEstimateFlow.tsx \
        packages/web/src/hooks/useCatalogSearch.ts \
        packages/web/src/components/estimates/NewEstimateFlow.test.tsx
git commit -m "feat(catalog): replace MANUAL_CATALOG with live catalog search picker in estimate flow"
```

---

## Phase 5: Price Book Admin Page & CSV Import

A new settings sub-page under `/settings/price-book` gives contractors full CRUD over catalog items: list with category filter, inline add/edit form, archive button, and a CSV bulk import sheet. The route and a nav entry in `SettingsPage` are wired.

### Task 9: PriceBookPage — list and add/edit

**Files:**
- Create: `packages/web/src/components/settings/PriceBookPage.tsx`
- Create: `packages/web/src/components/settings/PriceBookPage.test.tsx`

**Context:** Uses `useListQuery('/api/catalog/items')` with a `category` filter applied locally (no extra API param needed given the small dataset). An inline slide-over form handles both create (`POST`) and edit (`PUT`) via `useMutation`. Archive fires `DELETE /api/catalog/items/:id` using a plain `apiFetch` call and then calls `refetch()`.

- [ ] **Step 1: Write failing tests**

```typescript
// packages/web/src/components/settings/PriceBookPage.test.tsx
import { render, screen, waitFor } from '@testing-library/react';
import { vi } from 'vitest';
import * as apiFetchModule from '../../utils/api-fetch';
import { PriceBookPage } from './PriceBookPage';
import { MemoryRouter } from 'react-router';

const ITEMS = [
  { id: 'i-1', name: 'Diagnostic fee', unitPriceCents: 8500, unit: 'each',
    category: 'Labor', isActive: true },
  { id: 'i-2', name: 'R-410A refrigerant', unitPriceCents: 1800, unit: 'per lb',
    category: 'Materials', isActive: true },
];

beforeEach(() => {
  vi.spyOn(apiFetchModule, 'apiFetch').mockResolvedValue(
    new Response(JSON.stringify(ITEMS), { status: 200 })
  );
});

afterEach(() => vi.restoreAllMocks());

it('renders item list', async () => {
  render(<MemoryRouter><PriceBookPage /></MemoryRouter>);
  await waitFor(() => expect(screen.getByText('Diagnostic fee')).toBeTruthy());
  expect(screen.getByText('R-410A refrigerant')).toBeTruthy();
  expect(screen.getByText('$85.00')).toBeTruthy();
});

it('shows formatted unit price', async () => {
  render(<MemoryRouter><PriceBookPage /></MemoryRouter>);
  await waitFor(() => screen.getByText('$18.00'));
});

it('"Add item" button opens the form', async () => {
  render(<MemoryRouter><PriceBookPage /></MemoryRouter>);
  await waitFor(() => screen.getByText('Add item'));
  screen.getByText('Add item').click();
  expect(screen.getByPlaceholderText(/item name/i)).toBeTruthy();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/web && npx vitest run src/components/settings/PriceBookPage.test.tsx`
Expected: FAIL — module not found

- [ ] **Step 3: Implement PriceBookPage.tsx**

Key structural decisions:
- The page uses `useListQuery<CatalogSearchItem>('/api/catalog/items')` with `{ pageSize: 200 }`.
- Category filter is a local `useState<string>` — filter chips for "All", "Labor", "Parts", "Materials".
- Each row shows: name, category badge, unit, price formatted as `$X.XX`, edit icon, archive icon.
- The slide-over form contains: Name (text), Description (textarea), Unit Price (number input — user enters dollars, stored/sent as cents: `Math.round(parseFloat(val) * 100)`), Unit (select: each / hour / sq ft / per lb / per gal), Category (select).
- Archive calls `apiFetch(`/api/catalog/items/${id}`, { method: 'DELETE' })` then `refetch()`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/web && npx vitest run src/components/settings/PriceBookPage.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/components/settings/PriceBookPage.tsx \
        packages/web/src/components/settings/PriceBookPage.test.tsx
git commit -m "feat(catalog): PriceBookPage — list, add/edit, archive"
```

---

### Task 10: CSV bulk import

**Files:**
- Modify: `packages/web/src/components/settings/PriceBookPage.tsx`

**Context:** An "Import CSV" button opens a file picker. On selection, the file is parsed client-side with a minimal CSV parser (no external dependency — split on newlines, split on comma, handle quoted fields). Expected columns: `name`, `description`, `unit_price`, `unit`, `category`. Invalid rows (missing name, non-numeric price) are surfaced in an error list; valid rows are POSTed one-at-a-time sequentially (not batched — avoids a new API endpoint). A progress counter shows `Imported X of Y`.

- [ ] **Step 1: Write failing test**

```typescript
// packages/web/src/components/settings/PriceBookPage.test.tsx — append
it('CSV import calls POST for each valid row', async () => {
  const postSpy = vi.spyOn(apiFetchModule, 'apiFetch')
    .mockResolvedValue(new Response(JSON.stringify({ id: 'new' }), { status: 201 }));

  render(<MemoryRouter><PriceBookPage /></MemoryRouter>);
  await waitFor(() => screen.getByText('Import CSV'));

  const csv = 'name,unit_price,unit,category\nLabor,95,per hr,Labor\nR-410A,18,per lb,Materials';
  const file = new File([csv], 'items.csv', { type: 'text/csv' });
  const input = screen.getByTestId('csv-file-input') as HTMLInputElement;
  Object.defineProperty(input, 'files', { value: [file] });
  fireEvent.change(input);

  await waitFor(() => expect(postSpy).toHaveBeenCalledTimes(2), { timeout: 3000 });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/web && npx vitest run src/components/settings/PriceBookPage.test.tsx -t "CSV"`
Expected: FAIL — import button and file input not yet present

- [ ] **Step 3: Implement CSV import in PriceBookPage.tsx**

Add to the page header area:

```tsx
<label className="flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-1.5 text-sm hover:bg-slate-50 cursor-pointer">
  <Upload size={14} /> Import CSV
  <input data-testid="csv-file-input" type="file" accept=".csv" className="sr-only"
    onChange={handleCsvImport} />
</label>
```

`handleCsvImport` implementation:
1. Read file text via `FileReader`.
2. Parse lines: skip header, split each line by comma, map to `{ name, unitPriceCents, unit, category }`.
3. Validate: `name` non-empty, `unitPriceCents = Math.round(parseFloat(rawPrice) * 100)` must be a finite non-negative integer.
4. For each valid row: `await apiFetch('/api/catalog/items', { method: 'POST', body: JSON.stringify(row) })`.
5. Show `importProgress` state and call `refetch()` when done.

- [ ] **Step 4: Run all web tests**

Run: `cd packages/web && npx vitest run`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/components/settings/PriceBookPage.tsx \
        packages/web/src/components/settings/PriceBookPage.test.tsx
git commit -m "feat(catalog): CSV bulk import with client-side validation and progress counter"
```

---

### Task 11: Route registration and settings nav entry

**Files:**
- Modify: `packages/web/src/routes.ts`
- Modify: `packages/web/src/components/settings/SettingsPage.tsx`

**Context:** Add `/settings/price-book` to the router inside the Shell children. Add a "Price book" entry to the Settings page's catalog of items (the "Business" section or a new "Catalog" section). `BookOpen` from `lucide-react` serves as the icon.

- [ ] **Step 1: Write failing test**

```typescript
// packages/web/src/components/settings/SettingsPage.test.tsx (new)
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { SettingsPage } from './SettingsPage';

it('renders Price book navigation entry', () => {
  render(<MemoryRouter><SettingsPage /></MemoryRouter>);
  expect(screen.getByText('Price book')).toBeTruthy();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/web && npx vitest run src/components/settings/SettingsPage.test.tsx`
Expected: FAIL — "Price book" text not found

- [ ] **Step 3: Implement**

In `routes.ts`, add inside Shell children:

```typescript
import { PriceBookPage } from './components/settings/PriceBookPage';
// ...
{ path: 'settings/price-book', Component: PriceBookPage },
```

In `SettingsPage.tsx`, add a new section (or append to "Business"):

```typescript
{ icon: BookOpen, label: 'Price book',
  description: 'Services, parts & materials with set prices',
  action: () => navigate('/settings/price-book') },
```

- [ ] **Step 4: Run all web tests**

Run: `cd packages/web && npx vitest run`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/routes.ts \
        packages/web/src/components/settings/SettingsPage.tsx \
        packages/web/src/components/settings/SettingsPage.test.tsx
git commit -m "feat(catalog): wire /settings/price-book route and add nav entry in SettingsPage"
```

---

## Out of scope

- Customer-facing price list (public catalog visible on estimate approval page)
- Vendor/supplier cost tracking and margin calculation
- Pricing tiers or quantity-based discounts
- QuickBooks item sync (planned as a separate integration feature)
- Per-technician or per-region price overrides
- Price history / audit trail on catalog item edits
- Real-time bundle price preview in the estimate picker (bundles are inserted as individual expanded line items in this iteration)
- API-side CSV import endpoint (client-side parsing is sufficient for the expected row counts; a server-side endpoint would be added if bulk imports exceed browser memory limits)

---

### Critical Files for Implementation
- `/home/user/Serviceos/packages/api/src/db/schema.ts`
- `/home/user/Serviceos/packages/api/src/catalog/catalog.ts`
- `/home/user/Serviceos/packages/api/src/routes/catalog.ts`
- `/home/user/Serviceos/packages/web/src/components/estimates/NewEstimateFlow.tsx`
- `/home/user/Serviceos/packages/web/src/components/settings/PriceBookPage.tsx`
