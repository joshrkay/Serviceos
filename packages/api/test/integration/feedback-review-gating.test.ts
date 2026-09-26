/**
 * Postgres integration — §8.9 row 9.3 (review gating).
 *
 * The story ("As M, I want an unhappy customer routed to me privately and a
 * happy one to Google, so a bad day doesn't blow up my rating") is graded on
 * PR #1027 (#1009's G1 resolution) as: "no rating-gate test at real DB; the
 * unit route enforces '4★+' — align the row's wording with the code when you
 * write the Docker test." The code IS the gate: POST /public/feedback/:token
 * (routes/public-feedback.ts) surfaces `reviewUrls` only when `rating >= 4`;
 * a 1-3★ response gets `{ ok: true }` with no public link at all. The only
 * prior proof of this was a unit test over in-memory repos
 * (test/routes/public-feedback-review-urls.test.ts) — never against real
 * Postgres, and never with an audit-row readback.
 *
 * This file:
 *   1. pins the rating>=4 gate against REAL Pg repos (feedback_requests,
 *      feedback_responses, tenant_settings),
 *   2. reads the feedback_response.submitted audit row back via
 *      PgAuditRepository.findByEntity (D2-1d's route already writes it;
 *      only ever asserted before via InMemoryAuditRepository, in
 *      test/audit/audit-coverage-d2-1d.test.ts),
 *   3. proves T1: a second tenant's OWN review-URL settings decide its
 *      response, never the first tenant's.
 *
 *   4. proves the story's "routed to me privately" half (#1071): a ≤3★
 *      submission pushes the submitting tenant's owner through the shared
 *      OwnerNotificationService/notifyOwner() seam every other owner push
 *      uses; 4★+ does not; a neighbour tenant's devices never receive it.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { Pool } from 'pg';
import express from 'express';
import request from 'supertest';
import { getSharedTestDb, createTestTenant, closeSharedTestDb, TestTenant } from './shared';
import { createPublicFeedbackRouter } from '../../src/routes/public-feedback';
import { PgFeedbackRequestRepository } from '../../src/feedback/pg-feedback-request';
import { PgFeedbackResponseRepository } from '../../src/feedback/pg-feedback-response';
import { PgSettingsRepository } from '../../src/settings/pg-settings';
import { PgAuditRepository } from '../../src/audit/pg-audit';
import { createFeedbackRequest } from '../../src/feedback/feedback-request';
import { OwnerNotificationService } from '../../src/notifications/owner-notification-service';
import { InMemoryPushDeliveryProvider } from '../../src/notifications/push-delivery-provider';
import { InMemoryDeviceTokenRepository } from '../../src/push/device-token-service';
import { setOwnerNotifications } from '../../src/notifications/owner-notifications-instance';

async function createJob(pool: Pool, tenant: TestTenant): Promise<string> {
  const customerId = crypto.randomUUID();
  const locationId = crypto.randomUUID();
  const jobId = crypto.randomUUID();
  await pool.query(
    `INSERT INTO customers (id, tenant_id, display_name, created_by) VALUES ($1, $2, $3, $4)`,
    [customerId, tenant.tenantId, 'Gating Customer', tenant.userId],
  );
  await pool.query(
    `INSERT INTO service_locations (id, tenant_id, customer_id, street1, city, state, postal_code)
     VALUES ($1, $2, $3, '1 Main St', 'Austin', 'TX', '78701')`,
    [locationId, tenant.tenantId, customerId],
  );
  await pool.query(
    `INSERT INTO jobs (id, tenant_id, customer_id, location_id, job_number, summary, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [jobId, tenant.tenantId, customerId, locationId, `JOB-${jobId.slice(0, 8)}`, 'Test job', tenant.userId],
  );
  return jobId;
}

describe('Postgres integration — 9.3 review-gating (rating >= 4 ⇒ review links)', () => {
  let pool: Pool;
  let requestRepo: PgFeedbackRequestRepository;
  let responseRepo: PgFeedbackResponseRepository;
  let settingsRepo: PgSettingsRepository;
  let auditRepo: PgAuditRepository;
  let app: express.Express;
  let tenant: TestTenant;

  beforeAll(async () => {
    pool = await getSharedTestDb();
    requestRepo = new PgFeedbackRequestRepository(pool);
    responseRepo = new PgFeedbackResponseRepository(pool);
    settingsRepo = new PgSettingsRepository(pool);
    auditRepo = new PgAuditRepository(pool);

    tenant = await createTestTenant(pool);
    await settingsRepo.create({
      id: crypto.randomUUID(),
      tenantId: tenant.tenantId,
      businessName: 'Gating Co',
      timezone: 'America/Chicago',
      estimatePrefix: 'EST-',
      invoicePrefix: 'INV-',
      nextEstimateNumber: 1,
      nextInvoiceNumber: 1,
      defaultPaymentTermDays: 30,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    // googleReviewUrl/yelpReviewUrl aren't part of the INSERT column list in
    // PgSettingsRepository.create() (migration 120 added them later, wired
    // only into the generic `update()` column map) — set them the same way
    // the Settings UI does, via update().
    await settingsRepo.update(tenant.tenantId, {
      googleReviewUrl: 'https://g.page/r/gating-co',
      yelpReviewUrl: 'https://www.yelp.com/biz/gating-co',
    });

    app = express();
    app.use(express.json());
    app.use('/public/feedback', createPublicFeedbackRouter(requestRepo, responseRepo, settingsRepo, auditRepo));
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  async function mintRequest(): Promise<string> {
    const jobId = await createJob(pool, tenant);
    const req = await requestRepo.create(createFeedbackRequest({ tenantId: tenant.tenantId, jobId }));
    return req.token;
  }

  it('3★ (unhappy): NO review links in the response, and the audit row reads back at real Postgres', async () => {
    const token = await mintRequest();

    const res = await request(app).post(`/public/feedback/${token}`).send({ rating: 3, comment: 'meh' });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ ok: true });
    expect(res.body.reviewUrls).toBeUndefined();

    const found = await requestRepo.findByToken(token);
    const response = await responseRepo.findByRequest(tenant.tenantId, found!.id);
    const events = await auditRepo.findByEntity(tenant.tenantId, 'feedback_response', response!.id);
    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe('feedback_response.submitted');
    expect((events[0].metadata as Record<string, unknown>).rating).toBe(3);
  });

  it('5★ (happy): review links ARE returned, and the audit row reads back at real Postgres', async () => {
    const token = await mintRequest();

    const res = await request(app).post(`/public/feedback/${token}`).send({ rating: 5, comment: 'great!' });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({
      ok: true,
      reviewUrls: {
        google: 'https://g.page/r/gating-co',
        yelp: 'https://www.yelp.com/biz/gating-co',
      },
    });

    const found = await requestRepo.findByToken(token);
    const response = await responseRepo.findByRequest(tenant.tenantId, found!.id);
    const events = await auditRepo.findByEntity(tenant.tenantId, 'feedback_response', response!.id);
    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe('feedback_response.submitted');
    expect((events[0].metadata as Record<string, unknown>).rating).toBe(5);
  });

  it('T1: a second tenant with NO review-URL settings gets no links on a 5★ — the first tenant’s configured URLs never leak across', async () => {
    const otherTenant = await createTestTenant(pool);
    await settingsRepo.create({
      id: crypto.randomUUID(),
      tenantId: otherTenant.tenantId,
      businessName: 'Neighbour Co',
      timezone: 'America/Chicago',
      estimatePrefix: 'EST-',
      invoicePrefix: 'INV-',
      nextEstimateNumber: 1,
      nextInvoiceNumber: 1,
      defaultPaymentTermDays: 30,
      // Deliberately no googleReviewUrl / yelpReviewUrl.
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const jobId = await createJob(pool, otherTenant);
    const req = await requestRepo.create(createFeedbackRequest({ tenantId: otherTenant.tenantId, jobId }));

    const res = await request(app).post(`/public/feedback/${req.token}`).send({ rating: 5 });
    expect(res.status).toBe(201);
    // Neither of tenant `tenant`'s configured URLs appears here.
    expect(res.body).toEqual({ ok: true });
  });

  /**
   * The story's "routed to me privately" half (#1071). A ≤3★ submission fans
   * out through the process-wide OwnerNotificationService / notifyOwner()
   * seam every other owner push uses (notifications/owner-notifications-
   * instance.ts) as a `low_rating_feedback` push, scoped to the submitting
   * tenant's devices. 4★+ is not pushed — those customers get the public
   * review links instead.
   */
  describe('low-rating owner push (#1071)', () => {
    let pushProvider: InMemoryPushDeliveryProvider;
    let otherTenant: TestTenant;

    beforeAll(async () => {
      otherTenant = await createTestTenant(pool);
    });

    beforeEach(async () => {
      const tokenRepo = new InMemoryDeviceTokenRepository();
      await tokenRepo.register({
        tenantId: tenant.tenantId,
        userId: 'owner-1',
        expoPushToken: 'ExponentPushToken[feedback-gating-owner]',
        platform: 'ios',
      });
      await tokenRepo.register({
        tenantId: otherTenant.tenantId,
        userId: 'owner-2',
        expoPushToken: 'ExponentPushToken[neighbour-owner]',
        platform: 'ios',
      });
      pushProvider = new InMemoryPushDeliveryProvider();
      setOwnerNotifications(new OwnerNotificationService({ deviceTokenRepo: tokenRepo, provider: pushProvider }));
    });

    afterEach(() => {
      setOwnerNotifications(undefined);
    });

    it("a 2★ submission pushes ONLY the submitting tenant's owner, deep-linked to the job", async () => {
      const jobId = await createJob(pool, tenant);
      const req = await requestRepo.create(createFeedbackRequest({ tenantId: tenant.tenantId, jobId }));

      const res = await request(app).post(`/public/feedback/${req.token}`).send({ rating: 2 });
      expect(res.status).toBe(201);

      expect(pushProvider.sent.map((m) => m.to)).toEqual(['ExponentPushToken[feedback-gating-owner]']);
      expect(pushProvider.sent[0].data).toMatchObject({
        type: 'low_rating_feedback',
        screen: `/jobs/${jobId}`,
        entityId: jobId,
      });
    });

    it('a 3★ submission (boundary) pushes the owner', async () => {
      const token = await mintRequest();
      const res = await request(app).post(`/public/feedback/${token}`).send({ rating: 3 });
      expect(res.status).toBe(201);
      expect(pushProvider.sent).toHaveLength(1);
    });

    it('a 4★ submission does NOT push the owner', async () => {
      const token = await mintRequest();
      const res = await request(app).post(`/public/feedback/${token}`).send({ rating: 4 });
      expect(res.status).toBe(201);
      expect(pushProvider.sent).toHaveLength(0);
    });
  });
});
