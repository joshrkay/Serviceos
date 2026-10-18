import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { Pool } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { PgSettingsRepository } from '../../src/settings/pg-settings';
import { PgAuditRepository } from '../../src/audit/pg-audit';
import { OnboardingVoicePolicyExecutionHandler } from '../../src/proposals/execution/onboarding-handlers';
import type { Proposal } from '../../src/proposals/proposal';
import type { ExecutionContext } from '../../src/proposals/execution/handlers';

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

  it('rejects an invalid payment_collection_mode at the column', async () => {
    await settingsRepo.update(tenant.tenantId, { paymentCollectionMode: 'pay_link' });
    await expect(
      pool.query(`UPDATE tenant_settings SET payment_collection_mode = 'cash_only' WHERE tenant_id = $1`, [tenant.tenantId]),
    ).rejects.toThrow(/payment_collection_mode/);
  });
});
