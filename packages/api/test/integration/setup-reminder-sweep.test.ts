/**
 * Docker-gated integration test for the setup-reminder sweep.
 *
 * The reason this exists: the sweep loads each candidate's onboarding facts via
 * loadOnboardingFacts, whose reads run on the raw pool with NO tenant GUC from a
 * background context, against FORCE-RLS tables (tenant_settings, etc.). The unit
 * test mocks loadOnboardingFacts, so it can't prove those cross-tenant reads
 * actually return rows. The "suppress a fully-complete tenant" assertion below
 * is the one that fails if the reads are silently RLS-filtered to empty — the
 * tenant would look incomplete and the sweep would wrongly send. (CLAUDE.md:
 * mocked-DB tests are never the only proof a query works.)
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { PgSettingsRepository } from '../../src/settings/pg-settings';
import { InMemoryDeliveryProvider } from '../../src/notifications/delivery-provider';
import { createLogger } from '../../src/logging/logger';
import { runSetupReminderSweep } from '../../src/workers/setup-reminder-sweep';

const logger = createLogger({ service: 'test', environment: 'test', level: 'error' });

async function seedCompleteOnboarding(pool: Pool, tenantId: string): Promise<void> {
  await pool.query(
    `INSERT INTO tenant_settings (id, tenant_id, business_name, business_hours, job_buffer_minutes, hourly_rate_cents, terminology_preferences, ai_model, ai_verification_status, timezone, estimate_prefix, invoice_prefix, next_estimate_number, next_invoice_number, default_payment_term_days)
     VALUES (gen_random_uuid(), $1, 'Acme', $2::jsonb, 30, 12500, $3::jsonb, 'gpt-4o-mini', 'passed', 'America/New_York', 'EST', 'INV', 1, 1, 30)`,
    [tenantId, JSON.stringify({ mon: null }), JSON.stringify({ _activeVerticalPacks: ['hvac'] })],
  );
  await pool.query(
    `INSERT INTO tenant_integrations (id, tenant_id, provider, status) VALUES (gen_random_uuid(), $1, 'twilio', 'full_readiness')`,
    [tenantId],
  );
  await pool.query(
    `UPDATE tenants SET stripe_subscription_id='sub_test_1', subscription_status='trialing' WHERE id=$1`,
    [tenantId],
  );
  await pool.query(
    `INSERT INTO voice_sessions (id, tenant_id, channel, state, started_at, ended_at) VALUES (gen_random_uuid(), $1, 'voice_inbound', 'ended', now() - interval '1 minute', now())`,
    [tenantId],
  );
}

describe('runSetupReminderSweep (integration)', () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = await getSharedTestDb();
  });
  afterAll(async () => {
    await closeSharedTestDb();
  });

  it('emails an incomplete tenant and suppresses a complete one (cross-tenant RLS reads)', async () => {
    const incomplete = await createTestTenant(pool); // no tenant_settings → incomplete
    const complete = await createTestTenant(pool);
    await seedCompleteOnboarding(pool, complete.tenantId);

    // Distinct owner emails so we can assert per-tenant without relying on the
    // shared DB being empty of other tenants.
    const incompleteEmail = `incomplete-${incomplete.tenantId}@test.dev`;
    const completeEmail = `complete-${complete.tenantId}@test.dev`;
    await pool.query(`UPDATE tenants SET owner_email=$1 WHERE id=$2`, [incompleteEmail, incomplete.tenantId]);
    await pool.query(`UPDATE tenants SET owner_email=$1 WHERE id=$2`, [completeEmail, complete.tenantId]);

    const delivery = new InMemoryDeliveryProvider();
    await runSetupReminderSweep({
      pool,
      settingsRepo: new PgSettingsRepository(pool),
      delivery,
      appBaseUrl: 'https://app.rivet.ai',
      supportEmail: 'support@rivet.ai',
      logger,
      minAgeHours: 0, // tenants were just created
    });

    const sentTo = delivery.sentEmails.map((e) => e.to);
    // Incomplete tenant got the reminder...
    expect(sentTo).toContain(incompleteEmail);
    // ...and the complete tenant did NOT (this fails if loadOnboardingFacts'
    // RLS reads came back empty and made it look incomplete).
    expect(sentTo).not.toContain(completeEmail);

    // Both end up with a ledger row (one sent, one suppressed) so neither is
    // re-evaluated next tick.
    const { rows } = await pool.query<{ tenant_id: string }>(
      `SELECT tenant_id FROM lifecycle_emails WHERE kind='setup_reminder' AND tenant_id = ANY($1)`,
      [[incomplete.tenantId, complete.tenantId]],
    );
    expect(rows.map((r) => r.tenant_id).sort()).toEqual(
      [incomplete.tenantId, complete.tenantId].sort(),
    );
  });
});
