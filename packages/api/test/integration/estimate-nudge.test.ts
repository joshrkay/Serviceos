/**
 * Docker-gated integration test for T4-F01's estimate-nudge claim-before-send
 * gate — proves dispatchEstimateNudge's interplay with real Postgres columns
 * (send_claims + estimates.reminder_count/last_reminder_at), not just the
 * mocked-Pool unit test (test/estimates/estimate-nudge.test.ts).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { Pool } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { PgEstimateRepository } from '../../src/estimates/pg-estimate';
import { PgJobRepository } from '../../src/jobs/pg-job';
import { PgCustomerRepository } from '../../src/customers/pg-customer';
import { PgLocationRepository } from '../../src/locations/pg-location';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { buildLineItem, calculateDocumentTotals, LineItem } from '../../src/shared/billing-engine';
import { createEstimate, type Estimate } from '../../src/estimates/estimate';
import {
  dispatchEstimateNudge,
  EstimateNudgeAlreadyClaimedError,
} from '../../src/estimates/estimate-nudge';
import type { SendService } from '../../src/notifications/send-service';

describe('dispatchEstimateNudge (integration) — claim-before-send against real Postgres', () => {
  let pool: Pool;
  let estimateRepo: PgEstimateRepository;
  let jobRepo: PgJobRepository;
  let tenant: { tenantId: string; userId: string };
  let jobId: string;

  beforeAll(async () => {
    pool = await getSharedTestDb();
    estimateRepo = new PgEstimateRepository(pool);
    jobRepo = new PgJobRepository(pool);
    const customerRepo = new PgCustomerRepository(pool);
    const locationRepo = new PgLocationRepository(pool);
    tenant = await createTestTenant(pool);

    const customerId = crypto.randomUUID();
    await customerRepo.create({
      id: customerId,
      tenantId: tenant.tenantId,
      firstName: 'Test',
      lastName: 'Customer',
      displayName: 'Test Customer',
      preferredChannel: 'phone',
      smsConsent: true,
      isArchived: false,
      createdBy: tenant.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const locationId = crypto.randomUUID();
    await locationRepo.create({
      id: locationId,
      tenantId: tenant.tenantId,
      customerId,
      street1: '123 Main St',
      city: 'Austin',
      state: 'TX',
      postalCode: '78701',
      country: 'USA',
      isPrimary: true,
      isArchived: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    jobId = crypto.randomUUID();
    await jobRepo.create({
      id: jobId,
      tenantId: tenant.tenantId,
      customerId,
      locationId,
      jobNumber: 'JOB-NUDGE-1',
      summary: 'Test job',
      status: 'scheduled',
      priority: 'normal',
      createdBy: tenant.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  async function seedSentEstimate(estimateNumber: string): Promise<Estimate> {
    const items: LineItem[] = [buildLineItem('li-1', 'Service call', 1, 15000, 0, true, 'labor')];
    const est = await createEstimate(
      { tenantId: tenant.tenantId, jobId, estimateNumber, lineItems: items, createdBy: tenant.userId },
      estimateRepo,
    );
    return (await estimateRepo.update(tenant.tenantId, est.id, {
      status: 'sent',
      sentAt: new Date('2026-06-01T00:00:00Z'),
    }))!;
  }

  function fakeSendService(): { sendService: Pick<SendService, 'sendEstimate'>; sendEstimate: ReturnType<typeof vi.fn> } {
    const sendEstimate = vi.fn().mockResolvedValue({
      estimateId: 'x',
      viewUrl: 'https://x/e/tok',
      viewToken: 'tok',
      channelsSent: [],
    });
    return { sendService: { sendEstimate }, sendEstimate };
  }

  it('happy path: sends once and persists reminder_count/last_reminder_at on the real row', async () => {
    const estimate = await seedSentEstimate('EST-NUDGE-1');
    const { sendService, sendEstimate } = fakeSendService();
    const auditRepo = new InMemoryAuditRepository();
    const asOf = new Date('2026-06-05T00:00:00Z');

    await dispatchEstimateNudge(
      { estimateRepo, sendService, auditRepo, pool },
      { tenantId: tenant.tenantId, estimate, channel: 'sms', asOf, actorId: 'test' },
    );

    expect(sendEstimate).toHaveBeenCalledTimes(1);
    const updated = await estimateRepo.findById(tenant.tenantId, estimate.id);
    expect(updated!.reminderCount).toBe(1);
    expect(updated!.lastReminderAt).toEqual(asOf);

    const claimRow = await pool.query(
      `SELECT status FROM send_claims WHERE tenant_id = $1 AND claim_key = $2`,
      [tenant.tenantId, `estimate_nudge:${estimate.id}:1`],
    );
    expect(claimRow.rows[0].status).toBe('sent');
  });

  it('reclaims a stale claim for the same occurrence (crash between claim and send)', async () => {
    const estimate = await seedSentEstimate('EST-NUDGE-2');
    await pool.query(
      `INSERT INTO send_claims (tenant_id, claim_key, status, claimed_at)
       VALUES ($1, $2, 'claimed', NOW() - INTERVAL '20 minutes')`,
      [tenant.tenantId, `estimate_nudge:${estimate.id}:1`],
    );
    const { sendService, sendEstimate } = fakeSendService();

    await dispatchEstimateNudge(
      { estimateRepo, sendService, pool },
      { tenantId: tenant.tenantId, estimate, channel: 'sms', asOf: new Date(), actorId: 'test' },
    );

    expect(sendEstimate).toHaveBeenCalledTimes(1);
    const updated = await estimateRepo.findById(tenant.tenantId, estimate.id);
    expect(updated!.reminderCount).toBe(1);
  });

  it('a "sent" claim for the same occurrence throws and does not resend or bump reminder_count (crash between send and mark)', async () => {
    const estimate = await seedSentEstimate('EST-NUDGE-3');
    await pool.query(
      `INSERT INTO send_claims (tenant_id, claim_key, status, claimed_at, sent_at)
       VALUES ($1, $2, 'sent', NOW(), NOW())`,
      [tenant.tenantId, `estimate_nudge:${estimate.id}:1`],
    );
    const { sendService, sendEstimate } = fakeSendService();

    await expect(
      dispatchEstimateNudge(
        { estimateRepo, sendService, pool },
        { tenantId: tenant.tenantId, estimate, channel: 'sms', asOf: new Date(), actorId: 'test' },
      ),
    ).rejects.toThrow(EstimateNudgeAlreadyClaimedError);

    expect(sendEstimate).not.toHaveBeenCalled();
    const updated = await estimateRepo.findById(tenant.tenantId, estimate.id);
    expect(updated!.reminderCount ?? 0).toBe(0);
  });

  it('two concurrent dispatchEstimateNudge calls for the same estimate: exactly one send, one claimed-error', async () => {
    const estimate = await seedSentEstimate('EST-NUDGE-4');
    const { sendService, sendEstimate } = fakeSendService();

    const attempt = () =>
      dispatchEstimateNudge(
        { estimateRepo, sendService, pool },
        { tenantId: tenant.tenantId, estimate, channel: 'sms', asOf: new Date(), actorId: 'test' },
      );

    const results = await Promise.allSettled([attempt(), attempt()]);
    expect(sendEstimate).toHaveBeenCalledTimes(1);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(
      EstimateNudgeAlreadyClaimedError,
    );
  });

  it('repeatability: a second nudge (occurrence 2) after the first completes is a fresh, independent claim', async () => {
    const estimate = await seedSentEstimate('EST-NUDGE-5');
    const { sendService, sendEstimate } = fakeSendService();

    await dispatchEstimateNudge(
      { estimateRepo, sendService, pool },
      { tenantId: tenant.tenantId, estimate, channel: 'sms', asOf: new Date(), actorId: 'test' },
    );
    const afterFirst = await estimateRepo.findById(tenant.tenantId, estimate.id);
    expect(afterFirst!.reminderCount).toBe(1);

    await dispatchEstimateNudge(
      { estimateRepo, sendService, pool },
      { tenantId: tenant.tenantId, estimate: afterFirst!, channel: 'sms', asOf: new Date(), actorId: 'test' },
    );

    expect(sendEstimate).toHaveBeenCalledTimes(2);
    const afterSecond = await estimateRepo.findById(tenant.tenantId, estimate.id);
    expect(afterSecond!.reminderCount).toBe(2);
  });
});
