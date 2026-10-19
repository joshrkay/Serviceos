import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { PgSettingsRepository } from '../../src/settings/pg-settings';
import { PgAuditRepository } from '../../src/audit/pg-audit';
import { OnboardingVoicePolicyExecutionHandler } from '../../src/proposals/execution/onboarding-handlers';
import type { Proposal } from '../../src/proposals/proposal';
import type { ExecutionContext } from '../../src/proposals/execution/handlers';
import { paymentModeLockKey } from '../../src/invoices/payment-collection-mode';
import { PgQueue } from '../../src/queues/pg-queue';

describe('onboarding_voice_policy handler against real tenant_settings', () => {
  let pool: Pool;
  let settingsRepo: PgSettingsRepository;
  let handler: OnboardingVoicePolicyExecutionHandler;
  let tenant: { tenantId: string; userId: string };

  beforeAll(async () => {
    pool = await getSharedTestDb();
    settingsRepo = new PgSettingsRepository(pool);
    handler = new OnboardingVoicePolicyExecutionHandler(settingsRepo, new PgAuditRepository(pool));
  });

  beforeEach(async () => {
    tenant = await createTestTenant(pool);
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  function proposal(payload: Record<string, unknown>): Proposal {
    return { id: crypto.randomUUID(), tenantId: tenant.tenantId, proposalType: 'onboarding_voice_policy', status: 'approved', payload, summary: 'voice policy' } as Proposal;
  }

  it('lands every choice on real columns, including the new payment_collection_mode', async () => {
    const ctx: ExecutionContext = { tenantId: tenant.tenantId, executedBy: tenant.userId, executedByRole: 'owner' };
    const result = await handler.execute(
      proposal({
        voiceGreeting: 'Walsh Plumbing, how can I help?',
        autonomousBookingEnabled: true,
        afterHoursVoiceMode: 'voicemail',
        emergencyTarget: 'owner_cell_then_text',
        paymentCollectionMode: 'pay_link',
        bookingHoursPreset: 'mon_sat_7_5',
      }),
      ctx,
    );
    expect(result.success).toBe(true);

    const row = await pool.query(
      `SELECT voice_greeting, autonomous_booking_enabled, escalation_settings, payment_collection_mode, business_hours
         FROM tenant_settings WHERE tenant_id = $1`,
      [tenant.tenantId],
    );
    expect(row.rows).toHaveLength(1);
    expect(row.rows[0].voice_greeting).toBe('Walsh Plumbing, how can I help?');
    expect(row.rows[0].autonomous_booking_enabled).toBe(true);
    expect(row.rows[0].payment_collection_mode).toBe('pay_link');
    expect(row.rows[0].escalation_settings).toMatchObject({ after_hours_voice_mode: 'voicemail', emergency_target: 'owner_cell_then_text' });
    expect(row.rows[0].business_hours.sat).toEqual({ open: '07:00', close: '17:00' });
    expect(row.rows[0].business_hours.sun).toBeNull();

    const settings = await settingsRepo.findByTenant(tenant.tenantId);
    expect(settings?.paymentCollectionMode).toBe('pay_link');

    const audit = await pool.query(`SELECT event_type FROM audit_events WHERE tenant_id = $1 AND event_type = 'tenant.voice_policy_set'`, [tenant.tenantId]);
    expect(audit.rows).toHaveLength(1);
  });

  // POST /api/onboarding/draft/retry re-approves a proposal whose first run may have
  // written part of its settings before failing, so a second execution must land on
  // the same row, not duplicate or reject.
  it('executes twice onto the same settings (a retry after a partial first run)', async () => {
    const ctx: ExecutionContext = { tenantId: tenant.tenantId, executedBy: tenant.userId, executedByRole: 'owner' };
    const payload = {
      voiceGreeting: 'Walsh Plumbing, how can I help?',
      autonomousBookingEnabled: false,
      afterHoursVoiceMode: 'voicemail',
      emergencyTarget: 'owner_cell_then_text',
      paymentCollectionMode: 'pay_link',
      bookingHoursPreset: 'mon_sat_7_5',
    };
    const read = () =>
      pool.query(
        `SELECT voice_greeting, autonomous_booking_enabled, escalation_settings, payment_collection_mode, business_hours
           FROM tenant_settings WHERE tenant_id = $1`,
        [tenant.tenantId],
      );
    expect((await handler.execute(proposal(payload), ctx)).success).toBe(true);
    const first = (await read()).rows[0];
    expect((await handler.execute(proposal(payload), ctx)).success).toBe(true);
    const second = await read();
    // One row. Everything the first run wrote is unchanged; the second run may only
    // fill escalation defaults the first left unset, and a third run changes nothing.
    expect(second.rows).toHaveLength(1);
    expect(second.rows[0]).toMatchObject({ ...first, escalation_settings: expect.objectContaining(first.escalation_settings) });
    expect((await handler.execute(proposal(payload), ctx)).success).toBe(true);
    expect((await read()).rows[0]).toEqual(second.rows[0]);
  });

  it('rejects an invalid payment_collection_mode at the column', async () => {
    await settingsRepo.update(tenant.tenantId, { paymentCollectionMode: 'pay_link' });
    await expect(
      pool.query(`UPDATE tenant_settings SET payment_collection_mode = 'cash_only' WHERE tenant_id = $1`, [tenant.tenantId]),
    ).rejects.toThrow(/payment_collection_mode/);
  });
});

describe('S5a-4 — the onboarding policy write and the payment-mode lock (real Postgres, statement spy)', () => {
  let pool: Pool;
  let spyPool: Pool;
  const log: Array<{ text: string; values: unknown[] }> = [];
  let tenant: { tenantId: string; userId: string };
  let handler: OnboardingVoicePolicyExecutionHandler;

  beforeAll(async () => {
    pool = await getSharedTestDb();
    // A dedicated pool whose clients record every promise-style statement, so
    // the shared pool is untouched.
    spyPool = new Pool({ connectionString: process.env.TEST_DB_URL, max: 2 });
    spyPool.on('connect', (client: PoolClient) => {
      const original = client.query.bind(client) as (...args: unknown[]) => Promise<unknown>;
      (client as unknown as { query: unknown }).query = (...args: unknown[]) => {
        if (typeof args[args.length - 1] !== 'function') {
          const cfg = args[0];
          log.push({
            text: (typeof cfg === 'string' ? cfg : String((cfg as { text?: string })?.text ?? '')).trim(),
            values: (Array.isArray(args[1]) ? args[1] : []) as unknown[],
          });
        }
        return original(...args);
      };
    });
    handler = new OnboardingVoicePolicyExecutionHandler(new PgSettingsRepository(spyPool), new PgAuditRepository(pool));
  });

  beforeEach(async () => {
    tenant = await createTestTenant(pool);
  });

  afterAll(async () => {
    await spyPool.end();
  });

  const ctx = (): ExecutionContext => ({ tenantId: tenant.tenantId, executedBy: tenant.userId, executedByRole: 'owner' });
  const execute = (payload: Record<string, unknown>) =>
    handler.execute(
      { id: crypto.randomUUID(), tenantId: tenant.tenantId, proposalType: 'onboarding_voice_policy', status: 'approved', payload, summary: 'voice policy' } as Proposal,
      ctx(),
    );
  const updatedAt = async () =>
    (await pool.query<{ updated_at: Date }>('SELECT updated_at FROM tenant_settings WHERE tenant_id = $1', [tenant.tenantId])).rows[0]
      ?.updated_at;

  it('a payment_collection_mode payload takes the exclusive payment-mode lock before touching tenant_settings, and moves updated_at', async () => {
    expect((await execute({ voiceGreeting: 'Hello there' })).success).toBe(true);
    const before = await updatedAt();
    await new Promise((r) => { setTimeout(r, 20); });

    const from = log.length;
    expect((await execute({ paymentCollectionMode: 'collect_on_site' })).success).toBe(true);
    const mine = log.slice(from);
    const iLock = mine.findIndex((s) => /pg_advisory_xact_lock\(hashtext\(\$1\)\)/.test(s.text));
    const iSettings = mine.findIndex((s) => /tenant_settings/.test(s.text));
    expect(iLock).toBeGreaterThanOrEqual(0);
    expect(iLock).toBeLessThan(iSettings);
    expect(mine[iLock].values).toEqual([paymentModeLockKey(tenant.tenantId)]);

    const after = await updatedAt();
    expect(after.getTime()).toBeGreaterThan(before.getTime());
  });

  it('a payload without the key takes no lock and leaves updated_at unchanged', async () => {
    expect((await execute({ paymentCollectionMode: 'pay_link' })).success).toBe(true);
    const before = await updatedAt();
    await new Promise((r) => { setTimeout(r, 20); });

    const from = log.length;
    expect((await execute({ voiceGreeting: 'Walsh Plumbing, how can I help?' })).success).toBe(true);
    expect(log.slice(from).some((s) => /pg_advisory/.test(s.text))).toBe(false);
    expect((await updatedAt()).getTime()).toBe(before.getTime());
  });
});

describe('S5a-5 — approving "Collect on the spot" commits the pay-link cleanup job with the settings row (real Postgres)', () => {
  let pool: Pool;
  let queue: PgQueue;

  beforeAll(async () => {
    pool = await getSharedTestDb();
    queue = new PgQueue(pool);
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM _queue_messages WHERE type = 'deactivate_payment_links'`);
    await closeSharedTestDb();
  });

  async function jobs(tenantId: string) {
    const { rows } = await pool.query<{ payload: { tenantId: string; pass: number }; idempotency_key: string }>(
      `SELECT payload, idempotency_key FROM _queue_messages
        WHERE type = 'deactivate_payment_links' AND payload->>'tenantId' = $1`,
      [tenantId],
    );
    return rows;
  }

  it('collect_on_site over pay_link leaves exactly one deactivate_payment_links row keyed by the committed updated_at; re-approving the same choice adds none', async () => {
    const tenant = await createTestTenant(pool);
    const handler = new OnboardingVoicePolicyExecutionHandler(new PgSettingsRepository(pool), new PgAuditRepository(pool), queue);
    const execute = (payload: Record<string, unknown>) =>
      handler.execute(
        { id: crypto.randomUUID(), tenantId: tenant.tenantId, proposalType: 'onboarding_voice_policy', status: 'approved', payload, summary: 'voice policy' } as unknown as Proposal,
        { tenantId: tenant.tenantId, executedBy: tenant.userId, executedByRole: 'owner' },
      );

    expect((await execute({ paymentCollectionMode: 'pay_link' })).success).toBe(true);
    expect(await jobs(tenant.tenantId)).toEqual([]);

    expect((await execute({ paymentCollectionMode: 'collect_on_site' })).success).toBe(true);
    const { rows } = await pool.query<{ payment_collection_mode: string; updated_at: Date }>(
      'SELECT payment_collection_mode, updated_at FROM tenant_settings WHERE tenant_id = $1',
      [tenant.tenantId],
    );
    expect(rows[0].payment_collection_mode).toBe('collect_on_site');
    expect(await jobs(tenant.tenantId)).toEqual([
      {
        payload: { tenantId: tenant.tenantId, pass: 1 },
        idempotency_key: `deactivate-payment-links:${tenant.tenantId}:${rows[0].updated_at.toISOString()}`,
      },
    ]);

    expect((await execute({ paymentCollectionMode: 'collect_on_site' })).success).toBe(true);
    expect(await jobs(tenant.tenantId)).toHaveLength(1);
  });
});
