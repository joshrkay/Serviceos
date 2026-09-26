/**
 * readTenantBillingState — the one read of a tenant's billing snapshot
 * (subscription status, Rivet plan, mirrored Stripe period, owner) shared by
 * the voice gate, usage summary, usage alerts, plan features and the nudge.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { randomUUID } from 'crypto';

import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { readTenantBillingState } from '../../src/billing/tenant-billing-state';

describe('Postgres integration — tenant billing state', () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = await getSharedTestDb();
  }, 120_000);

  afterAll(async () => {
    await closeSharedTestDb();
  });

  it("returns the tenant's status, plan, period and owner", async () => {
    const { tenantId, userId } = await createTestTenant(pool);
    const start = new Date(Date.UTC(2026, 9, 1));
    const end = new Date(Date.UTC(2026, 10, 1));
    await pool.query(
      `UPDATE tenants SET subscription_status = 'active', plan_id = 'growth', owner_email = 'owner@shop.test',
              current_period_start = $2, current_period_end = $3 WHERE id = $1`,
      [tenantId, start, end],
    );

    expect(await readTenantBillingState(pool, tenantId)).toEqual({
      status: 'active',
      planId: 'growth',
      period: { start, end },
      ownerId: userId,
      ownerEmail: 'owner@shop.test',
    });
  });

  it('has no period or plan before checkout, and is null for an unknown tenant', async () => {
    const { tenantId } = await createTestTenant(pool);
    expect(await readTenantBillingState(pool, tenantId)).toMatchObject({
      status: null,
      planId: null,
      period: null,
    });
    expect(await readTenantBillingState(pool, randomUUID())).toBeNull();
  });
});
