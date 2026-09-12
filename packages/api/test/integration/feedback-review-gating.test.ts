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
 * What this file does NOT prove: the story's "routed to me privately" half.
 * Grepping routes/public-feedback.ts and src/reputation (the only place a
 * private/owner-facing review flow exists, and that's for Google reviews,
 * not post-job feedback) turns up no push/SMS/email to the owner on a low
 * rating — "private routing" is implicit only: the response is persisted to
 * feedback_responses, which nothing but the owner's authenticated dashboard
 * (GET /api/feedback via requirePermission('settings:view')) can read, and
 * no public link is ever produced. There is no active "route to owner"
 * mechanism to pin. The it.fails below documents the gap rather than
 * asserting something the code doesn't do — do not delete it without either
 * building the notify-owner path or striking the claim from the PRD row.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
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
   * Documents the unimplemented half of the story. No code path notifies
   * the owner (push/SMS/email) when a low-rating response is submitted —
   * see the file header. This assertion is EXPECTED to fail; it.fails
   * flips vitest's pass/fail so a real "private routing" implementation
   * (which should make this pass) is what turns this file red, not green.
   */
  it.fails('story claim not met in code: a 3★ submission notifies the owner privately', async () => {
    const token = await mintRequest();
    const res = await request(app).post(`/public/feedback/${token}`).send({ rating: 2 });
    const found = await requestRepo.findByToken(token);
    const events = await auditRepo.findByEntity(tenant.tenantId, 'feedback_response', found!.id);
    // No event type for an owner notification exists in the codebase today —
    // this is the assertion a real implementation would need to satisfy.
    expect(events.map((e) => e.eventType)).toContain('feedback_response.owner_notified');
    expect(res.status).toBe(201);
  });
});
