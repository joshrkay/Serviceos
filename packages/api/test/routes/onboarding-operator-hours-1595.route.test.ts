/**
 * #1595 / D-039 — GET /api/onboarding/operator-hours reports the after-hours
 * mode the phone will actually use. The route used to fall back to a
 * hardcoded 'voicemail' for a tenant with no escalation blob, which after the
 * default flip would have told the owner "voicemail" while the AI answered.
 */
import request from 'supertest';
import express, { Request, Response, NextFunction } from 'express';
import { describe, it, expect, vi } from 'vitest';
import type { Pool } from 'pg';
import { createOnboardingRouter } from '../../src/routes/onboarding';
import { InMemorySettingsRepository, type TenantSettings } from '../../src/settings/settings';
import { InMemoryPackActivationRepository } from '../../src/settings/pack-activation';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import type { AuthenticatedRequest } from '../../src/auth/clerk';

const TENANT_ID = 'tenant-1595';
const USER_ID = 'user-1595';
const BUSINESS_HOURS = { mon: { open: '09:00', close: '17:00' } };

function settingsRow(escalationSettings?: TenantSettings['escalationSettings']): TenantSettings {
  const now = new Date();
  return {
    id: 'settings-1595',
    tenantId: TENANT_ID,
    businessName: 'Acme Plumbing',
    timezone: 'America/Phoenix',
    estimatePrefix: 'EST',
    invoicePrefix: 'INV',
    nextEstimateNumber: 1,
    nextInvoiceNumber: 1,
    defaultPaymentTermDays: 30,
    createdAt: now,
    updatedAt: now,
    ...(escalationSettings ? { escalationSettings } : {}),
  };
}

async function buildApp(escalationSettings?: TenantSettings['escalationSettings']) {
  const settingsRepo = new InMemorySettingsRepository();
  await settingsRepo.create(settingsRow(escalationSettings));
  const pool = {
    query: vi.fn(async () => ({ rows: [{ business_hours: BUSINESS_HOURS }] })),
  } as unknown as Pool;

  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as AuthenticatedRequest).auth = {
      userId: USER_ID,
      sessionId: 'session-1595',
      tenantId: TENANT_ID,
      role: 'owner',
    };
    next();
  });
  app.use(
    '/api/onboarding',
    createOnboardingRouter({
      settingsRepo,
      packActivationRepo: new InMemoryPackActivationRepository(),
      auditRepo: new InMemoryAuditRepository(),
      pool,
    }),
  );
  return app;
}

describe('#1595 — GET /api/onboarding/operator-hours afterHoursVoiceMode', () => {
  it('reports ai_answering for a tenant that never set the after-hours mode', async () => {
    const app = await buildApp();

    const res = await request(app).get('/api/onboarding/operator-hours');

    expect(res.status).toBe(200);
    expect(res.body.businessHours).toEqual(BUSINESS_HOURS);
    expect(res.body.afterHoursVoiceMode).toBe('ai_answering');
  });

  it("keeps reporting voicemail for a tenant who explicitly chose it", async () => {
    const app = await buildApp({ after_hours_voice_mode: 'voicemail' } as never);

    const res = await request(app).get('/api/onboarding/operator-hours');

    expect(res.status).toBe(200);
    expect(res.body.afterHoursVoiceMode).toBe('voicemail');
  });
});
