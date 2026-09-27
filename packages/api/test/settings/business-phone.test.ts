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
// number (+1 500 555 0006) and it went straight to public pages.
// #1397 — businessPhone is also DIALED (telephony/dispatcher-phone-resolver
// escalation fallback), so storing it as typed ("(602) 555-0142") broke the
// dial path. It is now normalised to E.164 at the route boundary like
// ownerPhone: NANP numbers → +1XXXXXXXXXX, international numbers written
// with a leading '+' → '+' and digits; anything un-normalisable (extensions,
// letters, wrong length) is a 400 naming the field.
describe('PUT /api/settings — businessPhone policy (#880, #1397)', () => {
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

  it('normalises a human-formatted NANP number to E.164 (#1397)', async () => {
    const res = await request(app)
      .put('/api/settings')
      .send({ businessPhone: '(602) 555-0142' });

    expect(res.status).toBe(200);
    expect(res.body.businessPhone).toBe('+16025550142');
    const stored = await getSettings(tenantId, settingsRepo);
    expect(stored?.businessPhone).toBe('+16025550142');
  });

  it('normalises an international number written with a leading + to E.164 (#1397)', async () => {
    const res = await request(app)
      .put('/api/settings')
      .send({ businessPhone: '+44 20 7946 0958' });

    expect(res.status).toBe(200);
    const stored = await getSettings(tenantId, settingsRepo);
    expect(stored?.businessPhone).toBe('+442079460958');
  });

  it('rejects an un-normalisable business phone with a 400 naming businessPhone (#1397)', async () => {
    for (const businessPhone of ['512-555-0100 ext. 4', 'call us', '555-0100']) {
      const res = await request(app).put('/api/settings').send({ businessPhone });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('VALIDATION_ERROR');
      expect(res.body.details.field).toBe('businessPhone');
    }
    const stored = await getSettings(tenantId, settingsRepo);
    expect(stored?.businessPhone ?? null).toBeNull();
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
