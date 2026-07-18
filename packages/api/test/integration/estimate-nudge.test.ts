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
      addressType: 'service',
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
      [tenant.tenantId, `estimate_nudge:${estimate.id}:v1:1`],
    );
    expect(claimRow.rows[0].status).toBe('sent');
  });

  it('reclaims a stale claim for the same occurrence (crash between claim and send)', async () => {
    const estimate = await seedSentEstimate('EST-NUDGE-2');
    await pool.query(
      `INSERT INTO send_claims (tenant_id, claim_key, status, claimed_at)
       VALUES ($1, $2, 'claimed', NOW() - INTERVAL '20 minutes')`,
      [tenant.tenantId, `estimate_nudge:${estimate.id}:v1:1`],
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

  it('Codex P2 (PR #705) — a "sent" claim for the same occurrence is RECONCILED (no resend, no throw, reminder_count finished) — crash between send and mark', async () => {
    const estimate = await seedSentEstimate('EST-NUDGE-3');
    await pool.query(
      `INSERT INTO send_claims (tenant_id, claim_key, status, claimed_at, sent_at)
       VALUES ($1, $2, 'sent', NOW(), NOW())`,
      [tenant.tenantId, `estimate_nudge:${estimate.id}:v1:1`],
    );
    const { sendService, sendEstimate } = fakeSendService();
    const asOf = new Date('2026-06-07T00:00:00Z');

    // Must NOT throw — the send already happened; throwing would freeze the
    // cadence. It reconciles the missing reminder_count bookkeeping instead.
    await dispatchEstimateNudge(
      { estimateRepo, sendService, pool },
      { tenantId: tenant.tenantId, estimate, channel: 'sms', asOf, actorId: 'test' },
    );

    expect(sendEstimate).not.toHaveBeenCalled();
    const updated = await estimateRepo.findById(tenant.tenantId, estimate.id);
    expect(updated!.reminderCount).toBe(1);
    expect(updated!.lastReminderAt).toEqual(asOf);
  });

  it('two concurrent dispatchEstimateNudge calls for the same estimate: exactly one send, cadence advances once', async () => {
    const estimate = await seedSentEstimate('EST-NUDGE-4');
    const { sendService, sendEstimate } = fakeSendService();

    const attempt = () =>
      dispatchEstimateNudge(
        { estimateRepo, sendService, pool },
        { tenantId: tenant.tenantId, estimate, channel: 'sms', asOf: new Date(), actorId: 'test' },
      );

    const results = await Promise.allSettled([attempt(), attempt()]);

    // The invariant that matters: the provider is called exactly once (no
    // double-send), and reminderCount ends at exactly 1. The loser either
    // rejects with EstimateNudgeAlreadyClaimedError (it observed the winner's
    // in-flight 'claimed'/'sending' claim) OR reconciles idempotently (it
    // observed the winner's completed 'sent' tombstone) — both are correct and
    // which one happens is a real-DB timing detail, so we don't pin it.
    expect(sendEstimate).toHaveBeenCalledTimes(1);
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(rejected.length).toBeLessThanOrEqual(1);
    for (const r of rejected) {
      expect((r as PromiseRejectedResult).reason).toBeInstanceOf(EstimateNudgeAlreadyClaimedError);
    }
    const updated = await estimateRepo.findById(tenant.tenantId, estimate.id);
    expect(updated!.reminderCount).toBe(1);
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

  it('Codex P1 (PR #705): a revised estimate (version bump + reminderCount reset) is re-notified — occurrence 1 does not collide with the prior revision\'s tombstone', async () => {
    const estimate = await seedSentEstimate('EST-NUDGE-REV');
    const { sendService, sendEstimate } = fakeSendService();

    // Version 1, reminder #1 — claims + tombstones estimate_nudge:{id}:v1:1.
    await dispatchEstimateNudge(
      { estimateRepo, sendService, pool },
      { tenantId: tenant.tenantId, estimate, channel: 'sms', asOf: new Date(), actorId: 'test' },
    );
    const v1Claim = await pool.query(
      `SELECT status FROM send_claims WHERE tenant_id = $1 AND claim_key = $2`,
      [tenant.tenantId, `estimate_nudge:${estimate.id}:v1:1`],
    );
    expect(v1Claim.rows[0].status).toBe('sent');

    // reviseEstimate's effect: bump version -> 2 and reset reminderCount -> 0
    // so the revised pricing is re-notified. The next nudge recomputes
    // occurrence 1; without the version in the key it would hit the v1:1
    // tombstone and never re-send.
    const revised = (await estimateRepo.update(tenant.tenantId, estimate.id, {
      version: 2,
      reminderCount: 0,
    }))!;

    await dispatchEstimateNudge(
      { estimateRepo, sendService, pool },
      { tenantId: tenant.tenantId, estimate: revised, channel: 'sms', asOf: new Date(), actorId: 'test' },
    );

    // The revised estimate really was re-sent, under a fresh v2:1 claim.
    expect(sendEstimate).toHaveBeenCalledTimes(2);
    const v2Claim = await pool.query(
      `SELECT status FROM send_claims WHERE tenant_id = $1 AND claim_key = $2`,
      [tenant.tenantId, `estimate_nudge:${estimate.id}:v2:1`],
    );
    expect(v2Claim.rows[0].status).toBe('sent');
    const afterRevise = await estimateRepo.findById(tenant.tenantId, estimate.id);
    expect(afterRevise!.reminderCount).toBe(1);
  });
});
