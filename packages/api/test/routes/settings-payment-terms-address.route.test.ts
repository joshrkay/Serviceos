/**
 * #1402 §13 — payment terms and business address through PUT/GET /api/settings.
 * Seam: the settings router over the in-memory settings repository.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import express, { Request, Response, NextFunction } from 'express';
import request from 'supertest';
import { createSettingsRouter } from '../../src/routes/settings';
import { AuthenticatedRequest } from '../../src/auth/clerk';
import { InMemorySettingsRepository, createSettings } from '../../src/settings/settings';

const TENANT_ID = 'tenant-1402-settings';

describe('PUT /api/settings — #1402 §13 payment terms + business address', () => {
  let app: express.Express;

  beforeEach(async () => {
    app = express();
    app.use(express.json());
    app.use((req: Request, _res: Response, next: NextFunction) => {
      (req as AuthenticatedRequest).auth = {
        userId: 'user-1402',
        sessionId: 'session-1402',
        tenantId: TENANT_ID,
        role: 'owner',
      };
      next();
    });
    const repo = new InMemorySettingsRepository();
    await createSettings({ tenantId: TENANT_ID, businessName: 'Terms Co' }, repo);
    app.use('/api/settings', createSettingsRouter(repo));
  });

  it('rejects payment terms longer than a year (365 days)', async () => {
    const res = await request(app).put('/api/settings').send({ defaultPaymentTermDays: 366 });

    expect(res.status).toBe(400);
    const after = await request(app).get('/api/settings');
    expect(after.body.defaultPaymentTermDays).toBe(30);
  });

  it('accepts Net 45 and Due on receipt (0)', async () => {
    expect((await request(app).put('/api/settings').send({ defaultPaymentTermDays: 45 })).body
      .defaultPaymentTermDays).toBe(45);
    expect((await request(app).put('/api/settings').send({ defaultPaymentTermDays: 0 })).body
      .defaultPaymentTermDays).toBe(0);
  });

  it('stores the business address and returns it on GET', async () => {
    const put = await request(app)
      .put('/api/settings')
      .send({ businessAddress: '  1200 W Main St, Suite 4\nMesa, AZ 85201  ' });

    expect(put.status).toBe(200);
    const after = await request(app).get('/api/settings');
    expect(after.body.businessAddress).toBe('1200 W Main St, Suite 4\nMesa, AZ 85201');
  });
});
