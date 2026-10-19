/**
 * Postgres integration — S6-4 of the "pick, don't build" plan (U7 Files:
 * "extract the information_schema table walk that tenants/deprovision.ts
 * uses to purge a tenant into a shared helper that takes a keep-list, an
 * optional batch size and a beforeStep fence hook").
 *
 * Two proofs on real Postgres, no mocked pool:
 *   1. Deprovision is unchanged by the extraction: every row of every
 *      `tenant_id` table and the tenants row go, the neighbour tenant keeps
 *      every row, and `rowsDeletedByTable` counts what was there.
 *   2. The batched mode the demo reset uses: a keep-list, bounded batches
 *      each in its own transaction, and a `beforeStep` hook that runs on the
 *      batch's own transaction (a throw rolls that batch back and stops the
 *      walk, while the batches already committed stay deleted).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { randomUUID } from 'crypto';
import type { Pool, PoolClient } from 'pg';
import { getSharedTestDb, createTestTenant } from './shared';
import { createLogger } from '../../src/logging/logger';
import { deprovisionTenant } from '../../src/tenants/deprovision';
import { purgeTenantRows } from '../../src/tenants/purge-walk';
import { DevStorageProvider } from '../../src/files/storage-provider';

const logger = createLogger({ service: 'test', environment: 'test', level: 'error' });

class RecordingStorage extends DevStorageProvider {
  deleted: string[] = [];
  constructor() {
    super({ publicUrlBase: 'http://localhost/storage-dev' });
  }
  override async deleteObject(bucket: string, key: string): Promise<void> {
    this.deleted.push(`${bucket}/${key}`);
  }
}

describe('Postgres integration — the shared tenant purge walk (S6-4)', () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = await getSharedTestDb();
  });

  /** A customer → location → job → appointment chain, `customers` extra customers, a file and a conversation. */
  async function seedRows(tenantId: string, customers = 1): Promise<void> {
    const customerId = randomUUID();
    const locationId = randomUUID();
    const jobId = randomUUID();
    const conversationId = randomUUID();
    await pool.query(`INSERT INTO customers (id, tenant_id, display_name, created_by) VALUES ($1, $2, 'Purge Walk', 'test')`, [
      customerId,
      tenantId,
    ]);
    for (let i = 1; i < customers; i += 1) {
      await pool.query(`INSERT INTO customers (tenant_id, display_name, created_by) VALUES ($1, $2, 'test')`, [
        tenantId,
        `Purge Walk ${i}`,
      ]);
    }
    await pool.query(
      `INSERT INTO service_locations (id, tenant_id, customer_id, street1, city, state, postal_code)
       VALUES ($1, $2, $3, '1 Main St', 'Austin', 'TX', '78701')`,
      [locationId, tenantId, customerId],
    );
    await pool.query(
      `INSERT INTO jobs (id, tenant_id, customer_id, location_id, job_number, summary, created_by)
       VALUES ($1, $2, $3, $4, $5, 'Leaky tap', 'test')`,
      [jobId, tenantId, customerId, locationId, `PW-${randomUUID().slice(0, 8)}`],
    );
    await pool.query(
      `INSERT INTO appointments (tenant_id, job_id, created_by, timezone, scheduled_start, scheduled_end)
       VALUES ($1, $2, 'test', 'America/Chicago', now() + interval '1 day', now() + interval '1 day 1 hour')`,
      [tenantId, jobId],
    );
    await pool.query(
      `INSERT INTO files (tenant_id, filename, content_type, size_bytes, s3_bucket, s3_key, uploaded_by)
       VALUES ($1, 'a.wav', 'audio/wav', 10, 'purge-bucket', $2, 'test')`,
      [tenantId, `purge/${randomUUID()}.wav`],
    );
    await pool.query(`INSERT INTO conversations (id, tenant_id, created_by) VALUES ($1, $2, 'test')`, [conversationId, tenantId]);
    await pool.query(
      `INSERT INTO messages (tenant_id, conversation_id, sender_role, sender_id, message_type) VALUES ($1, $2, 'customer', 'c', 'text')`,
      [tenantId, conversationId],
    );
    await pool.query(
      `INSERT INTO audit_events (id, tenant_id, actor_id, actor_role, event_type, entity_type, entity_id, metadata, created_at)
       VALUES ($1, $2, 'test', 'system', 'purge_walk.test', 'tenant', $3, '{}'::jsonb, now())`,
      [randomUUID(), tenantId, tenantId],
    );
  }

  async function tenantTables(): Promise<string[]> {
    const { rows } = await pool.query<{ table_name: string }>(
      `SELECT DISTINCT table_name FROM information_schema.columns
        WHERE table_schema = 'public' AND column_name = 'tenant_id' ORDER BY table_name`,
    );
    return rows.map((r) => r.table_name);
  }

  /** Non-zero row counts per tenant_id table, read as the superuser (RLS bypassed). */
  async function counts(tenantId: string): Promise<Record<string, number>> {
    const out: Record<string, number> = {};
    for (const t of await tenantTables()) {
      const { rows } = await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM "${t}" WHERE tenant_id = $1`, [tenantId]);
      if (rows[0].n > 0) out[t] = rows[0].n;
    }
    return out;
  }

  it('deprovision still purges every tenant_id table and the tenant row, and leaves the neighbour untouched', async () => {
    const a = await createTestTenant(pool);
    const b = await createTestTenant(pool);
    await seedRows(a.tenantId, 3);
    await seedRows(b.tenantId);
    const before = await counts(a.tenantId);
    const neighbour = await counts(b.tenantId);
    expect(before.customers).toBe(3);

    const storage = new RecordingStorage();
    const result = await deprovisionTenant({ pool, logger, storage }, { tenantId: a.tenantId, reason: 'manual_admin', actorId: 'test' });

    expect(result.alreadyPurged).toBe(false);
    // Only the durable deprovision record (written after the purge) names the tenant now.
    expect(await counts(a.tenantId)).toEqual({ platform_deprovision_log: 1 });
    expect((await pool.query(`SELECT 1 FROM tenants WHERE id = $1`, [a.tenantId])).rowCount).toBe(0);
    expect(result.rowsDeletedByTable.tenants).toBe(1);
    for (const [table, n] of Object.entries(before)) expect(result.rowsDeletedByTable[table], table).toBe(n);
    expect(storage.deleted).toHaveLength(1);
    expect(await counts(b.tenantId)).toEqual(neighbour);
    const log = await pool.query(`SELECT rows_deleted FROM platform_deprovision_log WHERE tenant_id = $1`, [a.tenantId]);
    expect(log.rows[0].rows_deleted.customers).toBe(3);
  });

  it('batched mode keeps the keep-list, deletes in bounded batches each with the hook on its own transaction, and leaves the tenant row', async () => {
    const a = await createTestTenant(pool);
    const b = await createTestTenant(pool);
    await seedRows(a.tenantId, 5);
    await seedRows(b.tenantId);
    const before = await counts(a.tenantId);
    const neighbour = await counts(b.tenantId);

    const steps: Array<{ table: string; guc: string }> = [];
    const deleted = await purgeTenantRows(pool, a.tenantId, {
      keep: ['audit_events', 'users'],
      batchRows: 2,
      beforeStep: async (client: PoolClient, table: string) => {
        // The batch transaction carries the tenant's GUC transaction-locally.
        const { rows } = await client.query<{ guc: string }>(`SELECT current_setting('app.current_tenant_id', true) AS guc`);
        steps.push({ table, guc: rows[0].guc });
      },
    });

    // Kept tables keep every row; everything else is gone; the tenant row stays.
    const after = await counts(a.tenantId);
    expect(after).toEqual({ audit_events: before.audit_events, users: before.users });
    expect((await pool.query(`SELECT 1 FROM tenants WHERE id = $1`, [a.tenantId])).rowCount).toBe(1);
    expect(deleted.customers).toBe(5);
    expect(deleted.audit_events).toBeUndefined();
    expect(deleted.tenants).toBeUndefined();
    // 5 customers in batches of 2: three batches, each preceded by the hook.
    expect(steps.filter((s) => s.table === 'customers')).toHaveLength(3);
    expect(steps.some((s) => s.table === 'audit_events')).toBe(false);
    expect(new Set(steps.map((s) => s.guc))).toEqual(new Set([a.tenantId]));
    expect(await counts(b.tenantId)).toEqual(neighbour);
  });

  it('a hook that throws rolls back its own batch and stops the walk; committed batches stay deleted', async () => {
    const a = await createTestTenant(pool);
    await seedRows(a.tenantId, 5);
    let customerBatches = 0;
    const marker = `purge-walk-hook-${randomUUID()}`;

    await expect(
      purgeTenantRows(pool, a.tenantId, {
        keep: ['audit_events', 'users'],
        batchRows: 2,
        beforeStep: async (client, table) => {
          if (table !== 'customers') return;
          customerBatches += 1;
          // A write on the batch's transaction: it must roll back with the batch.
          await client.query(
            `INSERT INTO audit_events (id, tenant_id, actor_id, actor_role, event_type, entity_type, entity_id, metadata, created_at)
             VALUES ($1, $2, 'test', 'system', $3, 'tenant', $4, '{}'::jsonb, now())`,
            [randomUUID(), a.tenantId, marker, a.tenantId],
          );
          if (customerBatches === 2) throw new Error('fence lost');
        },
      }),
    ).rejects.toThrow('fence lost');

    const left = await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM customers WHERE tenant_id = $1`, [a.tenantId]);
    expect(left.rows[0].n).toBe(3);
    const markers = await pool.query(`SELECT 1 FROM audit_events WHERE tenant_id = $1 AND event_type = $2`, [a.tenantId, marker]);
    expect(markers.rowCount).toBe(1);
    // Tables after `customers` in the walk were never reached.
    const jobs = await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM jobs WHERE tenant_id = $1`, [a.tenantId]);
    expect(jobs.rows[0].n).toBe(1);
  });
});
