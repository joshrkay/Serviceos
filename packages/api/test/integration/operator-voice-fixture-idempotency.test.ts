/**
 * Docker-gated retry/concurrency proof for the operator voice fixture seed.
 * A real Postgres advisory lock + provenance audit lookup must make every
 * canonical fixture and side-effect audit exactly-once per QA tenant.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import {
  closeSharedTestDb,
  createTestTenant,
  getSharedTestDb,
  type TestTenant,
} from './shared';
import {
  runOperatorVoiceFixtureSeed,
  type OperatorVoiceFixtureSeedResult,
} from '../../src/seed/operator-voice-fixture-runner';
import { OPERATOR_VOICE_FIXTURE_PROVENANCE_PREFIX } from '../../src/seed/operator-voice-fixture-plan';

const catalog = JSON.parse(
  readFileSync(
    resolve(__dirname, '../../../../fixtures/voice/operator-voice-fixture-catalog.json'),
    'utf8',
  ),
);

function ids(result: OperatorVoiceFixtureSeedResult): Record<string, string> {
  return Object.fromEntries(
    Object.entries(result.records).map(([key, record]) => [key, record.id]),
  );
}

describe('Postgres integration — operator voice fixture idempotency', () => {
  let pool: Pool;
  let tenant: TestTenant;

  beforeAll(async () => {
    pool = await getSharedTestDb();
    tenant = await createTestTenant(pool);
    await pool.query('UPDATE tenants SET name = $2 WHERE id = $1', [
      tenant.tenantId,
      'Operator Voice Idempotency QA',
    ]);
    const carlosId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO users (
         id, tenant_id, clerk_user_id, email, role, first_name, last_name
       ) VALUES ($1, $2, $3, $4, 'technician', 'Carlos', '')`,
      [
        carlosId,
        tenant.tenantId,
        `fixture-carlos-${carlosId}`,
        `carlos-${carlosId}@example.com`,
      ],
    );
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  it('runs twice and under concurrent retries with stable IDs, counts, and one audit per provenance', async () => {
    const options = {
      qaTenantId: tenant.tenantId,
      qaActorId: tenant.userId,
      targetEnvironment: 'development',
    };

    const first = await runOperatorVoiceFixtureSeed(pool, catalog, options);
    const second = await runOperatorVoiceFixtureSeed(pool, catalog, options);

    expect(first.createdKeys).toHaveLength(27);
    expect(first.reusedKeys).toEqual([]);
    expect(second.createdKeys).toEqual([]);
    expect(second.reusedKeys).toHaveLength(27);
    expect(ids(second)).toEqual(ids(first));

    const [concurrentA, concurrentB] = await Promise.all([
      runOperatorVoiceFixtureSeed(pool, catalog, options),
      runOperatorVoiceFixtureSeed(pool, catalog, options),
    ]);
    expect(ids(concurrentA)).toEqual(ids(first));
    expect(ids(concurrentB)).toEqual(ids(first));
    expect(concurrentA.createdKeys).toEqual([]);
    expect(concurrentB.createdKeys).toEqual([]);

    const expectedCounts: Record<string, number> = {
      customers: 6,
      service_locations: 6,
      jobs: 6,
      estimates: 2,
      estimate_line_items: 2,
      invoices: 4,
      invoice_line_items: 4,
      appointments: 1,
      leads: 1,
    };
    for (const [table, expected] of Object.entries(expectedCounts)) {
      const count = await pool.query<{ count: number }>(
        `SELECT COUNT(*)::int AS count FROM ${table} WHERE tenant_id = $1`,
        [tenant.tenantId],
      );
      expect(count.rows[0].count, table).toBe(expected);
    }

    const audits = await pool.query<{
      correlation_id: string;
      count: number;
    }>(
      `SELECT correlation_id, COUNT(*)::int AS count
         FROM audit_events
        WHERE tenant_id = $1
          AND correlation_id LIKE $2
        GROUP BY correlation_id
        ORDER BY correlation_id`,
      [tenant.tenantId, `${OPERATOR_VOICE_FIXTURE_PROVENANCE_PREFIX}%`],
    );
    expect(audits.rows).toHaveLength(27);
    expect(audits.rows.every((row) => row.count === 1)).toBe(true);
  });
});
