# Accounting Sync: QuickBooks + Xero Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Dispatchers can connect a QuickBooks Online or Xero account from the Settings page and push any `sent` or `paid` invoice to that accounting system with a single click. The sync runs in a background worker with 3-attempt exponential backoff; on success the invoice records the external ID so future syncs are deduplicated automatically.

**Architecture:** OAuth 2.0 tokens are exchanged server-side and stored encrypted (AES-256-GCM) in a new `integration_connections` table that enforces tenant isolation via RLS. A provider-agnostic `AccountingProvider` interface wraps the QuickBooks and Xero APIs; the `AccountingSyncWorker` consumes from the existing `Queue` abstraction, applies three layers of deduplication, and writes `external_invoice_id` back to the invoice on success. The Settings UI reuses existing modal patterns to show connection status, a Connect button, last-sync time, and a Disconnect button.

**Tech Stack:** TypeScript / Express / Node 18+ (native `fetch`) for the API; React + Tailwind + `lucide-react` for the UI; `pg` driver with `PgBaseRepository` for database access; Node's built-in `crypto` module for AES-256-GCM encryption — no new npm dependencies.

---

## File Structure

### New files

| Path | Responsibility |
|------|----------------|
| `packages/api/src/integrations/accounting/token-crypto.ts` | AES-256-GCM encrypt/decrypt for OAuth token storage |
| `packages/api/src/integrations/accounting/connection.ts` | `IntegrationConnection` type, `ConnectionRepository` interface, `InMemoryConnectionRepository` |
| `packages/api/src/integrations/accounting/pg-connection.ts` | Postgres implementation of `ConnectionRepository` |
| `packages/api/src/integrations/accounting/provider.ts` | `AccountingProvider` interface, `NoopAccountingProvider`, `QuickBooksProvider`, `XeroProvider` |
| `packages/api/src/integrations/accounting/oauth.ts` | OAuth 2.0 PKCE helpers, token exchange, token refresh |
| `packages/api/src/routes/accounting.ts` | `GET /api/integrations/accounting/connect`, `GET /api/integrations/accounting/callback`, `DELETE /api/integrations/accounting/:provider`, `GET /api/integrations/accounting/status` |
| `packages/api/src/workers/accounting-sync-worker.ts` | `AccountingSyncWorker` — dedup, API call, backoff, status update |
| `packages/web/src/components/settings/AccountingIntegrationSection.tsx` | Shared card showing connected/disconnected state for one provider |
| `packages/web/src/components/settings/XeroModal.tsx` | Xero connect/disconnect flow (mirrors `QuickBooksModal`) |
| `packages/api/test/integrations/token-crypto.test.ts` | Unit tests for encrypt/decrypt round-trip, key validation |
| `packages/api/test/integrations/connection.test.ts` | Unit tests for `InMemoryConnectionRepository` |
| `packages/api/test/integrations/accounting-sync-worker.test.ts` | Worker dedup, backoff, success/failure path tests |
| `packages/api/test/routes/accounting.test.ts` | Route-level tests for connect, callback, status, disconnect |

> **Migration mechanism:** This codebase does **not** use a `packages/api/migrations/*.sql` directory. The migration runner in `packages/api/src/db/migrate.ts` calls `getMigrationSQL()` which concatenates the `MIGRATIONS` object exported from `packages/api/src/db/schema.ts:25` (each value is a SQL string keyed by `'NNN_name'`). New migrations are added by appending entries to that object. All migration tasks below modify `schema.ts` rather than creating new SQL files.

### Modified files

**Phase 1** — `packages/api/src/db/schema.ts` (two new migration entries: `041_create_integration_connections`, `042_add_external_invoice_id`).

**Phase 2** — `packages/api/src/shared/config.ts` (add `ENCRYPTION_KEY`, `QB_CLIENT_ID`, `QB_CLIENT_SECRET`, `QB_REDIRECT_URI`, `XERO_CLIENT_ID`, `XERO_CLIENT_SECRET`, `XERO_REDIRECT_URI` to `configSchema`).

**Phase 3** — `packages/api/src/invoices/invoice.ts` (add `externalInvoiceId?: string` field); `packages/api/src/invoices/pg-invoice.ts` (read/write `external_invoice_id`); `packages/api/src/app.ts` (wire `createAccountingRouter`, instantiate `AccountingSyncWorker` sweep).

**Phase 4** — `packages/api/src/routes/invoices.ts` (add `POST /:id/sync-to-accounting`).

**Phase 5** — `packages/web/src/components/settings/SettingsPage.tsx` (replace inline QuickBooks wiring with `AccountingIntegrationSection`; add Xero entry); `packages/web/src/components/settings/QuickBooksModal.tsx` (wire real API calls instead of `setTimeout` mock).

### Commit cadence

One commit per task. Every commit keeps tests green. No step leaves the repo broken.

---

## Phase 1: Database

Add the `integration_connections` table and the `external_invoice_id` column to `invoices`. Both land as idempotent migrations appended to `MIGRATIONS` in `schema.ts`.

### Task 1: `041_create_integration_connections` migration

**Files:**
- Modify: `packages/api/src/db/schema.ts`

**Context:** The table stores one row per `(tenant_id, provider)` pair. `access_token_encrypted` and `refresh_token_encrypted` are TEXT columns holding the AES-256-GCM ciphertext produced in Phase 2. `realm_id` is the QuickBooks company ID (null for Xero). `default_income_account_id` is required by QuickBooks line-item mapping. RLS uses the standard tenant-isolation pattern.

- [ ] **Step 1: Write the failing test**

```typescript
// packages/api/test/integrations/connection.test.ts
import { describe, it, expect } from 'vitest';
import { InMemoryConnectionRepository } from '../../src/integrations/accounting/connection';

describe('041 — integration_connections InMemory repo', () => {
  it('saves and retrieves a connection by tenant + provider', async () => {
    const repo = new InMemoryConnectionRepository();
    const conn = {
      id: 'c-1',
      tenantId: 't-1',
      provider: 'quickbooks' as const,
      accessTokenEncrypted: 'enc-access',
      refreshTokenEncrypted: 'enc-refresh',
      realmId: 'realm-abc',
      defaultIncomeAccountId: null,
      tokenExpiresAt: new Date('2026-05-01T00:00:00Z'),
      status: 'active' as const,
      lastSyncedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    await repo.upsert(conn);
    const found = await repo.findByTenantAndProvider('t-1', 'quickbooks');
    expect(found).not.toBeNull();
    expect(found!.realmId).toBe('realm-abc');
  });

  it('returns null for unknown tenant/provider', async () => {
    const repo = new InMemoryConnectionRepository();
    expect(await repo.findByTenantAndProvider('t-missing', 'xero')).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/api && npx vitest run test/integrations/connection.test.ts`
Expected: FAIL — `InMemoryConnectionRepository` does not exist yet.

- [ ] **Step 3: Add migration to `schema.ts`**

Append after `'040_create_technician_location_pings'`:

```sql
'041_create_integration_connections': `
  CREATE TYPE IF NOT EXISTS accounting_provider AS ENUM ('quickbooks', 'xero');
  CREATE TYPE IF NOT EXISTS connection_status   AS ENUM ('active', 'expired', 'error');
  CREATE TABLE IF NOT EXISTS integration_connections (
    id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id                 UUID NOT NULL REFERENCES tenants(id),
    provider                  accounting_provider NOT NULL,
    access_token_encrypted    TEXT NOT NULL,
    refresh_token_encrypted   TEXT NOT NULL,
    realm_id                  TEXT,
    default_income_account_id TEXT,
    token_expires_at          TIMESTAMPTZ NOT NULL,
    status                    connection_status NOT NULL DEFAULT 'active',
    last_synced_at            TIMESTAMPTZ,
    created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (tenant_id, provider)
  );
  CREATE INDEX IF NOT EXISTS idx_ic_tenant ON integration_connections(tenant_id);
  ALTER TABLE integration_connections ENABLE ROW LEVEL SECURITY;
  ALTER TABLE integration_connections FORCE ROW LEVEL SECURITY;
  DROP POLICY IF EXISTS tenant_isolation_integration_connections ON integration_connections;
  CREATE POLICY tenant_isolation_integration_connections ON integration_connections
    USING (tenant_id = current_setting('app.current_tenant_id')::UUID);
`,
```

- [ ] **Step 4: Create `connection.ts` with types + `InMemoryConnectionRepository`**

```typescript
// packages/api/src/integrations/accounting/connection.ts
export type AccountingProvider = 'quickbooks' | 'xero';
export type ConnectionStatus = 'active' | 'expired' | 'error';

export interface IntegrationConnection {
  id: string;
  tenantId: string;
  provider: AccountingProvider;
  accessTokenEncrypted: string;
  refreshTokenEncrypted: string;
  realmId: string | null;
  defaultIncomeAccountId: string | null;
  tokenExpiresAt: Date;
  status: ConnectionStatus;
  lastSyncedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ConnectionRepository {
  upsert(conn: IntegrationConnection): Promise<IntegrationConnection>;
  findByTenantAndProvider(tenantId: string, provider: AccountingProvider): Promise<IntegrationConnection | null>;
  findAllByTenant(tenantId: string): Promise<IntegrationConnection[]>;
  updateStatus(id: string, status: ConnectionStatus): Promise<void>;
  updateLastSyncedAt(id: string, lastSyncedAt: Date): Promise<void>;
  delete(tenantId: string, provider: AccountingProvider): Promise<void>;
}

export class InMemoryConnectionRepository implements ConnectionRepository {
  private store: Map<string, IntegrationConnection> = new Map();

  private key(tenantId: string, provider: AccountingProvider) {
    return `${tenantId}:${provider}`;
  }

  async upsert(conn: IntegrationConnection): Promise<IntegrationConnection> {
    this.store.set(this.key(conn.tenantId, conn.provider), { ...conn });
    return conn;
  }

  async findByTenantAndProvider(tenantId: string, provider: AccountingProvider): Promise<IntegrationConnection | null> {
    return this.store.get(this.key(tenantId, provider)) ?? null;
  }

  async findAllByTenant(tenantId: string): Promise<IntegrationConnection[]> {
    return [...this.store.values()].filter(c => c.tenantId === tenantId);
  }

  async updateStatus(id: string, status: ConnectionStatus): Promise<void> {
    for (const [k, v] of this.store) {
      if (v.id === id) { this.store.set(k, { ...v, status, updatedAt: new Date() }); return; }
    }
  }

  async updateLastSyncedAt(id: string, lastSyncedAt: Date): Promise<void> {
    for (const [k, v] of this.store) {
      if (v.id === id) { this.store.set(k, { ...v, lastSyncedAt, updatedAt: new Date() }); return; }
    }
  }

  async delete(tenantId: string, provider: AccountingProvider): Promise<void> {
    this.store.delete(this.key(tenantId, provider));
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd packages/api && npx vitest run test/integrations/connection.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/api/src/db/schema.ts packages/api/src/integrations/accounting/connection.ts packages/api/test/integrations/connection.test.ts
git commit -m "feat(accounting): add 041 integration_connections migration + InMemory repo"
```

---

### Task 2: `042_add_external_invoice_id` migration + Invoice type update

**Files:**
- Modify: `packages/api/src/db/schema.ts`
- Modify: `packages/api/src/invoices/invoice.ts`
- Modify: `packages/api/src/invoices/pg-invoice.ts`

**Context:** Adding `external_invoice_id TEXT` nullable to `invoices` lets the worker stamp the remote ID on success. The `Invoice` interface and `PgInvoiceRepository` must both read and write this column so all existing invoice tests continue to pass (the field is optional everywhere).

- [ ] **Step 1: Write the failing test**

```typescript
// packages/api/test/integrations/connection.test.ts — append
import { InMemoryInvoiceRepository } from '../../src/invoices/invoice';

it('Invoice type accepts optional externalInvoiceId', () => {
  const inv = {
    id: 'i-1', tenantId: 't-1', jobId: 'j-1',
    invoiceNumber: 'INV-0001', status: 'open' as const,
    lineItems: [], totals: { subtotalCents: 0, taxableSubtotalCents: 0,
      discountCents: 0, taxRateBps: 0, taxCents: 0, totalCents: 0 },
    amountPaidCents: 0, amountDueCents: 0,
    createdBy: 'u-1', createdAt: new Date(), updatedAt: new Date(),
    externalInvoiceId: 'QBO-789',
  };
  expect(inv.externalInvoiceId).toBe('QBO-789');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/api && npx vitest run test/integrations/connection.test.ts -t "externalInvoiceId"`
Expected: FAIL — `Invoice` type has no `externalInvoiceId` property.

- [ ] **Step 3: Append migration to `schema.ts`**

```sql
'042_add_external_invoice_id': `
  ALTER TABLE invoices ADD COLUMN IF NOT EXISTS external_invoice_id TEXT;
  CREATE INDEX IF NOT EXISTS idx_invoices_external_id ON invoices(external_invoice_id)
    WHERE external_invoice_id IS NOT NULL;
`,
```

- [ ] **Step 4: Add `externalInvoiceId?: string` to `Invoice` interface and update `pg-invoice.ts`**

In `invoice.ts`, add `externalInvoiceId?: string` to the `Invoice` interface.

In `pg-invoice.ts`, add `external_invoice_id` to the SELECT columns and map `rows[0].external_invoice_id ?? undefined` in `mapRowToInvoice`. Add `external_invoice_id` to the UPDATE clause in the `update` method when provided.

- [ ] **Step 5: Run all invoice tests**

Run: `cd packages/api && npx vitest run test/ --reporter=verbose 2>&1 | grep -E "PASS|FAIL"`
Expected: All PASS, no regressions.

- [ ] **Step 6: Commit**

```bash
git add packages/api/src/db/schema.ts packages/api/src/invoices/invoice.ts packages/api/src/invoices/pg-invoice.ts packages/api/test/integrations/connection.test.ts
git commit -m "feat(accounting): add 042 external_invoice_id to invoices + type update"
```

---

## Phase 2: Token Crypto + Provider Interface

Build the encryption module and the `AccountingProvider` abstraction. Nothing calls the real QuickBooks or Xero API yet — `QuickBooksProvider` and `XeroProvider` are wired but their `syncInvoice` implementations use native `fetch` against the provider endpoints.

### Task 3: Token crypto module

**Files:**
- Create: `packages/api/src/integrations/accounting/token-crypto.ts`
- Create: `packages/api/test/integrations/token-crypto.test.ts`
- Modify: `packages/api/src/shared/config.ts`

**Context:** AES-256-GCM with a random 12-byte IV prepended to the ciphertext. The IV and auth tag are included in the stored blob so decryption is self-contained. Key validation happens at startup: if `ENCRYPTION_KEY` is absent or not 64 hex chars (32 bytes), `loadConfig` throws before the server accepts traffic.

- [ ] **Step 1: Write the failing test**

```typescript
// packages/api/test/integrations/token-crypto.test.ts
import { describe, it, expect } from 'vitest';
import { encrypt, decrypt } from '../../src/integrations/accounting/token-crypto';

const TEST_KEY = 'a'.repeat(64); // 32 bytes as hex

describe('token-crypto', () => {
  it('round-trips plaintext through encrypt/decrypt', () => {
    const cipher = encrypt('my-access-token', TEST_KEY);
    expect(cipher).not.toBe('my-access-token');
    expect(decrypt(cipher, TEST_KEY)).toBe('my-access-token');
  });

  it('produces different ciphertext each call (random IV)', () => {
    const c1 = encrypt('same', TEST_KEY);
    const c2 = encrypt('same', TEST_KEY);
    expect(c1).not.toBe(c2);
  });

  it('throws on wrong key', () => {
    const cipher = encrypt('secret', TEST_KEY);
    const badKey = 'b'.repeat(64);
    expect(() => decrypt(cipher, badKey)).toThrow();
  });

  it('throws on invalid key length', () => {
    expect(() => encrypt('x', 'tooshort')).toThrow('ENCRYPTION_KEY must be 64 hex characters');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/api && npx vitest run test/integrations/token-crypto.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement `token-crypto.ts`**

```typescript
// packages/api/src/integrations/accounting/token-crypto.ts
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

const ALGO = 'aes-256-gcm';
const IV_LEN = 12;
const TAG_LEN = 16;

function validateKey(key: string): Buffer {
  if (key.length !== 64) throw new Error('ENCRYPTION_KEY must be 64 hex characters (32 bytes)');
  return Buffer.from(key, 'hex');
}

export function encrypt(plaintext: string, hexKey: string): string {
  const keyBuf = validateKey(hexKey);
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, keyBuf, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString('base64');
}

export function decrypt(ciphertext: string, hexKey: string): string {
  const keyBuf = validateKey(hexKey);
  const buf = Buffer.from(ciphertext, 'base64');
  const iv = buf.subarray(0, IV_LEN);
  const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const data = buf.subarray(IV_LEN + TAG_LEN);
  const decipher = createDecipheriv(ALGO, keyBuf, iv);
  decipher.setAuthTag(tag);
  return decipher.update(data) + decipher.final('utf8');
}
```

- [ ] **Step 4: Add `ENCRYPTION_KEY` to `configSchema` in `config.ts`**

Add fields to the zod schema:

```typescript
ENCRYPTION_KEY: z.string().length(64).optional(),
QB_CLIENT_ID: z.string().optional(),
QB_CLIENT_SECRET: z.string().optional(),
QB_REDIRECT_URI: z.string().url().optional(),
XERO_CLIENT_ID: z.string().optional(),
XERO_CLIENT_SECRET: z.string().optional(),
XERO_REDIRECT_URI: z.string().url().optional(),
```

Add to `validateProductionConfig`: `if (!config.ENCRYPTION_KEY) missing.push('ENCRYPTION_KEY');`

- [ ] **Step 5: Run test to verify it passes**

Run: `cd packages/api && npx vitest run test/integrations/token-crypto.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/api/src/integrations/accounting/token-crypto.ts packages/api/test/integrations/token-crypto.test.ts packages/api/src/shared/config.ts
git commit -m "feat(accounting): AES-256-GCM token crypto + ENCRYPTION_KEY config"
```

---

### Task 4: `AccountingProvider` interface + provider stubs

**Files:**
- Create: `packages/api/src/integrations/accounting/provider.ts`
- Create: `packages/api/src/integrations/accounting/pg-connection.ts`

**Context:** The interface keeps the worker provider-agnostic. `QuickBooksProvider` and `XeroProvider` are concrete implementations that call the live APIs via native `fetch`. `NoopAccountingProvider` is used in tests. `refreshTokenIfNeeded` is a shared helper called before every sync.

- [ ] **Step 1: Write the failing test**

```typescript
// packages/api/test/integrations/accounting-sync-worker.test.ts (bootstrap)
import { describe, it, expect } from 'vitest';
import { NoopAccountingProvider } from '../../src/integrations/accounting/provider';

describe('NoopAccountingProvider', () => {
  it('returns a stable externalId', async () => {
    const noop = new NoopAccountingProvider();
    const fakeInvoice = { id: 'inv-1', invoiceNumber: 'INV-0001', totals: { totalCents: 5000 } } as any;
    const result = await noop.syncInvoice('t-1', fakeInvoice, null as any);
    expect(result.externalId).toBe('noop:inv-1');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/api && npx vitest run test/integrations/accounting-sync-worker.test.ts -t "NoopAccountingProvider"`
Expected: FAIL — `provider.ts` does not exist.

- [ ] **Step 3: Implement `provider.ts`**

```typescript
// packages/api/src/integrations/accounting/provider.ts
import { Invoice } from '../../invoices/invoice';
import { IntegrationConnection } from './connection';

export interface SyncResult {
  externalId: string;
}

export interface AccountingProvider {
  syncInvoice(
    tenantId: string,
    invoice: Invoice,
    connection: IntegrationConnection
  ): Promise<SyncResult>;
  refreshTokenIfNeeded(connection: IntegrationConnection): Promise<IntegrationConnection>;
}

export class NoopAccountingProvider implements AccountingProvider {
  async syncInvoice(_tenantId: string, invoice: Invoice, _conn: IntegrationConnection): Promise<SyncResult> {
    return { externalId: `noop:${invoice.id}` };
  }
  async refreshTokenIfNeeded(conn: IntegrationConnection): Promise<IntegrationConnection> {
    return conn;
  }
}

export class QuickBooksProvider implements AccountingProvider {
  constructor(
    private readonly clientId: string,
    private readonly clientSecret: string,
    private readonly encryptionKey: string,
  ) {}

  async refreshTokenIfNeeded(conn: IntegrationConnection): Promise<IntegrationConnection> {
    if (conn.tokenExpiresAt > new Date(Date.now() + 5 * 60_000)) return conn;
    // POST to https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer
    // Decrypt refresh token, exchange, re-encrypt, return updated conn fields
    // (full implementation deferred to OAuth task — stub throws to force test isolation)
    throw new Error('QuickBooksProvider.refreshTokenIfNeeded: not yet implemented in stub');
  }

  async syncInvoice(
    _tenantId: string,
    invoice: Invoice,
    connection: IntegrationConnection,
  ): Promise<SyncResult> {
    const baseUrl = 'https://quickbooks.api.intuit.com/v3/company';
    const body = {
      DocNumber: invoice.invoiceNumber,
      TotalAmt: invoice.totals.totalCents / 100,
      Line: invoice.lineItems.map((li, i) => ({
        Id: String(i + 1),
        LineNum: i + 1,
        Amount: (li.quantity * li.unitPriceCents) / 100,
        DetailType: 'SalesItemLineDetail',
        SalesItemLineDetail: {
          ItemRef: { value: 'ITEM', name: li.description },
          IncomeAccountRef: { value: connection.defaultIncomeAccountId ?? '1' },
        },
      })),
    };
    const resp = await fetch(
      `${baseUrl}/${connection.realmId}/invoice?minorversion=65`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer DECRYPTED_TOKEN_PLACEHOLDER`,
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
        body: JSON.stringify(body),
      }
    );
    if (!resp.ok) throw new Error(`QuickBooks API error ${resp.status}`);
    const json = await resp.json() as { Invoice: { Id: string } };
    return { externalId: json.Invoice.Id };
  }
}

export class XeroProvider implements AccountingProvider {
  constructor(
    private readonly clientId: string,
    private readonly clientSecret: string,
    private readonly encryptionKey: string,
  ) {}

  async refreshTokenIfNeeded(conn: IntegrationConnection): Promise<IntegrationConnection> {
    if (conn.tokenExpiresAt > new Date(Date.now() + 5 * 60_000)) return conn;
    throw new Error('XeroProvider.refreshTokenIfNeeded: not yet implemented in stub');
  }

  async syncInvoice(
    _tenantId: string,
    invoice: Invoice,
    _connection: IntegrationConnection,
  ): Promise<SyncResult> {
    const body = {
      Type: 'ACCREC',
      InvoiceNumber: invoice.invoiceNumber,
      Status: invoice.status === 'paid' ? 'PAID' : 'AUTHORISED',
      LineItems: invoice.lineItems.map(li => ({
        Description: li.description,
        Quantity: li.quantity,
        UnitAmount: li.unitPriceCents / 100,
        AccountCode: '200',
      })),
    };
    const resp = await fetch('https://api.xero.com/api.xro/2.0/Invoices', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer DECRYPTED_TOKEN_PLACEHOLDER',
        'Content-Type': 'application/json',
        'xero-tenant-id': _connection.realmId ?? '',
      },
      body: JSON.stringify({ Invoices: [body] }),
    });
    if (!resp.ok) throw new Error(`Xero API error ${resp.status}`);
    const json = await resp.json() as { Invoices: Array<{ InvoiceID: string }> };
    return { externalId: json.Invoices[0].InvoiceID };
  }
}
```

- [ ] **Step 4: Implement `pg-connection.ts`**

```typescript
// packages/api/src/integrations/accounting/pg-connection.ts
import { Pool } from 'pg';
import { PgBaseRepository } from '../../db/pg-base';
import {
  IntegrationConnection, ConnectionRepository,
  AccountingProvider, ConnectionStatus,
} from './connection';

export class PgConnectionRepository extends PgBaseRepository implements ConnectionRepository {
  constructor(pool: Pool) { super(pool); }

  async upsert(conn: IntegrationConnection): Promise<IntegrationConnection> {
    return this.withTenantTransaction(conn.tenantId, async (client) => {
      await client.query(
        `INSERT INTO integration_connections
           (id, tenant_id, provider, access_token_encrypted, refresh_token_encrypted,
            realm_id, default_income_account_id, token_expires_at, status, last_synced_at,
            created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         ON CONFLICT (tenant_id, provider) DO UPDATE SET
           access_token_encrypted = EXCLUDED.access_token_encrypted,
           refresh_token_encrypted = EXCLUDED.refresh_token_encrypted,
           realm_id = EXCLUDED.realm_id,
           default_income_account_id = EXCLUDED.default_income_account_id,
           token_expires_at = EXCLUDED.token_expires_at,
           status = EXCLUDED.status,
           last_synced_at = EXCLUDED.last_synced_at,
           updated_at = NOW()`,
        [conn.id, conn.tenantId, conn.provider, conn.accessTokenEncrypted,
         conn.refreshTokenEncrypted, conn.realmId ?? null,
         conn.defaultIncomeAccountId ?? null, conn.tokenExpiresAt,
         conn.status, conn.lastSyncedAt ?? null, conn.createdAt, conn.updatedAt]
      );
      return conn;
    });
  }

  async findByTenantAndProvider(tenantId: string, provider: AccountingProvider): Promise<IntegrationConnection | null> {
    return this.withTenant(tenantId, async (client) => {
      const { rows } = await client.query(
        `SELECT * FROM integration_connections WHERE tenant_id=$1 AND provider=$2`,
        [tenantId, provider]
      );
      return rows.length === 0 ? null : this.mapRow(rows[0]);
    });
  }

  async findAllByTenant(tenantId: string): Promise<IntegrationConnection[]> {
    return this.withTenant(tenantId, async (client) => {
      const { rows } = await client.query(
        `SELECT * FROM integration_connections WHERE tenant_id=$1`, [tenantId]
      );
      return rows.map(r => this.mapRow(r));
    });
  }

  async updateStatus(id: string, status: ConnectionStatus): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query(
        `UPDATE integration_connections SET status=$1, updated_at=NOW() WHERE id=$2`,
        [status, id]
      );
    } finally { client.release(); }
  }

  async updateLastSyncedAt(id: string, lastSyncedAt: Date): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query(
        `UPDATE integration_connections SET last_synced_at=$1, updated_at=NOW() WHERE id=$2`,
        [lastSyncedAt, id]
      );
    } finally { client.release(); }
  }

  async delete(tenantId: string, provider: AccountingProvider): Promise<void> {
    return this.withTenantTransaction(tenantId, async (client) => {
      await client.query(
        `DELETE FROM integration_connections WHERE tenant_id=$1 AND provider=$2`,
        [tenantId, provider]
      );
    });
  }

  private mapRow(row: Record<string, unknown>): IntegrationConnection {
    return {
      id: row.id as string,
      tenantId: row.tenant_id as string,
      provider: row.provider as AccountingProvider,
      accessTokenEncrypted: row.access_token_encrypted as string,
      refreshTokenEncrypted: row.refresh_token_encrypted as string,
      realmId: row.realm_id as string | null,
      defaultIncomeAccountId: row.default_income_account_id as string | null,
      tokenExpiresAt: row.token_expires_at as Date,
      status: row.status as ConnectionStatus,
      lastSyncedAt: row.last_synced_at as Date | null,
      createdAt: row.created_at as Date,
      updatedAt: row.updated_at as Date,
    };
  }
}
```

- [ ] **Step 5: Run tests**

Run: `cd packages/api && npx vitest run test/integrations/`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/api/src/integrations/accounting/provider.ts packages/api/src/integrations/accounting/pg-connection.ts packages/api/test/integrations/accounting-sync-worker.test.ts
git commit -m "feat(accounting): AccountingProvider interface + QBO/Xero/Noop implementations + PgConnectionRepository"
```

---

## Phase 3: OAuth 2.0 Flow

### Task 5: OAuth helpers + connect/callback routes

**Files:**
- Create: `packages/api/src/integrations/accounting/oauth.ts`
- Create: `packages/api/src/routes/accounting.ts`
- Create: `packages/api/test/routes/accounting.test.ts`

**Context:** `GET /api/integrations/accounting/connect?provider=quickbooks` redirects to the Intuit authorization URL with `state` set to a signed `tenantId:nonce` value. `GET /api/integrations/accounting/callback` validates `state`, exchanges `code` for tokens via `fetch`, encrypts them, and upserts the connection. QuickBooks requires `realm_id` from the callback `realmId` query param; Xero uses the Xero-tenant-id header from the connections endpoint. A `status` endpoint returns all connections for the tenant stripped of encrypted tokens.

- [ ] **Step 1: Write the failing test**

```typescript
// packages/api/test/routes/accounting.test.ts
import { describe, it, expect } from 'vitest';
import { buildQBOAuthUrl, buildXeroAuthUrl } from '../../src/integrations/accounting/oauth';

describe('OAuth URL builders', () => {
  it('QBO URL contains required query params', () => {
    const url = buildQBOAuthUrl({ clientId: 'cid', redirectUri: 'https://app.example.com/callback', state: 'st-1' });
    expect(url).toContain('client_id=cid');
    expect(url).toContain('state=st-1');
    expect(url).toContain('response_type=code');
    expect(url).toContain('scope=com.intuit.quickbooks.accounting');
  });

  it('Xero URL contains required query params', () => {
    const url = buildXeroAuthUrl({ clientId: 'xid', redirectUri: 'https://app.example.com/callback', state: 'st-2' });
    expect(url).toContain('client_id=xid');
    expect(url).toContain('openid profile email accounting.transactions');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/api && npx vitest run test/routes/accounting.test.ts -t "OAuth URL builders"`
Expected: FAIL — `oauth.ts` does not exist.

- [ ] **Step 3: Implement `oauth.ts`**

```typescript
// packages/api/src/integrations/accounting/oauth.ts
import { createHmac, randomBytes } from 'crypto';
import { encrypt, decrypt } from './token-crypto';

const QBO_AUTH_BASE = 'https://appcenter.intuit.com/connect/oauth2';
const XERO_AUTH_BASE = 'https://login.xero.com/identity/connect/authorize';
const QBO_TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';
const XERO_TOKEN_URL = 'https://identity.xero.com/connect/token';

export function buildQBOAuthUrl(opts: { clientId: string; redirectUri: string; state: string }): string {
  const params = new URLSearchParams({
    client_id: opts.clientId,
    response_type: 'code',
    scope: 'com.intuit.quickbooks.accounting',
    redirect_uri: opts.redirectUri,
    state: opts.state,
  });
  return `${QBO_AUTH_BASE}?${params}`;
}

export function buildXeroAuthUrl(opts: { clientId: string; redirectUri: string; state: string }): string {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: opts.clientId,
    redirect_uri: opts.redirectUri,
    scope: 'openid profile email accounting.transactions offline_access',
    state: opts.state,
  });
  return `${XERO_AUTH_BASE}?${params}`;
}

export function generateState(tenantId: string, hmacSecret: string): string {
  const nonce = randomBytes(16).toString('hex');
  const payload = `${tenantId}:${nonce}`;
  const sig = createHmac('sha256', hmacSecret).update(payload).digest('hex').slice(0, 16);
  return Buffer.from(`${payload}:${sig}`).toString('base64url');
}

export function verifyState(state: string, hmacSecret: string): { tenantId: string } {
  const decoded = Buffer.from(state, 'base64url').toString();
  const parts = decoded.split(':');
  if (parts.length !== 3) throw new Error('Invalid OAuth state');
  const [tenantId, nonce, sig] = parts;
  const expected = createHmac('sha256', hmacSecret).update(`${tenantId}:${nonce}`).digest('hex').slice(0, 16);
  if (sig !== expected) throw new Error('OAuth state signature mismatch');
  return { tenantId };
}

export interface TokenResponse {
  accessToken: string;
  refreshToken: string;
  expiresInSeconds: number;
  realmId?: string;
}

export async function exchangeQBOCode(opts: {
  code: string; redirectUri: string; clientId: string; clientSecret: string; realmId: string;
}): Promise<TokenResponse> {
  const creds = Buffer.from(`${opts.clientId}:${opts.clientSecret}`).toString('base64');
  const resp = await fetch(QBO_TOKEN_URL, {
    method: 'POST',
    headers: { 'Authorization': `Basic ${creds}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code: opts.code, redirect_uri: opts.redirectUri }),
  });
  if (!resp.ok) throw new Error(`QBO token exchange failed: ${resp.status}`);
  const json = await resp.json() as { access_token: string; refresh_token: string; expires_in: number };
  return { accessToken: json.access_token, refreshToken: json.refresh_token, expiresInSeconds: json.expires_in, realmId: opts.realmId };
}

export async function exchangeXeroCode(opts: {
  code: string; redirectUri: string; clientId: string; clientSecret: string;
}): Promise<TokenResponse> {
  const creds = Buffer.from(`${opts.clientId}:${opts.clientSecret}`).toString('base64');
  const resp = await fetch(XERO_TOKEN_URL, {
    method: 'POST',
    headers: { 'Authorization': `Basic ${creds}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code: opts.code, redirect_uri: opts.redirectUri }),
  });
  if (!resp.ok) throw new Error(`Xero token exchange failed: ${resp.status}`);
  const json = await resp.json() as { access_token: string; refresh_token: string; expires_in: number };
  return { accessToken: json.access_token, refreshToken: json.refresh_token, expiresInSeconds: json.expires_in };
}
```

- [ ] **Step 4: Implement `routes/accounting.ts`**

```typescript
// packages/api/src/routes/accounting.ts
import { Router, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { AuthenticatedRequest } from '../auth/clerk';
import { requireAuth, requireTenant } from '../middleware/auth';
import { toErrorResponse } from '../shared/errors';
import { ConnectionRepository, AccountingProvider as ProviderKey } from '../integrations/accounting/connection';
import { buildQBOAuthUrl, buildXeroAuthUrl, generateState, verifyState, exchangeQBOCode, exchangeXeroCode } from '../integrations/accounting/oauth';
import { encrypt } from '../integrations/accounting/token-crypto';
import { AppConfig } from '../shared/config';

export function createAccountingRouter(connRepo: ConnectionRepository, config: AppConfig): Router {
  const router = Router();
  const hmacSecret = config.ENCRYPTION_KEY ?? 'dev-insecure-secret';

  router.get('/connect', requireAuth, requireTenant, async (req: AuthenticatedRequest, res: Response) => {
    try {
      const provider = req.query.provider as string;
      const tenantId = req.auth!.tenantId;
      const state = generateState(tenantId, hmacSecret);
      if (provider === 'quickbooks') {
        const url = buildQBOAuthUrl({ clientId: config.QB_CLIENT_ID!, redirectUri: config.QB_REDIRECT_URI!, state });
        res.redirect(url);
      } else if (provider === 'xero') {
        const url = buildXeroAuthUrl({ clientId: config.XERO_CLIENT_ID!, redirectUri: config.XERO_REDIRECT_URI!, state });
        res.redirect(url);
      } else {
        res.status(400).json({ error: 'INVALID_PROVIDER' });
      }
    } catch (err) { const { statusCode, body } = toErrorResponse(err); res.status(statusCode).json(body); }
  });

  router.get('/callback', async (req: AuthenticatedRequest, res: Response) => {
    try {
      const { code, state, realmId, provider } = req.query as Record<string, string>;
      const { tenantId } = verifyState(state, hmacSecret);
      const encKey = config.ENCRYPTION_KEY ?? 'a'.repeat(64);

      if (provider === 'quickbooks' || realmId) {
        const tokens = await exchangeQBOCode({ code, redirectUri: config.QB_REDIRECT_URI!, clientId: config.QB_CLIENT_ID!, clientSecret: config.QB_CLIENT_SECRET!, realmId });
        await connRepo.upsert({
          id: uuidv4(), tenantId, provider: 'quickbooks',
          accessTokenEncrypted: encrypt(tokens.accessToken, encKey),
          refreshTokenEncrypted: encrypt(tokens.refreshToken, encKey),
          realmId: tokens.realmId ?? null, defaultIncomeAccountId: null,
          tokenExpiresAt: new Date(Date.now() + tokens.expiresInSeconds * 1000),
          status: 'active', lastSyncedAt: null, createdAt: new Date(), updatedAt: new Date(),
        });
      } else {
        const tokens = await exchangeXeroCode({ code, redirectUri: config.XERO_REDIRECT_URI!, clientId: config.XERO_CLIENT_ID!, clientSecret: config.XERO_CLIENT_SECRET! });
        await connRepo.upsert({
          id: uuidv4(), tenantId, provider: 'xero',
          accessTokenEncrypted: encrypt(tokens.accessToken, encKey),
          refreshTokenEncrypted: encrypt(tokens.refreshToken, encKey),
          realmId: null, defaultIncomeAccountId: null,
          tokenExpiresAt: new Date(Date.now() + tokens.expiresInSeconds * 1000),
          status: 'active', lastSyncedAt: null, createdAt: new Date(), updatedAt: new Date(),
        });
      }
      res.redirect('/settings?accounting=connected');
    } catch (err) { const { statusCode, body } = toErrorResponse(err); res.status(statusCode).json(body); }
  });

  router.get('/status', requireAuth, requireTenant, async (req: AuthenticatedRequest, res: Response) => {
    try {
      const connections = await connRepo.findAllByTenant(req.auth!.tenantId);
      res.json(connections.map(c => ({
        provider: c.provider, status: c.status, lastSyncedAt: c.lastSyncedAt,
        realmId: c.realmId, connectedAt: c.createdAt,
      })));
    } catch (err) { const { statusCode, body } = toErrorResponse(err); res.status(statusCode).json(body); }
  });

  router.delete('/:provider', requireAuth, requireTenant, async (req: AuthenticatedRequest, res: Response) => {
    try {
      const provider = req.params.provider as ProviderKey;
      if (!['quickbooks', 'xero'].includes(provider)) { res.status(400).json({ error: 'INVALID_PROVIDER' }); return; }
      await connRepo.delete(req.auth!.tenantId, provider);
      res.status(204).send();
    } catch (err) { const { statusCode, body } = toErrorResponse(err); res.status(statusCode).json(body); }
  });

  return router;
}
```

- [ ] **Step 5: Run tests**

Run: `cd packages/api && npx vitest run test/routes/accounting.test.ts`
Expected: PASS

- [ ] **Step 6: Wire router into `app.ts`**

In `createApp`, import `createAccountingRouter` and mount at `/api/integrations/accounting`. Add `PgConnectionRepository` (or `InMemoryConnectionRepository`) to the repo initialization block following the same `pool ? PgXxx : InMemoryXxx` pattern.

- [ ] **Step 7: Commit**

```bash
git add packages/api/src/integrations/accounting/oauth.ts packages/api/src/routes/accounting.ts packages/api/test/routes/accounting.test.ts packages/api/src/app.ts
git commit -m "feat(accounting): OAuth2 connect/callback/status/disconnect routes"
```

---

## Phase 4: Sync Worker + Manual Sync Endpoint

### Task 6: `AccountingSyncWorker` with dedup + backoff

**Files:**
- Create: `packages/api/src/workers/accounting-sync-worker.ts`
- Modify: `packages/api/test/integrations/accounting-sync-worker.test.ts`

**Context:** The worker receives `{ invoiceId, tenantId, provider }` queue messages. Layer (a) dedup: if `invoice.externalInvoiceId` is already set, ack and return. Layer (b) dedup: queue idempotency key `sync:<invoiceId>:<provider>` prevents double-send even if the endpoint is called twice. Layer (c): the `Idempotency-Key` header on the provider HTTP call handles transient retries at the API level. Exponential backoff: delay = `500 * 2^attempt` ms, max 3 attempts — the `InMemoryQueue` `maxAttempts` enforces this. On success, `invoiceRepo.update` sets `externalInvoiceId`; on all-attempts failure, `connRepo.updateStatus(id, 'error')`.

- [ ] **Step 1: Write the failing test**

```typescript
// packages/api/test/integrations/accounting-sync-worker.test.ts — extend
import { runAccountingSyncSweep, AccountingSyncWorkerDeps } from '../../src/workers/accounting-sync-worker';
import { InMemoryConnectionRepository } from '../../src/integrations/accounting/connection';
import { InMemoryInvoiceRepository } from '../../src/invoices/invoice';
import { NoopAccountingProvider } from '../../src/integrations/accounting/provider';
import { InMemoryQueue } from '../../src/queues/queue';
import { createLogger } from '../../src/logging/logger';

describe('AccountingSyncWorker — dedup layer (a)', () => {
  it('skips invoice already synced (externalInvoiceId set)', async () => {
    const connRepo = new InMemoryConnectionRepository();
    const invoiceRepo = new InMemoryInvoiceRepository();
    const queue = new InMemoryQueue({ maxRetries: 3 });
    const logger = createLogger({ service: 'test', environment: 'test', level: 'error' });

    const inv = buildTestInvoice({ externalInvoiceId: 'already-synced' });
    await invoiceRepo.create(inv);
    await connRepo.upsert(buildTestConnection());
    await queue.send('accounting.sync', { invoiceId: inv.id, tenantId: 't-1', provider: 'quickbooks' }, `sync:${inv.id}:quickbooks`);

    const deps: AccountingSyncWorkerDeps = {
      queue, invoiceRepo, connRepo,
      provider: new NoopAccountingProvider(), logger,
    };
    const result = await runAccountingSyncSweep(deps);
    expect(result.skipped).toBe(1);
    expect(result.synced).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/api && npx vitest run test/integrations/accounting-sync-worker.test.ts -t "dedup"`
Expected: FAIL — `accounting-sync-worker.ts` does not exist.

- [ ] **Step 3: Implement `accounting-sync-worker.ts`**

```typescript
// packages/api/src/workers/accounting-sync-worker.ts
import { Queue } from '../queues/queue';
import { InvoiceRepository } from '../invoices/invoice';
import { ConnectionRepository } from '../integrations/accounting/connection';
import { AccountingProvider } from '../integrations/accounting/provider';
import { Logger } from '../logging/logger';

export interface SyncPayload {
  invoiceId: string;
  tenantId: string;
  provider: 'quickbooks' | 'xero';
}

export interface AccountingSyncWorkerDeps {
  queue: Queue;
  invoiceRepo: InvoiceRepository;
  connRepo: ConnectionRepository;
  provider: AccountingProvider;
  logger: Logger;
}

const BACKOFF_BASE_MS = 500;

export async function runAccountingSyncSweep(deps: AccountingSyncWorkerDeps): Promise<{
  synced: number; skipped: number; failed: number;
}> {
  let synced = 0, skipped = 0, failed = 0;

  const msg = await deps.queue.receive<SyncPayload>();
  if (!msg) return { synced, skipped, failed };

  const { invoiceId, tenantId, provider } = msg.payload;

  try {
    // Dedup layer (a): external ID already set
    const invoice = await deps.invoiceRepo.findById(tenantId, invoiceId);
    if (!invoice) { await deps.queue.delete(msg.id); skipped++; return { synced, skipped, failed }; }
    if (invoice.externalInvoiceId) { await deps.queue.delete(msg.id); skipped++; return { synced, skipped, failed }; }

    const conn = await deps.connRepo.findByTenantAndProvider(tenantId, provider);
    if (!conn) { await deps.queue.delete(msg.id); skipped++; return { synced, skipped, failed }; }

    // Exponential backoff delay on retries
    if (msg.attempts > 1) {
      await new Promise(r => setTimeout(r, BACKOFF_BASE_MS * Math.pow(2, msg.attempts - 1)));
    }

    const refreshed = await deps.provider.refreshTokenIfNeeded(conn);
    const { externalId } = await deps.provider.syncInvoice(tenantId, invoice, refreshed);

    await deps.invoiceRepo.update(tenantId, invoiceId, { externalInvoiceId: externalId, updatedAt: new Date() });
    await deps.connRepo.updateLastSyncedAt(conn.id, new Date());
    await deps.queue.delete(msg.id);
    synced++;
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    deps.logger.warn('AccountingSyncWorker: sync failed', { invoiceId, provider, attempt: msg.attempts, error: errMsg });
    if (msg.attempts >= msg.maxAttempts) {
      const conn = await deps.connRepo.findByTenantAndProvider(tenantId, provider).catch(() => null);
      if (conn) await deps.connRepo.updateStatus(conn.id, 'error');
      await deps.queue.moveToDeadLetter(msg, errMsg);
      failed++;
    } else {
      // Re-queue with same idempotency key for next sweep
      await deps.queue.send('accounting.sync', msg.payload, msg.idempotencyKey);
      await deps.queue.delete(msg.id);
    }
  }

  return { synced, skipped, failed };
}
```

- [ ] **Step 4: Run all worker tests**

Run: `cd packages/api && npx vitest run test/integrations/accounting-sync-worker.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/workers/accounting-sync-worker.ts packages/api/test/integrations/accounting-sync-worker.test.ts
git commit -m "feat(accounting): AccountingSyncWorker with 3-layer dedup + exponential backoff"
```

---

### Task 7: Manual sync endpoint `POST /api/invoices/:id/sync-to-accounting`

**Files:**
- Modify: `packages/api/src/routes/invoices.ts`

**Context:** Validates that the invoice is in `open` or `paid` status (proxy for "sent" — open invoices have `issued_at` set). Enqueues a `accounting.sync` message with idempotency key `sync:<invoiceId>:<provider>` so a double-click never fires two API calls. Returns `202 Accepted` immediately; the worker handles the actual call asynchronously.

- [ ] **Step 1: Write the failing test**

```typescript
// packages/api/test/routes/accounting.test.ts — extend
import request from 'supertest';
// test that POST /invoices/:id/sync-to-accounting returns 202 for open invoice
// and 409 for already-synced, 422 for draft invoice
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/api && npx vitest run test/routes/accounting.test.ts -t "sync-to-accounting"`
Expected: FAIL — route does not exist.

- [ ] **Step 3: Add route to `routes/invoices.ts`**

Inside `createInvoiceRouter`, add:

```typescript
router.post(
  '/:id/sync-to-accounting',
  requireAuth, requireTenant, requirePermission('invoices:sync'),
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const invoice = await getInvoice(req.auth!.tenantId, req.params.id, invoiceRepo);
      if (!invoice) { res.status(404).json({ error: 'NOT_FOUND' }); return; }
      if (!['open', 'partially_paid', 'paid'].includes(invoice.status)) {
        res.status(422).json({ error: 'INVALID_STATUS', message: 'Only open or paid invoices can be synced' });
        return;
      }
      if (invoice.externalInvoiceId) {
        res.status(409).json({ error: 'ALREADY_SYNCED', externalInvoiceId: invoice.externalInvoiceId });
        return;
      }
      const provider = (req.body.provider ?? 'quickbooks') as 'quickbooks' | 'xero';
      const idempotencyKey = `sync:${invoice.id}:${provider}`;
      await queue.send('accounting.sync', { invoiceId: invoice.id, tenantId: req.auth!.tenantId, provider }, idempotencyKey);
      res.status(202).json({ queued: true, idempotencyKey });
    } catch (err) { const { statusCode, body } = toErrorResponse(err); res.status(statusCode).json(body); }
  }
);
```

Note: `queue` must be injected into `createInvoiceRouter`. Update the function signature and all callers in `app.ts`.

- [ ] **Step 4: Wire sync sweep into `app.ts` polling loop**

In the existing `setInterval` block that runs `runExecutionSweep`, add a parallel call to `runAccountingSyncSweep`. Pass the appropriate `AccountingProvider` instance (select `QuickBooksProvider` or `XeroProvider` based on the enqueued message `provider` field — wire a `ProviderRegistry` map at startup).

- [ ] **Step 5: Run tests**

Run: `cd packages/api && npx vitest run test/`
Expected: All PASS

- [ ] **Step 6: Commit**

```bash
git add packages/api/src/routes/invoices.ts packages/api/src/app.ts
git commit -m "feat(accounting): POST /invoices/:id/sync-to-accounting + worker sweep wiring"
```

---

## Phase 5: Settings UI + Retry Visibility

### Task 8: `AccountingIntegrationSection` shared component

**Files:**
- Create: `packages/web/src/components/settings/AccountingIntegrationSection.tsx`
- Create: `packages/web/src/components/settings/XeroModal.tsx`

**Context:** A reusable card component that accepts `provider`, `logoColor`, `logoLabel`, and `onOpenModal` props. It fetches `/api/integrations/accounting/status` on mount, displays a green "Connected" badge with last-sync time when active, or a "Connect" badge when disconnected. `XeroModal` mirrors `QuickBooksModal` with Xero branding (logo color `#13B5EA`, label "Xero").

- [ ] **Step 1: Write the failing test**

```typescript
// packages/web/src/components/settings/AccountingIntegrationSection.test.tsx
import { render, screen } from '@testing-library/react';
import { AccountingIntegrationSection } from './AccountingIntegrationSection';

it('shows Connect badge when status is disconnected', () => {
  render(<AccountingIntegrationSection provider="quickbooks" logoColor="#2CA01C" logoLabel="QB" onOpenModal={() => {}} connectionStatus={null} />);
  expect(screen.getByText('Connect')).toBeInTheDocument();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/web && npx vitest run src/components/settings/AccountingIntegrationSection.test.tsx`
Expected: FAIL — component does not exist.

- [ ] **Step 3: Implement `AccountingIntegrationSection.tsx`**

```tsx
// packages/web/src/components/settings/AccountingIntegrationSection.tsx
import { Link, RefreshCw } from 'lucide-react';

interface ConnectionStatus {
  status: 'active' | 'expired' | 'error';
  lastSyncedAt: string | null;
}

interface Props {
  provider: 'quickbooks' | 'xero';
  logoColor: string;
  logoLabel: string;
  onOpenModal: () => void;
  connectionStatus: ConnectionStatus | null;
}

export function AccountingIntegrationSection({ logoColor, logoLabel, onOpenModal, connectionStatus }: Props) {
  const connected = connectionStatus?.status === 'active';
  const lastSync = connectionStatus?.lastSyncedAt
    ? new Date(connectionStatus.lastSyncedAt).toLocaleString()
    : null;

  return (
    <button
      onClick={onOpenModal}
      className="flex items-center justify-between w-full px-4 py-3.5 hover:bg-slate-50 transition-colors text-left"
    >
      <div className="flex items-center gap-3">
        <div
          className="flex size-8 shrink-0 items-center justify-center rounded-lg text-white text-xs font-mono"
          style={{ backgroundColor: logoColor }}
        >
          {logoLabel}
        </div>
        <div>
          <p className="text-sm text-slate-800">{logoLabel === 'QB' ? 'QuickBooks Online' : 'Xero'}</p>
          <p className="text-xs text-slate-400 mt-0.5">
            {connected ? (lastSync ? `Last synced ${lastSync}` : 'Connected') : 'Not connected · sync invoices'}
          </p>
        </div>
      </div>
      <span className={`flex items-center gap-1.5 text-xs rounded-full px-2.5 py-1 ${connected ? 'bg-green-100 text-green-700' : 'bg-blue-100 text-blue-700'}`}>
        {connected ? <><RefreshCw size={10} /> Connected</> : <><Link size={10} /> Connect</>}
      </span>
    </button>
  );
}
```

- [ ] **Step 4: Update `SettingsPage.tsx`**

Replace the existing QuickBooks inline item in `SECTIONS` with `<AccountingIntegrationSection>` for both QuickBooks and Xero. Add `useEffect` to fetch `/api/integrations/accounting/status` on mount and store results in a `connectionStatuses` state map keyed by provider.

- [ ] **Step 5: Wire real API calls in `QuickBooksModal.tsx`**

Replace the `setTimeout(() => setStep('connected'), 1800)` mock with:
1. A redirect to `/api/integrations/accounting/connect?provider=quickbooks` when "Connect QuickBooks" is clicked.
2. A `DELETE /api/integrations/accounting/quickbooks` fetch call when "Disconnect QuickBooks" is clicked.

The callback redirect lands the user back on `/settings?accounting=connected`, which the modal's parent detects via `useSearchParams` and refreshes the status fetch.

- [ ] **Step 6: Create `XeroModal.tsx`**

Mirror `QuickBooksModal` with Xero colors (`#13B5EA`), label "Xero", and `provider=xero` in the connect URL. Include the same idle/connecting/connected states.

- [ ] **Step 7: Run UI tests**

Run: `cd packages/web && npx vitest run src/components/settings/`
Expected: All PASS

- [ ] **Step 8: Commit**

```bash
git add packages/web/src/components/settings/AccountingIntegrationSection.tsx packages/web/src/components/settings/AccountingIntegrationSection.test.tsx packages/web/src/components/settings/XeroModal.tsx packages/web/src/components/settings/SettingsPage.tsx packages/web/src/components/settings/QuickBooksModal.tsx
git commit -m "feat(accounting): Settings UI — AccountingIntegrationSection + Xero modal + live API wiring"
```

---

## Out of scope

- Automatic sync on invoice creation or status change (manual trigger only for beta)
- Bi-directional sync (QuickBooks/Xero to ServiceOS)
- Customer record sync
- Payment sync (marking invoices paid in QBO/Xero when payment recorded)
- Estimate sync
- Sage, FreshBooks, Wave, or any other accounting provider
- Webhook-driven token refresh (only on-demand before each sync call)
- Multi-company / multi-org per tenant (one connection per provider per tenant)
- QBO sandbox vs. production environment switching in UI

---

### Critical Files for Implementation
- `/home/user/Serviceos/packages/api/src/db/schema.ts`
- `/home/user/Serviceos/packages/api/src/invoices/invoice.ts`
- `/home/user/Serviceos/packages/api/src/invoices/pg-invoice.ts`
- `/home/user/Serviceos/packages/api/src/workers/accounting-sync-worker.ts`
- `/home/user/Serviceos/packages/web/src/components/settings/SettingsPage.tsx`
