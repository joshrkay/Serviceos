import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenantTransaction } from '../../src/core/db';
import { createCustomerCommand, listCustomers } from '../../src/modules/crm/customers';
import { createTestDb, createTestTenant, type TestDb } from './helpers';

describe('row level security', () => {
  let env: TestDb;
  let tenantA: string;
  let tenantB: string;
  let ownerA: string;
  let ownerB: string;

  beforeAll(async () => {
    env = await createTestDb();
    const a = await createTestTenant(env.db, 'Tenant A');
    const b = await createTestTenant(env.db, 'Tenant B');
    tenantA = a.tenantId;
    tenantB = b.tenantId;
    ownerA = a.ownerUserId;
    ownerB = b.ownerUserId;
  });

  afterAll(async () => {
    await env.destroy();
  });

  it('isolates customers between tenants', async () => {
    await env.bus.execute(
      createCustomerCommand,
      { tenantId: tenantA, actor: { type: 'user', id: ownerA } },
      { name: 'Only In A', phone: '+15550001' },
    );
    const inA = await listCustomers(env.db, tenantA);
    const inB = await listCustomers(env.db, tenantB);
    expect(inA.map((c) => c.name)).toContain('Only In A');
    expect(inB).toHaveLength(0);
  });

  it('returns no rows without tenant context, even for direct SQL', async () => {
    const client = await env.db.app.connect();
    try {
      const { rows } = await client.query('SELECT * FROM customers');
      expect(rows).toHaveLength(0);
      const tenants = await client.query('SELECT * FROM tenants');
      expect(tenants.rows).toHaveLength(0);
    } finally {
      client.release();
    }
  });

  it('blocks writes into another tenant (WITH CHECK)', async () => {
    await expect(
      withTenantTransaction(env.db, tenantA, (client) =>
        client.query(
          `INSERT INTO customers (tenant_id, name, phone) VALUES ($1, 'Smuggled', '+15550002')`,
          [tenantB],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it('blocks cross-tenant updates through tenant context', async () => {
    const updated = await withTenantTransaction(env.db, tenantB, (client) =>
      client.query(`UPDATE customers SET name = 'Hijacked' RETURNING id`),
    );
    expect(updated.rows).toHaveLength(0);
    const inA = await listCustomers(env.db, tenantA);
    expect(inA.map((c) => c.name)).toContain('Only In A');
  });

  it('users are tenant-scoped', async () => {
    const visible = await withTenantTransaction(env.db, tenantA, (client) =>
      client.query('SELECT id FROM users'),
    );
    const ids = visible.rows.map((row) => row.id);
    expect(ids).toContain(ownerA);
    expect(ids).not.toContain(ownerB);
  });

  it('events table is append-only even with tenant context', async () => {
    await expect(
      withTenantTransaction(env.db, tenantA, (client) =>
        client.query(`UPDATE events SET payload = '{}'::jsonb`),
      ),
    ).rejects.toThrow(/append-only|permission denied/);
    await expect(
      withTenantTransaction(env.db, tenantA, (client) => client.query(`DELETE FROM events`)),
    ).rejects.toThrow(/append-only|permission denied/);
  });

  it('app role cannot touch the webhook ledger (platform-only table)', async () => {
    const client = await env.db.app.connect();
    try {
      await expect(client.query('SELECT * FROM webhook_events')).rejects.toThrow(
        /permission denied/,
      );
    } finally {
      client.release();
    }
  });
});
