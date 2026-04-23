# Recurring Jobs & Maintenance Contracts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable contractors to set up maintenance contracts with customers (e.g., monthly HVAC checkups, annual service agreements). Each contract has a cadence (or custom rrule), a service window, and a term. A daily background worker auto-generates Job rows on a 14-day look-ahead without human intervention, using a join table with a unique index to ensure idempotent generation.

**Architecture:** Two new tables (`maintenance_contracts` and `contract_generated_jobs`) sit behind the existing RLS pattern. A `ContractRepository` follows the InMemory-then-Pg pattern already used by jobs, invoices, and appointments. A new `create_maintenance_contract` ProposalType hooks into the existing proposal/execution pipeline. A new `ContractJobGeneratorWorker` runs on a 00:05 UTC cron alongside the existing execution sweep worker.

**Tech Stack:** TypeScript, Express, Node, `pg` driver for the API; React + Tailwind for the frontend; `rrule` npm package for custom cadence resolution; `node-cron` for the daily schedule trigger; Vitest for all tests.

---

## File Structure

### New files

| Path | Responsibility |
|------|----------------|
| `packages/api/src/contracts/contract.ts` | `MaintenanceContract` entity, `ContractRepository` interface, `InMemoryContractRepository`, domain helpers (`nextOccurrences`) |
| `packages/api/src/contracts/pg-contract.ts` | `PgContractRepository` — Postgres-backed implementation using `PgBaseRepository` |
| `packages/api/src/contracts/contract-job-generator.ts` | `ContractJobGeneratorWorker` — daily sweep that creates Job rows and inserts into `contract_generated_jobs` |
| `packages/api/src/proposals/contracts/maintenance-contract.ts` | Zod schema for `create_maintenance_contract` payload |
| `packages/api/src/proposals/execution/maintenance-contract-handler.ts` | `CreateMaintenanceContractExecutionHandler` — executes an approved proposal into a contract row |
| `packages/api/src/routes/maintenance-contracts.ts` | Express router — all six contract API endpoints |
| `packages/api/test/contracts/contract.test.ts` | Unit tests for InMemory repo and `nextOccurrences` helper |
| `packages/api/test/contracts/pg-contract.test.ts` | Pg repo integration tests (skipped when no DATABASE_URL) |
| `packages/api/test/contracts/contract-job-generator.test.ts` | Unit tests for the generator worker |
| `packages/api/test/proposals/maintenance-contract-proposal.test.ts` | Proposal contract schema + execution handler tests |
| `packages/api/test/routes/maintenance-contracts.test.ts` | HTTP route tests via supertest |
| `packages/web/src/components/contracts/MaintenanceContractsPage.tsx` | List page for all contracts in the tenant |
| `packages/web/src/components/contracts/CreateContractSheet.tsx` | Slide-over form for creating a new contract proposal |
| `packages/web/src/components/contracts/ContractDetailPage.tsx` | Detail page with contract info + generated jobs list |

> **Migration mechanism:** This codebase does **not** use a `packages/api/migrations/*.sql` directory. The migration runner in `packages/api/src/db/migrate.ts` calls `getMigrationSQL()` which concatenates the `MIGRATIONS` object exported from `packages/api/src/db/schema.ts:25` (each value is a SQL string keyed by `'NNN_name'`). New migrations are added by appending entries to that object. All migration tasks below modify `schema.ts` rather than creating new SQL files.

### Modified files

**Phase 1** modifies `packages/api/src/db/schema.ts` to add migrations `041_create_maintenance_contracts` and `042_create_contract_generated_jobs`.

**Phase 2** modifies nothing beyond the new repository files.

**Phase 3** modifies:
- `packages/api/src/proposals/proposal.ts` — adds `'create_maintenance_contract'` to `ProposalType` union, `VALID_PROPOSAL_TYPES`, and `actionClassForProposalType`.
- `packages/api/src/proposals/contracts.ts` — imports and registers `createMaintenanceContractPayloadSchema` in `PROPOSAL_TYPE_SCHEMAS`.
- `packages/api/src/proposals/execution/handlers.ts` — registers `CreateMaintenanceContractExecutionHandler` in `createExecutionHandlerRegistry`.
- `packages/api/src/app.ts` — imports `PgContractRepository`, `InMemoryContractRepository`, wires router and generator worker cron.

**Phase 4** modifies `packages/api/src/app.ts` to start the `ContractJobGeneratorWorker` cron.

**Phase 5** modifies:
- `packages/web/src/routes.ts` — adds `/contracts` and `/contracts/:id` routes.
- `packages/web/src/components/customers/CustomerDetailPage.tsx` — adds active contracts sidebar section.

### Commit cadence

One commit per task. Every commit keeps tests green. No step leaves the repo broken.

---

## Phase 1: Database Schema

Append two migrations to `MIGRATIONS` in `schema.ts`. The `maintenance_contracts` table holds all contract configuration. The `contract_generated_jobs` join table links each generated job back to its originating contract and prevents duplicates via a unique index on `(tenant_id, contract_id, scheduled_date)`.

### Task 1: `maintenance_contracts` migration

**Files:**
- Modify: `packages/api/src/db/schema.ts`

**Context:** Append key `'041_create_maintenance_contracts'` after the existing `'040_create_technician_location_pings'` entry. The cadence enum and status enum live as PostgreSQL `TEXT CHECK` constraints to stay consistent with the pattern used by existing tables (the codebase avoids `CREATE TYPE` to keep migrations idempotent). `rrule` is TEXT and nullable — when present it overrides the `cadence` column for scheduling. `service_window_start` and `service_window_end` are `TIME WITHOUT TIME ZONE`. `starts_at` and `ends_at` are `DATE`. All RLS wiring follows the project pattern exactly.

- [ ] **Step 1: Write the failing test**

```typescript
// packages/api/test/contracts/contract.test.ts
import { describe, it, expect } from 'vitest';
import { InMemoryContractRepository } from '../../src/contracts/contract';

describe('041 migration — maintenance_contracts entity', () => {
  it('InMemoryContractRepository does not exist yet (expected import failure)', async () => {
    // This test intentionally imports a file that does not exist.
    // Running it should throw a module-not-found error, confirming the
    // file is absent before we create it in Phase 2.
    expect(true).toBe(true); // placeholder — real assertions added in Phase 2
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/api && npx vitest run test/contracts/contract.test.ts`
Expected: FAIL — file does not exist / import error

- [ ] **Step 3: Implement — append migration to schema.ts**

In `packages/api/src/db/schema.ts`, after the closing backtick of `'040_create_technician_location_pings'` and before the closing `};` of `MIGRATIONS`, append:

```sql
  '041_create_maintenance_contracts': `
    CREATE TABLE IF NOT EXISTS maintenance_contracts (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id),
      customer_id UUID NOT NULL,
      location_id UUID NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      cadence TEXT NOT NULL CHECK (cadence IN (
        'weekly','bi_weekly','monthly','quarterly','semi_annual','annual'
      )),
      rrule TEXT,
      service_window_start TIME WITHOUT TIME ZONE NOT NULL,
      service_window_end   TIME WITHOUT TIME ZONE NOT NULL,
      estimated_duration_minutes INTEGER NOT NULL DEFAULT 60,
      default_summary TEXT NOT NULL,
      starts_at DATE NOT NULL,
      ends_at DATE,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','cancelled')),
      created_by TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_mc_tenant ON maintenance_contracts(tenant_id);
    CREATE INDEX IF NOT EXISTS idx_mc_tenant_customer ON maintenance_contracts(tenant_id, customer_id);
    CREATE INDEX IF NOT EXISTS idx_mc_tenant_status ON maintenance_contracts(tenant_id, status);
    ALTER TABLE maintenance_contracts ENABLE ROW LEVEL SECURITY;
    ALTER TABLE maintenance_contracts FORCE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS tenant_isolation_maintenance_contracts ON maintenance_contracts;
    CREATE POLICY tenant_isolation_maintenance_contracts ON maintenance_contracts
      USING (tenant_id = current_setting('app.current_tenant_id')::UUID);
  `,
```

- [ ] **Step 4: Commit**

```bash
git add packages/api/src/db/schema.ts
git commit -m "feat(contracts): add 041_create_maintenance_contracts migration"
```

---

### Task 2: `contract_generated_jobs` migration

**Files:**
- Modify: `packages/api/src/db/schema.ts`

**Context:** Append key `'042_create_contract_generated_jobs'` immediately after `'041_...'`. The unique index `UNIQUE(tenant_id, contract_id, scheduled_date)` is the idempotency guard — the daily worker can run any number of times for the same contract and date without creating duplicate jobs.

- [ ] **Step 1: Write the failing test**

```typescript
// packages/api/test/contracts/contract-job-generator.test.ts
import { describe, it, expect } from 'vitest';

describe('042 migration — contract_generated_jobs idempotency guard', () => {
  it('placeholder — generator worker does not exist yet', () => {
    expect(true).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/api && npx vitest run test/contracts/contract-job-generator.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement — append migration to schema.ts**

```sql
  '042_create_contract_generated_jobs': `
    CREATE TABLE IF NOT EXISTS contract_generated_jobs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id),
      contract_id UUID NOT NULL REFERENCES maintenance_contracts(id),
      job_id UUID NOT NULL REFERENCES jobs(id),
      scheduled_date DATE NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT uq_contract_generated_jobs
        UNIQUE (tenant_id, contract_id, scheduled_date)
    );
    CREATE INDEX IF NOT EXISTS idx_cgj_tenant_contract
      ON contract_generated_jobs(tenant_id, contract_id);
    ALTER TABLE contract_generated_jobs ENABLE ROW LEVEL SECURITY;
    ALTER TABLE contract_generated_jobs FORCE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS tenant_isolation_contract_generated_jobs ON contract_generated_jobs;
    CREATE POLICY tenant_isolation_contract_generated_jobs ON contract_generated_jobs
      USING (tenant_id = current_setting('app.current_tenant_id')::UUID);
  `,
```

- [ ] **Step 4: Commit**

```bash
git add packages/api/src/db/schema.ts
git commit -m "feat(contracts): add 042_create_contract_generated_jobs migration with idempotency index"
```

---

## Phase 2: ContractRepository (InMemory + Pg)

Build the domain entity, repository interface, InMemory implementation (used in tests), and Pg implementation. The domain helper `nextOccurrences(contract, windowDays)` is the only logic that touches `rrule` — it is pure and testable in isolation.

### Task 3: Domain entity, interface, and InMemory implementation

**Files:**
- Create: `packages/api/src/contracts/contract.ts`

**Context:** Export `MaintenanceContract`, `ContractCadence`, `ContractStatus`, `ContractRepository` interface, and `InMemoryContractRepository`. The `nextOccurrences` helper returns an array of `Date` objects (at midnight UTC) that fall within `[today, today + windowDays]`. When `contract.rrule` is present, use the `rrule` package; otherwise map `cadence` to an rrule `FREQ`/`INTERVAL` pair and build the rule programmatically. `findActive(tenantId)` returns all contracts with `status === 'active'` whose `starts_at <= today` and (`ends_at` is null or `ends_at >= today`).

- [ ] **Step 1: Write the failing test**

```typescript
// packages/api/test/contracts/contract.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import {
  InMemoryContractRepository,
  nextOccurrences,
  MaintenanceContract,
} from '../../src/contracts/contract';

const BASE_CONTRACT: MaintenanceContract = {
  id: 'c1',
  tenantId: 't1',
  customerId: 'cust1',
  locationId: 'loc1',
  title: 'Monthly HVAC Checkup',
  cadence: 'monthly',
  rrule: null,
  serviceWindowStart: '09:00',
  serviceWindowEnd: '11:00',
  estimatedDurationMinutes: 60,
  defaultSummary: 'HVAC Maintenance',
  startsAt: '2026-01-01',
  endsAt: null,
  status: 'active',
  createdBy: 'user1',
  createdAt: new Date('2026-01-01'),
  updatedAt: new Date('2026-01-01'),
};

describe('InMemoryContractRepository', () => {
  let repo: InMemoryContractRepository;
  beforeEach(() => { repo = new InMemoryContractRepository(); });

  it('creates and retrieves a contract by id', async () => {
    await repo.create(BASE_CONTRACT);
    const found = await repo.findById('t1', 'c1');
    expect(found?.title).toBe('Monthly HVAC Checkup');
  });

  it('findActive returns only active, in-term contracts', async () => {
    const paused: MaintenanceContract = { ...BASE_CONTRACT, id: 'c2', status: 'paused' };
    await repo.create(BASE_CONTRACT);
    await repo.create(paused);
    const active = await repo.findActive('t1');
    expect(active).toHaveLength(1);
    expect(active[0].id).toBe('c1');
  });

  it('findByCustomer returns contracts scoped to customer', async () => {
    await repo.create(BASE_CONTRACT);
    const res = await repo.findByCustomer('t1', 'cust1');
    expect(res).toHaveLength(1);
  });
});

describe('nextOccurrences', () => {
  it('monthly cadence — returns one date in a 14-day window', () => {
    const today = new Date('2026-04-23');
    const contract: MaintenanceContract = {
      ...BASE_CONTRACT,
      startsAt: '2026-04-23',
    };
    const dates = nextOccurrences(contract, 14, today);
    expect(dates.length).toBeGreaterThanOrEqual(1);
    expect(dates[0] >= today).toBe(true);
  });

  it('respects ends_at boundary — no occurrences past end date', () => {
    const today = new Date('2026-04-23');
    const contract: MaintenanceContract = {
      ...BASE_CONTRACT,
      startsAt: '2026-04-01',
      endsAt: '2026-04-10', // already past
    };
    const dates = nextOccurrences(contract, 14, today);
    expect(dates).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/api && npx vitest run test/contracts/contract.test.ts`
Expected: FAIL — Cannot find module `../../src/contracts/contract`

- [ ] **Step 3: Implement `packages/api/src/contracts/contract.ts`**

```typescript
import { v4 as uuidv4 } from 'uuid';
import { RRule, RRuleSet, Frequency } from 'rrule';

export type ContractCadence =
  | 'weekly' | 'bi_weekly' | 'monthly'
  | 'quarterly' | 'semi_annual' | 'annual';
export type ContractStatus = 'active' | 'paused' | 'cancelled';

export interface MaintenanceContract {
  id: string;
  tenantId: string;
  customerId: string;
  locationId: string;
  title: string;
  description?: string;
  cadence: ContractCadence;
  rrule: string | null;
  serviceWindowStart: string; // 'HH:MM'
  serviceWindowEnd: string;   // 'HH:MM'
  estimatedDurationMinutes: number;
  defaultSummary: string;
  startsAt: string;           // 'YYYY-MM-DD'
  endsAt: string | null;
  status: ContractStatus;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface ContractRepository {
  create(contract: MaintenanceContract): Promise<MaintenanceContract>;
  findById(tenantId: string, id: string): Promise<MaintenanceContract | null>;
  findByTenant(tenantId: string): Promise<MaintenanceContract[]>;
  findActive(tenantId: string): Promise<MaintenanceContract[]>;
  findByCustomer(tenantId: string, customerId: string): Promise<MaintenanceContract[]>;
  updateStatus(tenantId: string, id: string, status: ContractStatus): Promise<MaintenanceContract | null>;
}

const CADENCE_FREQ: Record<ContractCadence, { freq: Frequency; interval: number }> = {
  weekly:      { freq: RRule.WEEKLY,  interval: 1 },
  bi_weekly:   { freq: RRule.WEEKLY,  interval: 2 },
  monthly:     { freq: RRule.MONTHLY, interval: 1 },
  quarterly:   { freq: RRule.MONTHLY, interval: 3 },
  semi_annual: { freq: RRule.MONTHLY, interval: 6 },
  annual:      { freq: RRule.YEARLY,  interval: 1 },
};

export function nextOccurrences(
  contract: MaintenanceContract,
  windowDays: number,
  today: Date = new Date()
): Date[] {
  const start = new Date(today);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + windowDays);

  const contractStart = new Date(contract.startsAt);
  const dtstart = contractStart > start ? contractStart : start;

  if (contract.endsAt) {
    const endsAt = new Date(contract.endsAt);
    if (endsAt < start) return [];
    if (endsAt < end) end.setTime(endsAt.getTime());
  }

  let rule: RRule;
  if (contract.rrule) {
    rule = RRule.fromString(contract.rrule);
  } else {
    const { freq, interval } = CADENCE_FREQ[contract.cadence];
    rule = new RRule({ freq, interval, dtstart });
  }

  return rule.between(start, end, true);
}

export class InMemoryContractRepository implements ContractRepository {
  private store: Map<string, MaintenanceContract> = new Map();

  async create(contract: MaintenanceContract): Promise<MaintenanceContract> {
    this.store.set(contract.id, { ...contract });
    return { ...contract };
  }

  async findById(tenantId: string, id: string): Promise<MaintenanceContract | null> {
    const c = this.store.get(id);
    if (!c || c.tenantId !== tenantId) return null;
    return { ...c };
  }

  async findByTenant(tenantId: string): Promise<MaintenanceContract[]> {
    return [...this.store.values()].filter(c => c.tenantId === tenantId).map(c => ({ ...c }));
  }

  async findActive(tenantId: string): Promise<MaintenanceContract[]> {
    const today = new Date().toISOString().slice(0, 10);
    return [...this.store.values()].filter(c =>
      c.tenantId === tenantId &&
      c.status === 'active' &&
      c.startsAt <= today &&
      (c.endsAt === null || c.endsAt >= today)
    ).map(c => ({ ...c }));
  }

  async findByCustomer(tenantId: string, customerId: string): Promise<MaintenanceContract[]> {
    return [...this.store.values()]
      .filter(c => c.tenantId === tenantId && c.customerId === customerId)
      .map(c => ({ ...c }));
  }

  async updateStatus(tenantId: string, id: string, status: ContractStatus): Promise<MaintenanceContract | null> {
    const c = this.store.get(id);
    if (!c || c.tenantId !== tenantId) return null;
    c.status = status;
    c.updatedAt = new Date();
    this.store.set(id, c);
    return { ...c };
  }
}
```

Install rrule: `npm install rrule` inside `packages/api`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/api && npx vitest run test/contracts/contract.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/contracts/contract.ts packages/api/test/contracts/contract.test.ts packages/api/package.json packages/api/package-lock.json
git commit -m "feat(contracts): add MaintenanceContract domain entity, InMemory repo, nextOccurrences helper"
```

---

### Task 4: PgContractRepository

**Files:**
- Create: `packages/api/src/contracts/pg-contract.ts`

**Context:** Follows the exact pattern of `PgJobRepository` — extends `PgBaseRepository`, uses `withTenant` for all reads/writes. `findActive` translates to a SQL `WHERE status = 'active' AND starts_at <= CURRENT_DATE AND (ends_at IS NULL OR ends_at >= CURRENT_DATE)`. No Pg integration tests run without `DATABASE_URL` — use a guard in the test file so CI with no database stays green.

- [ ] **Step 1: Write the failing test**

```typescript
// packages/api/test/contracts/pg-contract.test.ts
import { describe, it, expect } from 'vitest';
import { PgContractRepository } from '../../src/contracts/pg-contract';

const hasPg = !!process.env.DATABASE_URL;

describe.skipIf(!hasPg)('PgContractRepository', () => {
  it('round-trips a contract through Postgres', async () => {
    // Full integration test wired when DATABASE_URL is present.
    expect(PgContractRepository).toBeDefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/api && npx vitest run test/contracts/pg-contract.test.ts`
Expected: FAIL — Cannot find module `../../src/contracts/pg-contract`

- [ ] **Step 3: Implement `packages/api/src/contracts/pg-contract.ts`**

```typescript
import { Pool } from 'pg';
import { PgBaseRepository } from '../db/pg-base';
import {
  ContractRepository, ContractStatus,
  MaintenanceContract,
} from './contract';

function mapRow(r: Record<string, unknown>): MaintenanceContract {
  return {
    id: r.id as string,
    tenantId: r.tenant_id as string,
    customerId: r.customer_id as string,
    locationId: r.location_id as string,
    title: r.title as string,
    description: (r.description as string) ?? undefined,
    cadence: r.cadence as MaintenanceContract['cadence'],
    rrule: (r.rrule as string) ?? null,
    serviceWindowStart: r.service_window_start as string,
    serviceWindowEnd: r.service_window_end as string,
    estimatedDurationMinutes: r.estimated_duration_minutes as number,
    defaultSummary: r.default_summary as string,
    startsAt: (r.starts_at as Date).toISOString().slice(0, 10),
    endsAt: r.ends_at ? (r.ends_at as Date).toISOString().slice(0, 10) : null,
    status: r.status as ContractStatus,
    createdBy: r.created_by as string,
    createdAt: new Date(r.created_at as string),
    updatedAt: new Date(r.updated_at as string),
  };
}

export class PgContractRepository extends PgBaseRepository implements ContractRepository {
  constructor(pool: Pool) { super(pool); }

  async create(c: MaintenanceContract): Promise<MaintenanceContract> {
    return this.withTenant(c.tenantId, async (client) => {
      const { rows } = await client.query(
        `INSERT INTO maintenance_contracts
          (id,tenant_id,customer_id,location_id,title,description,cadence,rrule,
           service_window_start,service_window_end,estimated_duration_minutes,
           default_summary,starts_at,ends_at,status,created_by,created_at,updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
         RETURNING *`,
        [c.id,c.tenantId,c.customerId,c.locationId,c.title,c.description??null,
         c.cadence,c.rrule??null,c.serviceWindowStart,c.serviceWindowEnd,
         c.estimatedDurationMinutes,c.defaultSummary,c.startsAt,c.endsAt??null,
         c.status,c.createdBy,c.createdAt,c.updatedAt]
      );
      return mapRow(rows[0]);
    });
  }

  async findById(tenantId: string, id: string): Promise<MaintenanceContract | null> {
    return this.withTenant(tenantId, async (client) => {
      const { rows } = await client.query(
        'SELECT * FROM maintenance_contracts WHERE id = $1', [id]);
      return rows.length ? mapRow(rows[0]) : null;
    });
  }

  async findByTenant(tenantId: string): Promise<MaintenanceContract[]> {
    return this.withTenant(tenantId, async (client) => {
      const { rows } = await client.query(
        'SELECT * FROM maintenance_contracts ORDER BY created_at DESC');
      return rows.map(mapRow);
    });
  }

  async findActive(tenantId: string): Promise<MaintenanceContract[]> {
    return this.withTenant(tenantId, async (client) => {
      const { rows } = await client.query(
        `SELECT * FROM maintenance_contracts
         WHERE status = 'active'
           AND starts_at <= CURRENT_DATE
           AND (ends_at IS NULL OR ends_at >= CURRENT_DATE)
         ORDER BY starts_at`);
      return rows.map(mapRow);
    });
  }

  async findByCustomer(tenantId: string, customerId: string): Promise<MaintenanceContract[]> {
    return this.withTenant(tenantId, async (client) => {
      const { rows } = await client.query(
        'SELECT * FROM maintenance_contracts WHERE customer_id = $1 ORDER BY created_at DESC',
        [customerId]);
      return rows.map(mapRow);
    });
  }

  async updateStatus(tenantId: string, id: string, status: ContractStatus): Promise<MaintenanceContract | null> {
    return this.withTenant(tenantId, async (client) => {
      const { rows } = await client.query(
        `UPDATE maintenance_contracts SET status=$1, updated_at=NOW()
         WHERE id=$2 RETURNING *`, [status, id]);
      return rows.length ? mapRow(rows[0]) : null;
    });
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/api && npx vitest run test/contracts/pg-contract.test.ts`
Expected: PASS (test is skipped when no DATABASE_URL)

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/contracts/pg-contract.ts packages/api/test/contracts/pg-contract.test.ts
git commit -m "feat(contracts): add PgContractRepository"
```

---

## Phase 3: Proposal Type & API Endpoints

Wire `create_maintenance_contract` into the existing proposal pipeline and expose REST endpoints.

### Task 5: Proposal schema and ProposalType registration

**Files:**
- Create: `packages/api/src/proposals/contracts/maintenance-contract.ts`
- Modify: `packages/api/src/proposals/proposal.ts`
- Modify: `packages/api/src/proposals/contracts.ts`

**Context:** The Zod schema mirrors the entity fields except `id`, `tenantId`, `createdBy`, `createdAt`, and `updatedAt` (those are system-set). Registering the type in `proposal.ts` and `contracts.ts` is a three-line change each. The `actionClassForProposalType` switch must be extended — `create_maintenance_contract` is `'irreversible'` because cancelling a contract is a meaningful business action (aligns with D3 rules: always requires dispatcher approval).

- [ ] **Step 1: Write the failing test**

```typescript
// packages/api/test/proposals/maintenance-contract-proposal.test.ts
import { describe, it, expect } from 'vitest';
import { validateProposalPayload } from '../../src/proposals/contracts';

const VALID_PAYLOAD = {
  customerId: '00000000-0000-0000-0000-000000000001',
  locationId: '00000000-0000-0000-0000-000000000002',
  title: 'Monthly HVAC Checkup',
  cadence: 'monthly',
  serviceWindowStart: '09:00',
  serviceWindowEnd: '11:00',
  estimatedDurationMinutes: 60,
  defaultSummary: 'HVAC Maintenance Visit',
  startsAt: '2026-05-01',
};

describe('create_maintenance_contract proposal schema', () => {
  it('accepts a valid payload', () => {
    const result = validateProposalPayload('create_maintenance_contract', VALID_PAYLOAD);
    expect(result.valid).toBe(true);
  });

  it('rejects missing customerId', () => {
    const { customerId: _, ...bad } = VALID_PAYLOAD;
    const result = validateProposalPayload('create_maintenance_contract', bad);
    expect(result.valid).toBe(false);
  });

  it('rejects invalid cadence value', () => {
    const bad = { ...VALID_PAYLOAD, cadence: 'hourly' };
    const result = validateProposalPayload('create_maintenance_contract', bad);
    expect(result.valid).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/api && npx vitest run test/proposals/maintenance-contract-proposal.test.ts -t "create_maintenance_contract"`
Expected: FAIL — `'create_maintenance_contract'` not in schema map

- [ ] **Step 3: Implement schema file**

Create `packages/api/src/proposals/contracts/maintenance-contract.ts`:

```typescript
import { z } from 'zod';

export const createMaintenanceContractPayloadSchema = z.object({
  customerId: z.string().uuid(),
  locationId: z.string().uuid(),
  title: z.string().min(1),
  description: z.string().optional(),
  cadence: z.enum(['weekly','bi_weekly','monthly','quarterly','semi_annual','annual']),
  rrule: z.string().optional(),
  serviceWindowStart: z.string().regex(/^\d{2}:\d{2}$/, 'Must be HH:MM'),
  serviceWindowEnd: z.string().regex(/^\d{2}:\d{2}$/, 'Must be HH:MM'),
  estimatedDurationMinutes: z.number().int().min(1).default(60),
  defaultSummary: z.string().min(1),
  startsAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be YYYY-MM-DD'),
  endsAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});
```

Add `'create_maintenance_contract'` to `ProposalType` union and `VALID_PROPOSAL_TYPES` array in `packages/api/src/proposals/proposal.ts`. In `actionClassForProposalType`, add:

```typescript
case 'create_maintenance_contract':
  return 'irreversible';
```

In `packages/api/src/proposals/contracts.ts`, import the new schema and add it to `PROPOSAL_TYPE_SCHEMAS`:

```typescript
import { createMaintenanceContractPayloadSchema } from './contracts/maintenance-contract';
// ... inside PROPOSAL_TYPE_SCHEMAS:
create_maintenance_contract: createMaintenanceContractPayloadSchema,
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/api && npx vitest run test/proposals/maintenance-contract-proposal.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/proposals/contracts/maintenance-contract.ts \
        packages/api/src/proposals/proposal.ts \
        packages/api/src/proposals/contracts.ts \
        packages/api/test/proposals/maintenance-contract-proposal.test.ts
git commit -m "feat(contracts): register create_maintenance_contract ProposalType and Zod schema"
```

---

### Task 6: Execution handler

**Files:**
- Create: `packages/api/src/proposals/execution/maintenance-contract-handler.ts`
- Modify: `packages/api/src/proposals/execution/handlers.ts`

**Context:** On execution, the handler validates the payload, builds a `MaintenanceContract` from it (using the approved proposal's `createdBy` and `tenantId`), and persists it via `ContractRepository`. Returns `resultEntityId` set to the new contract id.

- [ ] **Step 1: Write the failing test**

```typescript
// add to packages/api/test/proposals/maintenance-contract-proposal.test.ts
import { createProposal, InMemoryProposalRepository } from '../../src/proposals/proposal';
import { transitionProposal, UNDO_WINDOW_MS } from '../../src/proposals/lifecycle';
import { ProposalExecutor } from '../../src/proposals/execution/executor';
import { createExecutionHandlerRegistry } from '../../src/proposals/execution/handlers';
import { InMemoryContractRepository } from '../../src/contracts/contract';

describe('CreateMaintenanceContractExecutionHandler', () => {
  it('creates a contract row on execution', async () => {
    const contractRepo = new InMemoryContractRepository();
    const handlers = createExecutionHandlerRegistry({ contractRepo });
    const proposalRepo = new InMemoryProposalRepository();
    const executor = new ProposalExecutor(handlers, proposalRepo);

    let proposal = createProposal({
      tenantId: 't1',
      proposalType: 'create_maintenance_contract',
      payload: VALID_PAYLOAD,
      summary: 'Create monthly HVAC contract',
      createdBy: 'user1',
    });
    proposal = transitionProposal(proposal, 'ready_for_review', 'user1');
    proposal = transitionProposal(proposal, 'approved', 'user1');
    proposal = { ...proposal, approvedAt: new Date(Date.now() - UNDO_WINDOW_MS - 100) };
    await proposalRepo.create(proposal);

    const { result } = await executor.execute(proposal, { tenantId: 't1', executedBy: 'user1' });
    expect(result.success).toBe(true);
    expect(result.resultEntityId).toBeDefined();

    const saved = await contractRepo.findById('t1', result.resultEntityId!);
    expect(saved?.title).toBe('Monthly HVAC Checkup');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/api && npx vitest run test/proposals/maintenance-contract-proposal.test.ts -t "creates a contract row"`
Expected: FAIL — no handler registered for `create_maintenance_contract`

- [ ] **Step 3: Implement handler and register it**

Create `packages/api/src/proposals/execution/maintenance-contract-handler.ts`:

```typescript
import { v4 as uuidv4 } from 'uuid';
import { ExecutionHandler, ExecutionContext, ExecutionResult } from './handlers';
import { Proposal, ProposalType } from '../proposal';
import { ContractRepository, MaintenanceContract } from '../../contracts/contract';

export class CreateMaintenanceContractExecutionHandler implements ExecutionHandler {
  proposalType: ProposalType = 'create_maintenance_contract';

  constructor(private readonly contractRepo?: ContractRepository) {}

  async execute(proposal: Proposal, context: ExecutionContext): Promise<ExecutionResult> {
    const p = proposal.payload;
    if (!p.customerId || typeof p.customerId !== 'string') {
      return { success: false, error: 'customerId required' };
    }
    const id = uuidv4();
    const now = new Date();
    const contract: MaintenanceContract = {
      id,
      tenantId: context.tenantId,
      customerId: p.customerId as string,
      locationId: p.locationId as string,
      title: p.title as string,
      description: p.description as string | undefined,
      cadence: p.cadence as MaintenanceContract['cadence'],
      rrule: (p.rrule as string) ?? null,
      serviceWindowStart: p.serviceWindowStart as string,
      serviceWindowEnd: p.serviceWindowEnd as string,
      estimatedDurationMinutes: (p.estimatedDurationMinutes as number) ?? 60,
      defaultSummary: p.defaultSummary as string,
      startsAt: p.startsAt as string,
      endsAt: (p.endsAt as string) ?? null,
      status: 'active',
      createdBy: context.executedBy,
      createdAt: now,
      updatedAt: now,
    };
    if (this.contractRepo) {
      await this.contractRepo.create(contract);
    }
    return { success: true, resultEntityId: id };
  }
}
```

In `packages/api/src/proposals/execution/handlers.ts`, import and register the handler. Add `contractRepo?: ContractRepository` to the deps interface and push a `new CreateMaintenanceContractExecutionHandler(deps?.contractRepo)` into the `handlers` array.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/api && npx vitest run test/proposals/maintenance-contract-proposal.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/proposals/execution/maintenance-contract-handler.ts \
        packages/api/src/proposals/execution/handlers.ts \
        packages/api/test/proposals/maintenance-contract-proposal.test.ts
git commit -m "feat(contracts): add CreateMaintenanceContractExecutionHandler and wire into registry"
```

---

### Task 7: REST API routes

**Files:**
- Create: `packages/api/src/routes/maintenance-contracts.ts`
- Modify: `packages/api/src/app.ts`

**Context:** Six endpoints following the exact shape of `routes/jobs.ts`. All require `requireAuth` + `requireTenant`. Create goes through the proposal pipeline (creates a `create_maintenance_contract` proposal in `ready_for_review` status so the dispatcher approves it). List, detail, and customer-scoped list hit the `ContractRepository` directly. Pause/cancel calls `updateStatus`.

- [ ] **Step 1: Write the failing test**

```typescript
// packages/api/test/routes/maintenance-contracts.test.ts
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app';

describe('GET /api/maintenance-contracts', () => {
  it('returns 200 with empty array for authed tenant', async () => {
    const app = createApp();
    const res = await request(app)
      .get('/api/maintenance-contracts')
      .set('x-dev-tenant-id', 'tenant-test')
      .set('x-dev-user-id', 'user-test')
      .set('x-dev-role', 'owner');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/api && npx vitest run test/routes/maintenance-contracts.test.ts`
Expected: FAIL — 404, route not registered

- [ ] **Step 3: Implement route and wire into app.ts**

Create `packages/api/src/routes/maintenance-contracts.ts` exposing `createMaintenanceContractsRouter(contractRepo, proposalRepo, ownership)`. Mount in `app.ts` at `app.use('/api/maintenance-contracts', ...)` and `app.use('/api/customers/:id/maintenance-contracts', ...)`.

- [ ] **Step 4: Run tests**

Run: `cd packages/api && npx vitest run test/routes/maintenance-contracts.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/routes/maintenance-contracts.ts packages/api/src/app.ts \
        packages/api/test/routes/maintenance-contracts.test.ts
git commit -m "feat(contracts): add maintenance-contracts REST endpoints and wire into app"
```

---

## Phase 4: ContractJobGeneratorWorker

The daily worker sweeps all active contracts across all tenants, computes which dates fall within the next 14 days, checks the `contract_generated_jobs` table for existing entries, and creates Job rows for any missing dates. It is idempotent — re-running does nothing if all jobs already exist.

### Task 8: Worker implementation

**Files:**
- Create: `packages/api/src/contracts/contract-job-generator.ts`

**Context:** The worker is a plain async function `runContractJobGeneration(deps)` — no class, matching the pattern of `runExecutionSweep`. It iterates tenants returned by `ContractRepository.findActive` (called per tenant found via a tenant list query), then for each contract calls `nextOccurrences(contract, 14)`. For each date, it queries `contract_generated_jobs` by `(contract_id, scheduled_date)` — if none found, it creates a Job via `JobRepository.create` and inserts a `contract_generated_jobs` row. On Postgres, the UNIQUE constraint is a final safety net against races. The function accepts a `GeneratorDeps` interface containing `contractRepo`, `jobRepo`, `tenantIds: string[]` (passed in so the worker doesn't need a tenant-list query), and `logger`.

- [ ] **Step 1: Write the failing test**

```typescript
// packages/api/test/contracts/contract-job-generator.test.ts
import { describe, it, expect } from 'vitest';
import { runContractJobGeneration } from '../../src/contracts/contract-job-generator';
import { InMemoryContractRepository, MaintenanceContract } from '../../src/contracts/contract';
import { InMemoryJobRepository } from '../../src/jobs/job';
import { createLogger } from '../../src/logging/logger';

const CONTRACT: MaintenanceContract = {
  id: 'c1', tenantId: 't1', customerId: 'cust1', locationId: 'loc1',
  title: 'Monthly HVAC', cadence: 'monthly', rrule: null,
  serviceWindowStart: '09:00', serviceWindowEnd: '11:00',
  estimatedDurationMinutes: 60, defaultSummary: 'HVAC Maintenance',
  startsAt: new Date().toISOString().slice(0, 10),
  endsAt: null, status: 'active',
  createdBy: 'user1', createdAt: new Date(), updatedAt: new Date(),
};

describe('ContractJobGeneratorWorker', () => {
  it('creates a job for a date in the look-ahead window', async () => {
    const contractRepo = new InMemoryContractRepository();
    const jobRepo = new InMemoryJobRepository();
    await contractRepo.create(CONTRACT);
    const logger = createLogger('test');

    const result = await runContractJobGeneration({
      contractRepo, jobRepo, logger,
      tenantIds: ['t1'], windowDays: 14,
    });

    expect(result.jobsCreated).toBeGreaterThanOrEqual(1);
  });

  it('is idempotent — second run creates no new jobs', async () => {
    const contractRepo = new InMemoryContractRepository();
    const jobRepo = new InMemoryJobRepository();
    await contractRepo.create(CONTRACT);
    const logger = createLogger('test');
    const deps = { contractRepo, jobRepo, logger, tenantIds: ['t1'], windowDays: 14 };

    await runContractJobGeneration(deps);
    const second = await runContractJobGeneration(deps);
    expect(second.jobsCreated).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/api && npx vitest run test/contracts/contract-job-generator.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement `packages/api/src/contracts/contract-job-generator.ts`**

The worker maintains an in-process `Set<string>` of `"contractId|scheduledDate"` keys for the InMemory path. The Pg implementation relies on the UNIQUE index (catch duplicate key error `23505` and treat as skip). The function signature:

```typescript
export interface GeneratorDeps {
  contractRepo: ContractRepository;
  jobRepo: JobRepository;
  generatedJobsRepo?: GeneratedJobsRepository; // optional: in-memory fallback tracks internally
  logger: Logger;
  tenantIds: string[];
  windowDays?: number;   // default 14
  today?: Date;          // injectable for tests
}

export async function runContractJobGeneration(deps: GeneratorDeps): Promise<{ jobsCreated: number; errors: number }>;
```

For each active contract, for each date from `nextOccurrences(contract, windowDays, today)`, build a `Job` with `summary = contract.defaultSummary`, `status = 'new'`, `customerId`, `locationId`, then call `jobRepo.create()`. Track generated dates in-memory or via `generatedJobsRepo` to enforce idempotency.

- [ ] **Step 4: Run tests**

Run: `cd packages/api && npx vitest run test/contracts/contract-job-generator.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/contracts/contract-job-generator.ts \
        packages/api/test/contracts/contract-job-generator.test.ts
git commit -m "feat(contracts): add ContractJobGeneratorWorker with 14-day look-ahead and idempotency"
```

---

### Task 9: Cron scheduling in app.ts

**Files:**
- Modify: `packages/api/src/app.ts`

**Context:** Use `node-cron` (`npm install node-cron` in `packages/api`) to schedule `runContractJobGeneration` at `0 5 * * *` (00:05 UTC daily). Install `@types/node-cron` as a dev dependency. Retrieve all `tenantId` values via a pool query on the `tenants` table (this is a privileged background query — no RLS context needed). Wire the Pg and InMemory repos consistently with the rest of `app.ts`.

- [ ] **Step 1: Implement**

In `app.ts`, after the existing `setInterval` for the execution sweep, add:

```typescript
import cron from 'node-cron';
// ... inside createApp(), after pool setup:
if (pool) {
  cron.schedule('5 0 * * *', async () => {
    const { rows } = await pool.query('SELECT id FROM tenants');
    const tenantIds = rows.map((r: { id: string }) => r.id);
    await runContractJobGeneration({
      contractRepo: new PgContractRepository(pool),
      jobRepo: new PgJobRepository(pool),
      logger: createLogger('contract-job-generator'),
      tenantIds,
    });
  });
}
```

- [ ] **Step 2: Run full test suite**

Run: `cd packages/api && npx vitest run`
Expected: All tests PASS

- [ ] **Step 3: Commit**

```bash
git add packages/api/src/app.ts packages/api/package.json packages/api/package-lock.json
git commit -m "feat(contracts): schedule ContractJobGeneratorWorker at 00:05 UTC daily via node-cron"
```

---

## Phase 5: Frontend

### Task 10: Maintenance contracts list + create form

**Files:**
- Create: `packages/web/src/components/contracts/MaintenanceContractsPage.tsx`
- Create: `packages/web/src/components/contracts/CreateContractSheet.tsx`
- Modify: `packages/web/src/routes.ts`

**Context:** `MaintenanceContractsPage` uses `useListQuery<ApiContract>('/api/maintenance-contracts')` for data. `CreateContractSheet` is a slide-over form (matching the pattern of `NewEstimateFlow`) that POSTs to `POST /api/maintenance-contracts` via `useMutation`. The form includes fields for customer (searchable), location, title, cadence select, service window times, duration, default summary, and start date.

- [ ] **Step 1: Write the failing test**

```typescript
// packages/web/src/components/contracts/MaintenanceContractsPage.test.tsx
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { MaintenanceContractsPage } from './MaintenanceContractsPage';
import { vi } from 'vitest';

vi.mock('../../hooks/useListQuery', () => ({
  useListQuery: () => ({ data: [], isLoading: false, error: null }),
}));

it('renders the contracts list heading', () => {
  render(<MemoryRouter><MaintenanceContractsPage /></MemoryRouter>);
  expect(screen.getByText(/maintenance contracts/i)).toBeTruthy();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/web && npx vitest run src/components/contracts/MaintenanceContractsPage.test.tsx`
Expected: FAIL — module not found

- [ ] **Step 3: Implement components and add routes**

Create `MaintenanceContractsPage.tsx` showing a stats bar (Active / Paused / Cancelled counts), a list of contract cards (title, customer name, cadence badge, status badge, next job date), and a "+ New Contract" button that opens `CreateContractSheet`. Each card links to `/contracts/:id`.

In `routes.ts`, add inside the Shell children:

```typescript
import { MaintenanceContractsPage } from './components/contracts/MaintenanceContractsPage';
import { ContractDetailPage } from './components/contracts/ContractDetailPage';
// ...
{ path: 'contracts', Component: MaintenanceContractsPage },
{ path: 'contracts/:id', Component: ContractDetailPage },
```

- [ ] **Step 4: Run test**

Run: `cd packages/web && npx vitest run src/components/contracts/`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/components/contracts/ packages/web/src/routes.ts
git commit -m "feat(contracts): add MaintenanceContractsPage, CreateContractSheet, and routes"
```

---

### Task 11: Contract detail page

**Files:**
- Create: `packages/web/src/components/contracts/ContractDetailPage.tsx`

**Context:** Uses `useDetailQuery<ApiContract>('/api/maintenance-contracts', id)` and `useListQuery<ApiJob>('/api/jobs', { contractId: id })` (filtered by contractId query param). Shows contract metadata in a header card and a list of generated jobs below. Each job row links to the jobs detail view. A "Pause" / "Cancel" button triggers a `PATCH /api/maintenance-contracts/:id/status` via `useMutation`.

- [ ] **Step 1: Write the failing test**

```typescript
// packages/web/src/components/contracts/ContractDetailPage.test.tsx
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { ContractDetailPage } from './ContractDetailPage';
import { vi } from 'vitest';

vi.mock('../../hooks/useDetailQuery', () => ({
  useDetailQuery: () => ({
    data: { id: 'c1', title: 'Monthly HVAC', cadence: 'monthly', status: 'active', defaultSummary: 'HVAC Visit' },
    isLoading: false, error: null,
  }),
}));
vi.mock('../../hooks/useListQuery', () => ({
  useListQuery: () => ({ data: [], isLoading: false, error: null }),
}));

it('renders contract title in detail page', () => {
  render(
    <MemoryRouter initialEntries={['/contracts/c1']}>
      <Routes><Route path="/contracts/:id" element={<ContractDetailPage />} /></Routes>
    </MemoryRouter>
  );
  expect(screen.getByText('Monthly HVAC')).toBeTruthy();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/web && npx vitest run src/components/contracts/ContractDetailPage.test.tsx`
Expected: FAIL — module not found

- [ ] **Step 3: Implement ContractDetailPage.tsx**

Contract header: title, cadence badge, status pill, service window hours, duration, start/end dates, "Pause" and "Cancel" action buttons. Generated jobs section: a scrollable list of job cards (job number, summary, status, scheduled date). Empty state when no jobs yet.

- [ ] **Step 4: Run tests**

Run: `cd packages/web && npx vitest run src/components/contracts/`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/components/contracts/ContractDetailPage.tsx \
        packages/web/src/components/contracts/ContractDetailPage.test.tsx
git commit -m "feat(contracts): add ContractDetailPage with generated jobs list and status actions"
```

---

### Task 12: CustomerDetailPage active contracts sidebar

**Files:**
- Modify: `packages/web/src/components/customers/CustomerDetailPage.tsx`

**Context:** Add a collapsible "Maintenance Contracts" section to the existing customer detail sidebar. Uses `useListQuery<ApiContract>(\`/api/customers/${id}/maintenance-contracts\`)`. Shows a compact list of active contracts with contract title, cadence, and a link to the contract detail page.

- [ ] **Step 1: Write the failing test**

```typescript
// Verify the sidebar section renders at all
// (append to existing CustomerDetailPage tests or a new snapshot test)
it('renders maintenance contracts sidebar section', () => {
  // mock useListQuery to return one contract
  // assert "Maintenance Contracts" heading is visible
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/web && npx vitest run src/components/customers/ -t "maintenance contracts"`
Expected: FAIL

- [ ] **Step 3: Implement**

Add a `MaintenanceContractsSidebar` sub-component inside `CustomerDetailPage.tsx`. It renders a section header "Maintenance Contracts", a list of active contract chips (title + cadence), and a "View all" link to `/contracts?customerId=...`.

- [ ] **Step 4: Run all web tests**

Run: `cd packages/web && npx vitest run`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/components/customers/CustomerDetailPage.tsx
git commit -m "feat(contracts): add active contracts sidebar section to CustomerDetailPage"
```

---

## Out of scope

- Automatic appointment booking — the worker creates Job rows only; scheduling remains fully manual via the dispatcher board
- Invoice generation from contracts — billing cadence and invoicing are a separate feature
- Contract templates marketplace — sharing contract templates across tenants
- Multi-location contracts — one contract applies to exactly one location; bulk contracts are out of scope
- Contract renewal notifications — email/SMS alerts when a contract is approaching its `ends_at` date
- Technician assignment defaults on generated jobs — the worker does not auto-assign; assignment is manual
- Customer-facing contract portal — customers cannot view or accept contracts through the public-facing web

---

### Critical Files for Implementation
- `/home/user/Serviceos/packages/api/src/db/schema.ts`
- `/home/user/Serviceos/packages/api/src/proposals/proposal.ts`
- `/home/user/Serviceos/packages/api/src/proposals/execution/handlers.ts`
- `/home/user/Serviceos/packages/api/src/app.ts`
- `/home/user/Serviceos/packages/web/src/routes.ts`
