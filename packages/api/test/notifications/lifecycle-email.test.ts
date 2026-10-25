/**
 * The lifecycle_emails claim ledger under tenant context (raw-pg audit
 * 2026-10-23 §4 P2.4), on the fake tenant pool
 * (test/helpers/fake-tenant-pool.ts); real Postgres in
 * test/integration/lifecycle-email-tenant-context.test.ts.
 *
 * Each step — the claim, the release after a transport failure — is a tenant
 * session of its own that commits before the next one starts; no session is
 * open while the provider is called; and a caller's ambient tenant
 * transaction is never joined.
 */
import { describe, expect, it, vi } from 'vitest';
import type { PoolClient } from 'pg';
import { claimLifecycleEmail, sendLifecycleEmail } from '../../src/notifications/lifecycle-email';
import { tenantContextStore } from '../../src/middleware/tenant-context';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import type { MessageDeliveryProvider } from '../../src/notifications/delivery-provider';
import { createLogger } from '../../src/logging/logger';
import { fakeTenantPool } from '../helpers/fake-tenant-pool';

const TENANT = '55555555-5555-4555-8555-555555555555';
const logger = createLogger({ service: 'test', environment: 'test', level: 'error' });
const rendered = { subject: 'Welcome', text: 'hi', html: '<p>hi</p>' };

const verb = (sql: string) =>
  /set_config\('app\.current_tenant_id'/.test(sql) ? 'CONTEXT' : sql.trim().split(/\s+/)[0]!;

function ledger(claimed: boolean) {
  return fakeTenantPool((sql) => {
    if (/INSERT INTO lifecycle_emails/.test(sql)) return claimed ? { rows: [{ tenant_id: TENANT }], rowCount: 1 } : { rows: [], rowCount: 0 };
    if (/DELETE FROM lifecycle_emails/.test(sql)) return { rows: [], rowCount: 1 };
    return undefined;
  });
}

function delivery(onSend: () => void | Promise<void>): MessageDeliveryProvider {
  return { sendEmail: vi.fn(async () => onSend()) } as unknown as MessageDeliveryProvider;
}

describe('claimLifecycleEmail', () => {
  it('is one tenant session: BEGIN, the GUC + role, the INSERT, COMMIT', async () => {
    const fake = ledger(true);

    expect(await claimLifecycleEmail(fake.pool, TENANT, 'setup_reminder')).toBe(true);

    expect(fake.statements.map((s) => [s.checkout, verb(s.sql)])).toEqual([
      [0, 'BEGIN'],
      [0, 'CONTEXT'],
      [0, 'INSERT'],
      [0, 'COMMIT'],
    ]);
    expect(fake.statements[1]!.values).toEqual([TENANT]);
    expect(fake.statements[2]!.values).toEqual([TENANT, 'setup_reminder']);
    expect(fake.open()).toBe(0);
  });

  it('a held key answers false', async () => {
    expect(await claimLifecycleEmail(ledger(false).pool, TENANT, 'welcome')).toBe(false);
  });

  it("inside a caller's tenant transaction it still takes its own session, never the ambient client", async () => {
    const fake = ledger(true);
    const ambient = { query: vi.fn(async () => ({ rows: [], rowCount: 0 })) } as unknown as PoolClient;

    await tenantContextStore.run({ client: ambient, tenantId: TENANT }, () => claimLifecycleEmail(fake.pool, TENANT, 'welcome'));

    expect(ambient.query).not.toHaveBeenCalled();
    expect(fake.checkouts()).toBe(1);
  });
});

describe('sendLifecycleEmail', () => {
  it('a send: the claim session commits and closes before the provider is called; nothing is open during the call', async () => {
    const fake = ledger(true);
    const atProvider: Array<{ open: number; statements: string[] }> = [];
    const provider = delivery(() => {
      atProvider.push({ open: fake.open(), statements: fake.statements.map((s) => verb(s.sql)) });
    });

    const outcome = await sendLifecycleEmail(
      { pool: fake.pool, delivery: provider, auditRepo: new InMemoryAuditRepository(), logger },
      { tenantId: TENANT, kind: 'welcome', to: 'owner@shop.com', rendered },
    );

    expect(outcome).toBe('sent');
    expect(atProvider).toEqual([{ open: 0, statements: ['BEGIN', 'CONTEXT', 'INSERT', 'COMMIT'] }]);
    expect(fake.checkouts()).toBe(1);
  });

  it('a duplicate: the claim session only, and no provider call', async () => {
    const fake = ledger(false);
    const provider = delivery(() => undefined);

    const outcome = await sendLifecycleEmail(
      { pool: fake.pool, delivery: provider, logger },
      { tenantId: TENANT, kind: 'welcome', to: 'owner@shop.com', rendered },
    );

    expect(outcome).toBe('duplicate');
    expect(provider.sendEmail).not.toHaveBeenCalled();
    expect(fake.statements.map((s) => verb(s.sql))).toEqual(['BEGIN', 'CONTEXT', 'INSERT', 'COMMIT']);
  });

  it('a transport failure: the release is a second session, committed before the error reaches the caller', async () => {
    const fake = ledger(true);
    const provider = delivery(() => {
      throw new Error('smtp down');
    });

    await expect(
      sendLifecycleEmail(
        { pool: fake.pool, delivery: provider, logger },
        { tenantId: TENANT, kind: 'trial_3d', to: 'owner@shop.com', rendered },
      ),
    ).rejects.toThrow('smtp down');

    expect(fake.statements.map((s) => [s.checkout, verb(s.sql)])).toEqual([
      [0, 'BEGIN'],
      [0, 'CONTEXT'],
      [0, 'INSERT'],
      [0, 'COMMIT'],
      [1, 'BEGIN'],
      [1, 'CONTEXT'],
      [1, 'DELETE'],
      [1, 'COMMIT'],
    ]);
    expect(fake.statements[6]!.values).toEqual([TENANT, 'trial_3d']);
    expect(fake.open()).toBe(0);
  });
});
