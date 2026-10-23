/**
 * Postgres integration — `PgDelayNoticeStateRepository.findByKey` reads under
 * the caller's tenant context (raw-pg audit 2026-10-23, `missing_tenant_filter`).
 *
 * It used to run through `withClient`: `SELECT * FROM delay_notice_state WHERE
 * idempotency_key = $1` as the privileged connection principal, with no GUC, no
 * runtime role and no tenant predicate. `delay_notice_state` is FORCE RLS, so
 * that one read was the only access to the table that RLS could not bound. Both
 * callers (`enqueueDelayNotice`, `enqueueEnRouteNotice`) already hold the
 * tenant id, so the lookup now takes it and runs inside `withTenant`.
 *
 * A mocked Pool cannot show any of this: only a real RLS-subject role in real
 * Postgres proves the row of another tenant is invisible to the lookup.
 */
import crypto from 'crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { closeSharedTestDb, createTestTenant, getSharedTestDb } from './shared';
import { PgDelayNoticeStateRepository } from '../../src/notifications/pg-delay-notice-state';
import type { DelayNoticeDeliveryState } from '../../src/notifications/delay-notifications';

let pool: Pool;
let repo: PgDelayNoticeStateRepository;
const ORIGINAL_FLAG = process.env.RLS_RUNTIME_ROLE;
const createdTenantIds: string[] = [];

function stateFor(tenantId: string, idempotencyKey: string): DelayNoticeDeliveryState {
  return {
    idempotencyKey,
    tenantId,
    appointmentId: crypto.randomUUID(),
    delayVersion: 1,
    status: 'sent',
    channel: 'sms',
    attempts: 1,
    maxAttempts: 3,
    providerMessageId: 'SM-tenant-a',
    updatedAt: new Date(),
  };
}

async function tenant(): Promise<string> {
  const { tenantId } = await createTestTenant(pool);
  createdTenantIds.push(tenantId);
  return tenantId;
}

beforeAll(async () => {
  pool = await getSharedTestDb();
  repo = new PgDelayNoticeStateRepository(pool);
});

afterEach(() => {
  if (ORIGINAL_FLAG === undefined) delete process.env.RLS_RUNTIME_ROLE;
  else process.env.RLS_RUNTIME_ROLE = ORIGINAL_FLAG;
});

afterAll(async () => {
  for (const tenantId of createdTenantIds) {
    await pool.query('DELETE FROM delay_notice_state WHERE tenant_id = $1', [tenantId]).catch(() => undefined);
    await pool.query('DELETE FROM users WHERE tenant_id = $1', [tenantId]).catch(() => undefined);
    await pool.query('DELETE FROM tenants WHERE id = $1', [tenantId]).catch(() => undefined);
  }
  await closeSharedTestDb();
});

describe('PgDelayNoticeStateRepository.findByKey is tenant-scoped (real Postgres, RLS_RUNTIME_ROLE=true)', () => {
  it('returns the row to its own tenant under the RLS runtime role', async () => {
    process.env.RLS_RUNTIME_ROLE = 'true';
    const tenantA = await tenant();
    const key = `${crypto.randomUUID()}:1`;
    await repo.upsert(stateFor(tenantA, key));

    const found = await repo.findByKey(tenantA, key);
    expect(found).not.toBeNull();
    expect(found!.tenantId).toBe(tenantA);
    expect(found!.status).toBe('sent');
  });

  it("does not hand tenant B tenant A's row for the same idempotency key", async () => {
    process.env.RLS_RUNTIME_ROLE = 'true';
    const tenantA = await tenant();
    const tenantB = await tenant();
    const key = `${crypto.randomUUID()}:1`;
    await repo.upsert(stateFor(tenantA, key));

    // Before the fix this read ran as the principal with no context and
    // returned A's 'sent' row, which made B's enqueue skip its own notice.
    expect(await repo.findByKey(tenantB, key)).toBeNull();
  });

  it('still filters by tenant when the runtime role is off (the WHERE clause is the backstop)', async () => {
    delete process.env.RLS_RUNTIME_ROLE;
    const tenantA = await tenant();
    const tenantB = await tenant();
    const key = `${crypto.randomUUID()}:1`;
    await repo.upsert(stateFor(tenantA, key));

    expect(await repo.findByKey(tenantB, key)).toBeNull();
    expect((await repo.findByKey(tenantA, key))?.tenantId).toBe(tenantA);
  });
});
