import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import express, { Request, Response, NextFunction } from 'express';
import request from 'supertest';
import { Pool } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { createOnboardingRouter } from '../../src/routes/onboarding';
import { PgSettingsRepository } from '../../src/settings/pg-settings';
import { PgPackActivationRepository } from '../../src/settings/pg-pack-activation';
import { PgAuditRepository } from '../../src/audit/pg-audit';
import type { AuthenticatedRequest } from '../../src/auth/clerk';

describe('GET /api/onboarding/status', () => {
  let pool: Pool;
  let app: express.Express;
  let currentTenant: { tenantId: string; userId: string };

  beforeAll(async () => {
    pool = await getSharedTestDb();
    const settingsRepo = new PgSettingsRepository(pool);
    const packActivationRepo = new PgPackActivationRepository(pool);
    const auditRepo = new PgAuditRepository(pool);

    app = express();
    app.use(express.json());
    app.use((req: Request, _res: Response, next: NextFunction) => {
      (req as AuthenticatedRequest).auth = {
        userId: currentTenant.userId,
        sessionId: 'sess-test',
        tenantId: currentTenant.tenantId,
        role: 'owner',
      };
      next();
    });
    app.use('/api/onboarding', createOnboardingRouter({ settingsRepo, packActivationRepo, auditRepo, pool }));
  });

  beforeEach(async () => {
    currentTenant = await createTestTenant(pool);
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  it('returns identity as current step for a fresh tenant (no settings row)', async () => {
    const res = await request(app).get('/api/onboarding/status');
    expect(res.status).toBe(200);
    expect(res.body.steps).toHaveLength(7);
    expect(res.body.currentStep).toBe('identity');
    expect(res.body.isComplete).toBe(false);
  });

  it('marks identity done when all four fields present', async () => {
    await pool.query(
      `INSERT INTO tenant_settings (id, tenant_id, business_name, business_hours, job_buffer_minutes, hourly_rate_cents, timezone, estimate_prefix, invoice_prefix, next_estimate_number, next_invoice_number, default_payment_term_days)
       VALUES (gen_random_uuid(), $1, 'Acme', $2::jsonb, 30, 12500, 'America/New_York', 'EST', 'INV', 1, 1, 30)`,
      [currentTenant.tenantId, JSON.stringify({ mon: null })]
    );
    const res = await request(app).get('/api/onboarding/status');
    const identityStep = res.body.steps.find((s: { id: string }) => s.id === 'identity');
    expect(identityStep.status).toBe('done');
    expect(res.body.currentStep).toBe('pack');
  });

  it('isComplete=true when all 7 steps satisfied', async () => {
    // Identity + pack (via terminology_preferences._activeVerticalPacks) +
    // ai_check passed (ai_model + ai_verification_status).
    await pool.query(
      `INSERT INTO tenant_settings (id, tenant_id, business_name, business_hours, job_buffer_minutes, hourly_rate_cents, terminology_preferences, ai_model, ai_verification_status, timezone, estimate_prefix, invoice_prefix, next_estimate_number, next_invoice_number, default_payment_term_days)
       VALUES (gen_random_uuid(), $1, 'Acme', $2::jsonb, 30, 12500, $3::jsonb, 'gpt-4o-mini', 'passed', 'America/New_York', 'EST', 'INV', 1, 1, 30)`,
      [currentTenant.tenantId, JSON.stringify({ mon: null }), JSON.stringify({ _activeVerticalPacks: ['hvac'] })]
    );
    // Phone integration
    await pool.query(
      `INSERT INTO tenant_integrations (id, tenant_id, provider, status) VALUES (gen_random_uuid(), $1, 'twilio', 'full_readiness')`,
      [currentTenant.tenantId]
    );
    // Subscription
    await pool.query(
      `UPDATE tenants SET stripe_subscription_id='sub_test_1', subscription_status='trialing' WHERE id=$1`,
      [currentTenant.tenantId]
    );
    // Inbound call recorded
    await pool.query(
      `INSERT INTO voice_sessions (id, tenant_id, channel, state, started_at, ended_at) VALUES (gen_random_uuid(), $1, 'voice_inbound', 'ended', now() - interval '1 minute', now())`,
      [currentTenant.tenantId]
    );
    const res = await request(app).get('/api/onboarding/status');
    expect(res.body.isComplete).toBe(true);
    expect(res.body.currentStep).toBeNull();
    expect(res.body.steps.every((s: { status: string }) => s.status === 'done')).toBe(true);
  });
});
