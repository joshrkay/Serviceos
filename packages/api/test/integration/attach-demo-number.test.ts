/**
 * The SQL behind scripts/attach-demo-number.ts, at REAL Postgres (a mocked
 * Pool is never the only proof a query works): the demo-tenant read, the
 * subaccount save, and the number record — and that what it records is
 * exactly what inbound routing reads (`PgPhoneNumberRepository.findByNumber`,
 * `tenant_integrations.provider_data->>'phoneE164'`).
 *
 * Also pins the demo inbound caps' counters on the platform tenant: the
 * per-caller and daily-total limits are real `phone_rate_limits` rows under
 * the platform tenant's RLS, and a demo tenant's reset (which empties every
 * tenant-owned table) cannot clear them.
 *
 * Run (Docker-gated):
 *   cd packages/api && RLS_RUNTIME_ROLE=true npx vitest run \
 *     --config vitest.integration.config.mts \
 *     test/integration/attach-demo-number.test.ts
 */
import { describe, it, expect, beforeAll } from 'vitest';
import crypto from 'node:crypto';
import type { Pool } from 'pg';
import { getSharedTestDb, createTestTenant } from './shared';
import { createPoolSlotTenant } from './demo-pool-tenant';
import { createPgAttachStore } from '../../scripts/attach-demo-number';
import { PgPhoneNumberRepository } from '../../src/integrations/twilio/phone-number-repository';
import { PhoneRateLimiter } from '../../src/shared/rate-limit/phone-rate-limit';
import { createDemoInboundGuard } from '../../src/demo/inbound-limits';
import { loadDemoInboundConfig } from '../../src/demo/config';
import { createHiddenTenantCheck } from '../../src/demo/hidden-tenant';
import { DEMO_PLATFORM_TENANT_ID } from '../../src/demo/platform-tenant';

const RUN = crypto.randomInt(100000, 999999);
const DID = `+1602${RUN}`.slice(0, 12);

describe('attach-demo-number store at real Postgres', () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = await getSharedTestDb();
  });

  it('reads a demo pool tenant as demo, and a real tenant as not demo', async () => {
    const store = createPgAttachStore(pool);
    const demo = await createPoolSlotTenant(pool, { trade: 'plumbing' });
    const real = await createTestTenant(pool);

    expect(await store.getTenant(demo.tenantId)).toMatchObject({ id: demo.tenantId, demo: true, platform: false });
    expect(await store.getTenant(real.tenantId)).toMatchObject({ id: real.tenantId, demo: false, platform: false });
    expect(await store.getTenant(DEMO_PLATFORM_TENANT_ID)).toMatchObject({ platform: true });
    expect(await store.getTenant(crypto.randomUUID())).toBeNull();
  });

  it('saves the subaccount, records the number, and inbound routing then resolves the DID to the tenant', async () => {
    const store = createPgAttachStore(pool);
    const { tenantId } = await createPoolSlotTenant(pool, { trade: 'plumbing' });
    expect(await store.getTwilioIntegration(tenantId)).toBeNull();

    await store.saveSubaccount(tenantId, { subaccountSid: `AC${RUN}aaaaaaaaaaaaaaaaaaaaaaaaaaaa`, authTokenEnc: 'enc:tok' });
    expect(await store.getTwilioIntegration(tenantId)).toMatchObject({
      status: 't0_requested',
      subaccountSid: `AC${RUN}aaaaaaaaaaaaaaaaaaaaaaaaaaaa`,
      authTokenEnc: 'enc:tok',
      phoneNumberSid: null,
      phoneE164: null,
    });

    await store.recordNumber(tenantId, { phoneNumberSid: `PN${RUN}`, phoneE164: DID });

    expect(await store.getTwilioIntegration(tenantId)).toMatchObject({
      status: 'full_readiness',
      phoneNumberSid: `PN${RUN}`,
      phoneE164: DID,
    });
    expect(await new PgPhoneNumberRepository(pool).findByNumber(DID)).toEqual({ tenantId });
  });

  it('is safe to record twice (a re-run after a crash) and keeps the subaccount credential', async () => {
    const store = createPgAttachStore(pool);
    const { tenantId } = await createPoolSlotTenant(pool, { trade: 'plumbing' });
    await store.saveSubaccount(tenantId, { subaccountSid: `AC${RUN}bbbbbbbbbbbbbbbbbbbbbbbbbbbb`, authTokenEnc: 'enc:tok2' });
    const did = `+1480${RUN}`.slice(0, 12);

    await store.recordNumber(tenantId, { phoneNumberSid: `PN${RUN}b`, phoneE164: did });
    await store.recordNumber(tenantId, { phoneNumberSid: `PN${RUN}b`, phoneE164: did });

    expect(await store.getTwilioIntegration(tenantId)).toMatchObject({
      status: 'full_readiness',
      authTokenEnc: 'enc:tok2',
      phoneE164: did,
    });
  });
});

describe('demo inbound caps at real Postgres', () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = await getSharedTestDb();
  });

  it('counts per caller and in total on the platform tenant, and refuses past the limits', async () => {
    const demo = await createPoolSlotTenant(pool, { trade: 'plumbing' });
    const guard = createDemoInboundGuard({
      config: loadDemoInboundConfig({ DEMO_INBOUND_PER_CALLER_DAILY: '2', DEMO_INBOUND_DAILY_TOTAL: '1000' }),
      isDemoTenant: createHiddenTenantCheck(pool),
      limiter: new PhoneRateLimiter(pool),
      phoneKeySecret: `secret-${RUN}`,
    });
    const caller = `+1555${RUN}1`;

    expect(await guard.check({ tenantId: demo.tenantId, from: caller })).toMatchObject({ allowed: true });
    expect(await guard.check({ tenantId: demo.tenantId, from: caller })).toMatchObject({ allowed: true });
    expect(await guard.check({ tenantId: demo.tenantId, from: caller })).toEqual({
      demo: true,
      allowed: false,
      reason: 'caller_limit',
    });
    // A different caller is unaffected.
    expect(await guard.check({ tenantId: demo.tenantId, from: `+1555${RUN}2` })).toMatchObject({ allowed: true });

    // The rows live on the platform tenant, keyed by a hash — never the number.
    const { rows } = await pool.query<{ key: string; tenant_id: string }>(
      `SELECT key, tenant_id FROM phone_rate_limits WHERE scope = 'demo_inbound_caller' AND tenant_id = $1`,
      [DEMO_PLATFORM_TENANT_ID],
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.some((r) => r.key.includes(String(RUN)))).toBe(false);
  });

  it('a real tenant is never counted', async () => {
    const real = await createTestTenant(pool);
    const guard = createDemoInboundGuard({
      config: loadDemoInboundConfig({ DEMO_INBOUND_PER_CALLER_DAILY: '1' }),
      isDemoTenant: createHiddenTenantCheck(pool),
      limiter: new PhoneRateLimiter(pool),
      phoneKeySecret: `secret-${RUN}`,
    });
    const caller = `+1555${RUN}3`;
    for (let i = 0; i < 3; i++) {
      expect(await guard.check({ tenantId: real.tenantId, from: caller })).toEqual({ demo: false });
    }
  });
});
