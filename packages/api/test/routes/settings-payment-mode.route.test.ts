/**
 * S5a-5 (U8) — `PUT /api/settings` is one of the two write sites of
 * `payment_collection_mode`. A switch to "Collect on the spot" enqueues the
 * pay-link cleanup job inside the settings write (the in-memory leg here; the
 * Postgres leg — the job row committed with the request transaction — is in
 * test/integration/payment-link-mode-switch.test.ts). The response and the
 * `settings.tenant.updated` audit are unchanged.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import crypto from 'crypto';
import express, { Request, Response, NextFunction } from 'express';
import request from 'supertest';
import { createSettingsRouter } from '../../src/routes/settings';
import type { AuthenticatedRequest } from '../../src/auth/clerk';
import { InMemorySettingsRepository, createSettings } from '../../src/settings/settings';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { InMemoryQueue } from '../../src/queues/queue';

describe('PUT /api/settings — a switch to collect on site enqueues the pay-link cleanup (S5a-5)', () => {
  const tenantId = crypto.randomUUID();
  let app: express.Express;
  let settingsRepo: InMemorySettingsRepository;
  let auditRepo: InMemoryAuditRepository;
  let queue: InMemoryQueue;

  beforeEach(async () => {
    settingsRepo = new InMemorySettingsRepository();
    auditRepo = new InMemoryAuditRepository();
    queue = new InMemoryQueue();
    await createSettings({ tenantId, businessName: 'Acme HVAC' }, settingsRepo);
    app = express();
    app.use(express.json());
    app.use((req: Request, _res: Response, next: NextFunction) => {
      (req as AuthenticatedRequest).auth = { userId: 'owner-1', sessionId: 's', tenantId, role: 'owner' };
      next();
    });
    app.use(
      '/api/settings',
      createSettingsRouter(settingsRepo, undefined, auditRepo, undefined, undefined, undefined, { queue }),
    );
  });

  it('enqueues exactly one job for the switch, keyed by the write; the response and the audit changedKeys are unchanged', async () => {
    const res = await request(app).put('/api/settings').send({ paymentCollectionMode: 'collect_on_site' });
    expect(res.status).toBe(200);
    expect(res.body.paymentCollectionMode).toBe('collect_on_site');

    const job = await queue.receive<{ tenantId: string; pass: number }>();
    expect(job?.type).toBe('deactivate_payment_links');
    expect(job?.payload).toEqual({ tenantId, pass: 1 });
    const stored = await settingsRepo.findByTenant(tenantId);
    expect(job?.idempotencyKey).toBe(`deactivate-payment-links:${tenantId}:${stored!.updatedAt.toISOString()}`);
    expect(await queue.receive()).toBeNull();

    const audits = auditRepo.getAll().filter((e) => e.eventType === 'settings.tenant.updated');
    expect(audits.map((e) => e.metadata)).toEqual([{ changedKeys: ['paymentCollectionMode'] }]);
  });

  it('collect on site over collect on site, a switch to pay link and a save without the key enqueue nothing', async () => {
    await request(app).put('/api/settings').send({ paymentCollectionMode: 'collect_on_site' }).expect(200);
    await queue.receive();
    await request(app).put('/api/settings').send({ paymentCollectionMode: 'collect_on_site' }).expect(200);
    await request(app).put('/api/settings').send({ paymentCollectionMode: 'pay_link' }).expect(200);
    await request(app).put('/api/settings').send({ businessName: 'Acme Heating' }).expect(200);
    expect(queue.size()).toBe(0);
  });
});
