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
// tel:-link for customers: an operator could type a Twilio magic test
// number (+1 500 555 0006) and it went straight to public pages. These
// tests pin the route-boundary policy: reject magic numbers, '' clears —
// and, unlike ownerPhone/transferNumber, store everything else AS TYPED.
// businessPhone is a display field that may legitimately be international
// or carry an extension; the NANP-only normalizeMobileE164 would 400
// numbers that were previously savable (beyond #880's scope).
describe('PUT /api/settings — businessPhone policy (#880)', () => {
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

  it('stores a human-formatted number as typed (no NANP rewrite)', async () => {
    const res = await request(app)
      .put('/api/settings')
      .send({ businessPhone: '(512) 555-0100' });

    expect(res.status).toBe(200);
    expect(res.body.businessPhone).toBe('(512) 555-0100');
    const stored = await getSettings(tenantId, settingsRepo);
    expect(stored?.businessPhone).toBe('(512) 555-0100');
  });

  it('accepts international and extension numbers that E.164-only validation would reject', async () => {
    for (const businessPhone of ['+44 20 7946 0958', '512-555-0100 ext. 4']) {
      const res = await request(app).put('/api/settings').send({ businessPhone });
      expect(res.status).toBe(200);
      const stored = await getSettings(tenantId, settingsRepo);
      expect(stored?.businessPhone).toBe(businessPhone);
    }
  });

  it('clears the business phone when an empty string is sent', async () => {
    await request(app).put('/api/settings').send({ businessPhone: '+15125550100' });
    const res = await request(app).put('/api/settings').send({ businessPhone: '   ' });

    expect(res.status).toBe(200);
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
