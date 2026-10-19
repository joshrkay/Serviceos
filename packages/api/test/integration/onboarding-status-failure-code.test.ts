/**
 * Docker-gated integration test (real Postgres, under the RLS runtime role
 * when RLS_RUNTIME_ROLE=true): the phone step's failure code on
 * GET /api/onboarding/status, from real `tenant_integrations` rows holding
 * each text the provisioning worker records (built by the same builders the
 * worker uses). Pins the real columns load-facts reads (`status`,
 * `last_error`, `provider_data`) and that the recorded text itself never
 * reaches the response body.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import express, { Request, Response, NextFunction } from 'express';
import request from 'supertest';
import { Pool } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { createOnboardingRouter } from '../../src/routes/onboarding';
import { PgSettingsRepository } from '../../src/settings/pg-settings';
import { PgPackActivationRepository } from '../../src/settings/pg-pack-activation';
import { PgAuditRepository } from '../../src/audit/pg-audit';
import { withTenantTransaction } from '../../src/middleware/tenant-context';
import { PROVISIONING_FAILURE_MESSAGES as M } from '../../src/onboarding/provisioning-failure';
import type { AuthenticatedRequest } from '../../src/auth/clerk';

describe('GET /api/onboarding/status — the phone step failure code (real tenant_integrations rows)', () => {
  let pool: Pool;
  let app: express.Express;
  let tenant: { tenantId: string; userId: string };

  beforeAll(async () => {
    pool = await getSharedTestDb();
    app = express();
    app.use(express.json());
    app.use((req: Request, _res: Response, next: NextFunction) => {
      (req as AuthenticatedRequest).auth = { userId: tenant.userId, sessionId: 's', tenantId: tenant.tenantId, role: 'owner' };
      next();
    });
    app.use('/api', withTenantTransaction(pool));
    app.use(
      '/api/onboarding',
      createOnboardingRouter({
        settingsRepo: new PgSettingsRepository(pool),
        packActivationRepo: new PgPackActivationRepository(pool),
        auditRepo: new PgAuditRepository(pool),
        pool,
      }),
    );
  });

  beforeEach(async () => {
    tenant = await createTestTenant(pool);
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  /** A DID of this test's own: uq_tenant_integrations_twilio_phone_e164 allows one tenant per number. */
  const ownNumber = () => `+1216${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`;

  /** Identity, pack and billing done, so the phone step is the current one (and carries its metadata). */
  async function upToPhone() {
    await pool.query(
      `INSERT INTO tenant_settings (id, tenant_id, business_name, business_hours, job_buffer_minutes, hourly_rate_cents, terminology_preferences, timezone, estimate_prefix, invoice_prefix, next_estimate_number, next_invoice_number, default_payment_term_days)
       VALUES (gen_random_uuid(), $1, 'Acme', $2::jsonb, 30, 12500, $3::jsonb, 'America/New_York', 'EST', 'INV', 1, 1, 30)`,
      [tenant.tenantId, JSON.stringify({ mon: null }), JSON.stringify({ _activeVerticalPacks: ['hvac'] })],
    );
    await pool.query(`UPDATE tenants SET stripe_subscription_id = 'sub_test_s5b1', subscription_status = 'trialing' WHERE id = $1`, [tenant.tenantId]);
  }

  async function twilioRow(status: string, lastError: string | null, providerData: Record<string, unknown> = {}) {
    await pool.query(
      `INSERT INTO tenant_integrations (tenant_id, provider, status, last_error, provider_data)
       VALUES ($1, 'twilio', $2, $3, $4::jsonb)`,
      [tenant.tenantId, status, lastError, JSON.stringify(providerData)],
    );
  }

  async function phoneStep() {
    const res = await request(app).get('/api/onboarding/status');
    expect(res.status).toBe(200);
    expect(res.body.steps).toHaveLength(7);
    return { body: JSON.stringify(res.body), phone: res.body.steps.find((s: { id: string }) => s.id === 'phone') };
  }

  it.each([
    ['the unavailable-number text', 'area_code_unavailable', M.selectedNumberUnavailable('+12165550123'), ['area_code_unavailable', 'twilio_provisioning_failed']],
    ['the no-inventory text', 'area_code_unavailable', M.noInventory('OH'), ['area_code_unavailable', 'twilio_provisioning_failed']],
    ['the test-credentials text', 'credentials_missing', M.testCredentials('+15005550006'), ['twilio_credentials_missing', 'twilio_provisioning_failed']],
    ['an unset-credentials text', 'credentials_missing', M.twilioCredentialsUnset(), ['twilio_credentials_missing', 'twilio_provisioning_failed']],
    [
      'a Twilio 5xx text',
      'provider_error',
      M.twilioHttp('POST', 'https://api.twilio.com/2010-04-01/Accounts/ACsub/IncomingPhoneNumbers.json', 503, '{"message":"down"}'),
      ['twilio_provider_error', 'twilio_provisioning_failed'],
    ],
    ['a network text', 'provider_error', 'fetch failed', ['twilio_provider_error', 'twilio_provisioning_failed']],
    ['the tenant-conflict text', 'unknown', M.didAlreadyClaimedReleased('+12165550123'), ['twilio_provisioning_failed']],
    ['an unfamiliar text', 'unknown', 'Something odd happened at 3am', ['twilio_provisioning_failed']],
  ] as const)('a failed row with %s → %s', async (_label, failureCode, lastError, blockers) => {
    const phoneE164 = ownNumber();
    await twilioRow('failed', lastError, { phoneE164 });
    const { body, phone } = await phoneStep();
    expect(phone).toEqual({
      id: 'phone',
      status: 'error',
      failureCode,
      blockers,
      metadata: { phoneNumber: phoneE164, lineState: 'failed' },
    });
    // The status carries the code, never the recorded text.
    expect(body).not.toContain(lastError);
  });

  it('a failed row with a NULL last_error → unknown', async () => {
    await twilioRow('failed', null);
    const { phone } = await phoneStep();
    expect(phone).toEqual({ id: 'phone', status: 'error', failureCode: 'unknown', blockers: ['twilio_provisioning_failed'], metadata: { lineState: 'failed' } });
  });

  it('a row that did not fail carries no failureCode, even with a stale last_error, and keeps its metadata', async () => {
    const stale = M.selectedNumberUnavailable('+12165550123');
    await upToPhone();
    await twilioRow('t0_requested', stale, { pendingPick: '+12165550199' });
    const { body, phone } = await phoneStep();
    expect(phone.status).toBe('current');
    expect(phone).not.toHaveProperty('failureCode');
    expect(phone).not.toHaveProperty('blockers');
    expect(phone.metadata).toEqual({ lineState: 'claiming', pendingNumber: '+12165550199' });
    expect(body).not.toContain(stale);
  });

  it('a tenant with no twilio row has no failureCode', async () => {
    const { phone } = await phoneStep();
    expect(phone).not.toHaveProperty('failureCode');
  });
});
