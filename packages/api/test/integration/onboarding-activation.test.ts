/**
 * Docker-gated integration tests — NOT run in web sessions. Requires the
 * testcontainer Postgres started by `npm run test:integration`.
 *
 * Exercises voice/activation.ts (first_real_call_received) against real
 * Postgres: the additive tenant_settings.activated_at column (migration
 * 146), the count-based inbound rule, and the once-per-tenant check-and-set
 * idempotency. PostHog is mocked so nothing leaves the process.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { Pool } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';

const recordFunnelEventMock = vi.fn();
vi.mock('../../src/analytics/posthog', () => ({
  recordFunnelEvent: (...args: unknown[]) => recordFunnelEventMock(...args),
}));

import { maybeFireFirstRealCallActivation } from '../../src/voice/activation';

const stubAudit = { create: vi.fn(async () => undefined) } as never;

interface SeedOpts {
  live?: boolean;
  subscription?: string;
  inboundCalls?: number;
  testCallSkipped?: boolean;
}

async function seedTenant(pool: Pool, opts: SeedOpts = {}): Promise<string> {
  const { tenantId } = await createTestTenant(pool);
  await pool.query(`UPDATE tenants SET subscription_status = $2 WHERE id = $1`, [
    tenantId,
    opts.subscription ?? 'trialing',
  ]);
  await pool.query(
    `INSERT INTO tenant_settings (id, tenant_id, business_name, voice_agent_live_at, onboarding_test_call_skipped_at)
       VALUES (gen_random_uuid(), $1, 'Biz', $2, $3)`,
    [tenantId, opts.live === false ? null : new Date(), opts.testCallSkipped ? new Date() : null],
  );
  const calls = opts.inboundCalls ?? 2;
  for (let i = 0; i < calls; i++) {
    await pool.query(
      `INSERT INTO voice_sessions (tenant_id, channel, state, ended_at)
         VALUES ($1, 'voice_inbound', 'ended', now())`,
      [tenantId],
    );
  }
  return tenantId;
}

describe('Postgres integration — first-real-call activation', () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = await getSharedTestDb();
  });
  afterAll(async () => {
    await closeSharedTestDb();
  });
  beforeEach(() => {
    recordFunnelEventMock.mockClear();
    (stubAudit as unknown as { create: ReturnType<typeof vi.fn> }).create.mockClear();
  });

  it('stamps activated_at and fires the funnel event + email exactly once', async () => {
    const tenantId = await seedTenant(pool);
    const sendEmail = vi.fn(async () => ({}));

    const res = await maybeFireFirstRealCallActivation(
      { pool, auditRepo: stubAudit, sendEmail },
      { tenantId, channel: 'voice_inbound' },
    );

    expect(res).toEqual({ fired: true });
    const { rows } = await pool.query(
      `SELECT activated_at FROM tenant_settings WHERE tenant_id = $1`,
      [tenantId],
    );
    expect(rows[0].activated_at).toBeInstanceOf(Date);
    expect(recordFunnelEventMock).toHaveBeenCalledTimes(1);
    expect(recordFunnelEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'first_real_call_received',
        properties: expect.objectContaining({ tenant_id: tenantId, source: 'server' }),
      }),
    );
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect((stubAudit as unknown as { create: ReturnType<typeof vi.fn> }).create).toHaveBeenCalledTimes(1);
  });

  it('is idempotent on replay — second call no-ops, no duplicate event or email', async () => {
    const tenantId = await seedTenant(pool);
    const sendEmail = vi.fn(async () => ({}));

    const first = await maybeFireFirstRealCallActivation(
      { pool, auditRepo: stubAudit, sendEmail },
      { tenantId, channel: 'voice_inbound' },
    );
    expect(first).toEqual({ fired: true });

    recordFunnelEventMock.mockClear();
    const second = await maybeFireFirstRealCallActivation(
      { pool, auditRepo: stubAudit, sendEmail },
      { tenantId, channel: 'voice_inbound' },
    );
    expect(second).toEqual({ fired: false });
    expect(recordFunnelEventMock).not.toHaveBeenCalled();
    expect(sendEmail).toHaveBeenCalledTimes(1); // only the first call sent
  });

  it('does not activate on the test call alone (inbound #1, test call not skipped)', async () => {
    const tenantId = await seedTenant(pool, { inboundCalls: 1 });
    const res = await maybeFireFirstRealCallActivation(
      { pool, auditRepo: stubAudit },
      { tenantId, channel: 'voice_inbound' },
    );
    expect(res).toEqual({ fired: false });
    const { rows } = await pool.query(
      `SELECT activated_at FROM tenant_settings WHERE tenant_id = $1`,
      [tenantId],
    );
    expect(rows[0].activated_at).toBeNull();
  });

  it('activates on inbound #1 when the test call was skipped', async () => {
    const tenantId = await seedTenant(pool, { inboundCalls: 1, testCallSkipped: true });
    const res = await maybeFireFirstRealCallActivation(
      { pool, auditRepo: stubAudit },
      { tenantId, channel: 'voice_inbound' },
    );
    expect(res).toEqual({ fired: true });
  });

  it('does not activate before the voice agent is live', async () => {
    const tenantId = await seedTenant(pool, { live: false });
    const res = await maybeFireFirstRealCallActivation(
      { pool, auditRepo: stubAudit },
      { tenantId, channel: 'voice_inbound' },
    );
    expect(res).toEqual({ fired: false });
  });

  it('does not activate when the subscription is not live', async () => {
    const tenantId = await seedTenant(pool, { subscription: 'canceled' });
    const res = await maybeFireFirstRealCallActivation(
      { pool, auditRepo: stubAudit },
      { tenantId, channel: 'voice_inbound' },
    );
    expect(res).toEqual({ fired: false });
  });
});
