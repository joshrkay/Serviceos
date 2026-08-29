import { describe, it, expect, beforeEach } from 'vitest';
import express, { Request, Response, NextFunction } from 'express';
import request from 'supertest';
import { createSettingsRouter } from '../../src/routes/settings';
import { AuthenticatedRequest } from '../../src/auth/clerk';
import {
  InMemorySettingsRepository,
  createSettings,
  getSettings,
} from '../../src/settings/settings';

// #880 — businessPhone is what public intake/booking pages display and
// tel:-link for customers, yet it was the ONLY phone field on the settings
// PUT with no normalization or validation: an operator could type a Twilio
// magic test number (+1 500 555 0006) and it went straight to public pages.
// These tests pin the same route-boundary treatment ownerPhone and
// transferNumber already get (normalize to E.164, '' clears, reject junk)
// plus the magic-number rejection.
describe('PUT /api/settings — businessPhone normalization (#880)', () => {
  const tenantId = 'tenant-business-phone';
  let app: express.Express;
  let settingsRepo: InMemorySettingsRepository;

  beforeEach(async () => {
    app = express();
    app.use(express.json());
    app.use((req: Request, _res: Response, next: NextFunction) => {
      (req as AuthenticatedRequest).auth = {
        userId: 'user-1',
        sessionId: 'session-1',
        tenantId,
        role: 'owner',
      };
      next();
    });

    settingsRepo = new InMemorySettingsRepository();
    await createSettings({ tenantId, businessName: 'Phone Test Co' }, settingsRepo);
    app.use('/api/settings', createSettingsRouter(settingsRepo));
  });

  it('normalizes a human-formatted number to E.164 before persisting', async () => {
    const res = await request(app)
      .put('/api/settings')
      .send({ businessPhone: '(512) 555-0100' });

    expect(res.status).toBe(200);
    expect(res.body.businessPhone).toBe('+15125550100');
    const stored = await getSettings(tenantId, settingsRepo);
    expect(stored?.businessPhone).toBe('+15125550100');
  });

  it('clears the business phone when an empty string is sent', async () => {
    await request(app).put('/api/settings').send({ businessPhone: '+15125550100' });
    const res = await request(app).put('/api/settings').send({ businessPhone: '   ' });

    expect(res.status).toBe(200);
    const stored = await getSettings(tenantId, settingsRepo);
    expect(stored?.businessPhone ?? null).toBeNull();
  });

  it('rejects a non-number with VALIDATION_ERROR on the businessPhone field', async () => {
    const res = await request(app)
      .put('/api/settings')
      .send({ businessPhone: 'call the office' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION_ERROR');
    expect(res.body.details.field).toBe('businessPhone');
    const stored = await getSettings(tenantId, settingsRepo);
    expect(stored?.businessPhone ?? null).toBeNull();
  });

  it('rejects a Twilio magic test number (never a dialable line)', async () => {
    const res = await request(app)
      .put('/api/settings')
      .send({ businessPhone: '+15005550006' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION_ERROR');
    expect(res.body.details.field).toBe('businessPhone');
    expect(res.body.message).toMatch(/test number/i);
    const stored = await getSettings(tenantId, settingsRepo);
    expect(stored?.businessPhone ?? null).toBeNull();
  });

  it('rejects a magic test number even in human formatting (normalized first)', async () => {
    const res = await request(app)
      .put('/api/settings')
      .send({ businessPhone: '(500) 555-0006' });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/test number/i);
  });
});
