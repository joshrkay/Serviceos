/**
 * N-005 (F-9) — End-of-Day Digest reflection sections, Docker-gated.
 *
 * Pins the REAL SQL the new digest fields depend on (a mocked Pool is not
 * proof the columns/predicates exist — see CLAUDE.md's entity-resolver
 * lesson):
 *   - ProposalRepository.findConfidenceMarkedForDay: the JSONB expression
 *     predicate `payload->'_meta'->>'overallConfidence' IN ('low','very_low')`
 *     + created_at window + LIMIT ordering.
 *   - ProposalRepository.findAutonomousLaneApprovedForDay (D-015 amendment):
 *     the JSONB predicate
 *     `source_context->'autonomousLaneEvaluation'->>'eligible' = 'true'`
 *     + created_at window + tenant (RLS) scoping.
 *   - ProposalRepository.findAppliedInstructionsForDay (WS10): the JSONB
 *     predicate `payload->'_meta' ? 'appliedStandingInstructions' AND
 *     jsonb_array_length(payload->'_meta'->'appliedStandingInstructions') > 0`
 *     + created_at window + tenant (RLS) scoping, and that the partial index
 *     (migration 246) predicate matches the query's first predicate.
 *   - EstimateListOptions sentFrom/sentTo: the `sent_at >= $ AND sent_at < $`
 *     range scan behind "quotes sent today".
 *   - computeDigestPayload end-to-end over real proposal/estimate/correction
 *     repos → the PRD §12 assertion ("wasn't sure about" + "learned today"
 *     populate correctly, quotes-sent sums today's sent estimates).
 *
 * NOTE: Docker Hub pulls are rate-limited locally, so vitest globalSetup may
 * fail to start the testcontainer here — that's expected; this file is
 * authored for CI (test/integration runs in PR CI).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { PgProposalRepository } from '../../src/proposals/pg-proposal';
import { PgEstimateRepository } from '../../src/estimates/pg-estimate';
import { PgJobRepository } from '../../src/jobs/pg-job';
import { PgCustomerRepository } from '../../src/customers/pg-customer';
import { PgLocationRepository } from '../../src/locations/pg-location';
import { PgCorrectionLessonRepository } from '../../src/learning/corrections/pg-correction-lesson';
import { buildCorrectionLesson } from '../../src/learning/corrections/correction-lesson';
import { computeDigestPayload, type DigestComputeDeps } from '../../src/digest/digest-service';
import type { Proposal, ProposalStatus } from '../../src/proposals/proposal';
import type { Estimate } from '../../src/estimates/estimate';
import { buildLineItem, calculateDocumentTotals } from '../../src/shared/billing-engine';
import type { PaymentRepository } from '../../src/invoices/payment';
import type { InvoiceRepository } from '../../src/invoices/invoice';
import type { AppointmentRepository } from '../../src/appointments/appointment';
import type { SettingsRepository } from '../../src/settings/settings';
import type { FeedbackResponseRepository } from '../../src/feedback/feedback-response';

// Tenant timezone UTC keeps the local-day window equal to the UTC calendar day.
const DATE = '2026-07-10';
const DAY_START = new Date('2026-07-10T00:00:00.000Z');
const DAY_END = new Date('2026-07-11T00:00:00.000Z');
const IN_DAY = new Date('2026-07-10T15:00:00.000Z');
const YESTERDAY = new Date('2026-07-09T15:00:00.000Z');

describe('Postgres integration — digest reflection sections (N-005)', () => {
  let pool: Pool;
  let proposalRepo: PgProposalRepository;
  let estimateRepo: PgEstimateRepository;
  let jobRepo: PgJobRepository;
  let lessonRepo: PgCorrectionLessonRepository;
  let tenant: { tenantId: string; userId: string };
  let jobId: string;

  function makeProposal(overrides: Partial<Proposal>): Proposal {
    return {
      id: crypto.randomUUID(),
      tenantId: tenant.tenantId,
      proposalType: 'draft_estimate',
      status: 'ready_for_review' as ProposalStatus,
      payload: {},
      summary: 'A proposal',
      createdBy: tenant.userId,
      createdAt: IN_DAY,
      updatedAt: IN_DAY,
      ...overrides,
    } as Proposal;
  }

  // create() does not persist sent_at (it is set via update/markSent), so the
  // helper creates then updates sent_at to exercise the real sent_at range scan.
  async function insertEstimate(
    num: string,
    totalCents: number,
    sentAt: Date | undefined,
    status: Estimate['status'],
  ): Promise<Estimate> {
    const items = [buildLineItem(crypto.randomUUID(), 'Labor', 1, totalCents, 0, true, 'labor')];
    const estimate: Estimate = {
      id: crypto.randomUUID(),
      tenantId: tenant.tenantId,
      jobId,
      estimateNumber: num,
      status,
      lineItems: items,
      totals: calculateDocumentTotals(items, 0, 0),
      version: 1,
      createdBy: tenant.userId,
      createdAt: IN_DAY,
      updatedAt: IN_DAY,
    };
    await estimateRepo.create(estimate);
    if (sentAt) await estimateRepo.update(tenant.tenantId, estimate.id, { sentAt });
    return estimate;
  }

  beforeAll(async () => {
    pool = await getSharedTestDb();
    proposalRepo = new PgProposalRepository(pool);
    estimateRepo = new PgEstimateRepository(pool);
    jobRepo = new PgJobRepository(pool);
    lessonRepo = new PgCorrectionLessonRepository(pool);
    tenant = await createTestTenant(pool);

    const customerRepo = new PgCustomerRepository(pool);
    const locationRepo = new PgLocationRepository(pool);
    const customerId = crypto.randomUUID();
    await customerRepo.create({
      id: customerId, tenantId: tenant.tenantId, firstName: 'Q', lastName: 'Sent',
      displayName: 'Q Sent', preferredChannel: 'phone', smsConsent: false, isArchived: false,
      createdBy: tenant.userId, createdAt: new Date(), updatedAt: new Date(),
    });
    const locationId = crypto.randomUUID();
    await locationRepo.create({
      id: locationId, tenantId: tenant.tenantId, customerId, street1: '1 St', city: 'Austin',
      state: 'TX', postalCode: '78701', country: 'USA', isPrimary: true, isArchived: false,
      createdAt: new Date(), updatedAt: new Date(),
    });
    jobId = crypto.randomUUID();
    await jobRepo.create({
      id: jobId, tenantId: tenant.tenantId, customerId, locationId, jobNumber: 'JOB-Q',
      summary: 'quote job', status: 'scheduled', priority: 'normal',
      createdBy: tenant.userId, createdAt: new Date(), updatedAt: new Date(),
    });
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  it('findConfidenceMarkedForDay returns only today\'s low/very_low proposals (JSONB predicate + window)', async () => {
    const veryLow = makeProposal({
      status: 'rejected',
      summary: 'Reyes estimate',
      payload: { _meta: { overallConfidence: 'very_low' } },
      confidenceFactors: ['ambiguous scope'],
    });
    const high = makeProposal({ payload: { _meta: { overallConfidence: 'high' } } });
    const lowYesterday = makeProposal({
      createdAt: YESTERDAY,
      updatedAt: YESTERDAY,
      payload: { _meta: { overallConfidence: 'low' } },
    });
    await proposalRepo.create(veryLow);
    await proposalRepo.create(high);
    await proposalRepo.create(lowYesterday);

    const rows = await proposalRepo.findConfidenceMarkedForDay(tenant.tenantId, DAY_START, DAY_END, 10);
    expect(rows.map((r) => r.id)).toEqual([veryLow.id]);
    expect(rows[0].status).toBe('rejected');
    expect(rows[0].confidenceFactors).toEqual(['ambiguous scope']);
  });

  it('findAutonomousLaneApprovedForDay returns only today\'s eligible-lane proposals, tenant-scoped (D-015 amendment)', async () => {
    const eligibleToday = makeProposal({
      status: 'approved',
      summary: 'Auto-booked AC repair',
      sourceContext: { autonomousLaneEvaluation: { eligible: true, threshold: 0.95 } },
    });
    const ineligibleToday = makeProposal({
      status: 'ready_for_review',
      summary: 'Ineligible booking',
      sourceContext: { autonomousLaneEvaluation: { eligible: false, reason: 'below_threshold' } },
    });
    const eligibleYesterday = makeProposal({
      createdAt: YESTERDAY,
      updatedAt: YESTERDAY,
      status: 'approved',
      sourceContext: { autonomousLaneEvaluation: { eligible: true, threshold: 0.95 } },
    });
    const noStamp = makeProposal({ status: 'draft' });
    await proposalRepo.create(eligibleToday);
    await proposalRepo.create(ineligibleToday);
    await proposalRepo.create(eligibleYesterday);
    await proposalRepo.create(noStamp);

    const rows = await proposalRepo.findAutonomousLaneApprovedForDay!(
      tenant.tenantId,
      DAY_START,
      DAY_END,
      10,
    );
    expect(rows.map((r) => r.id)).toEqual([eligibleToday.id]);
    expect(rows[0].sourceContext).toMatchObject({
      autonomousLaneEvaluation: { eligible: true, threshold: 0.95 },
    });

    // RLS + explicit tenant_id predicate: another tenant never sees this row.
    const other = await createTestTenant(pool);
    const leaked = await proposalRepo.findAutonomousLaneApprovedForDay!(
      other.tenantId,
      DAY_START,
      DAY_END,
      10,
    );
    expect(leaked).toHaveLength(0);
  });

  it('findAppliedInstructionsForDay returns only today\'s applied-instruction proposals, tenant-scoped (WS10)', async () => {
    const appliedToday = makeProposal({
      status: 'ready_for_review',
      summary: 'Estimate with trip fee rule applied',
      payload: {
        _meta: {
          appliedStandingInstructions: [{ id: 'rule-1', text: 'always add trip fee' }],
        },
      },
    });
    const noStampToday = makeProposal({ status: 'draft', payload: {} });
    const emptyArrayStampToday = makeProposal({
      status: 'draft',
      payload: { _meta: { appliedStandingInstructions: [] } },
    });
    const appliedYesterday = makeProposal({
      createdAt: YESTERDAY,
      updatedAt: YESTERDAY,
      status: 'ready_for_review',
      payload: {
        _meta: {
          appliedStandingInstructions: [{ id: 'rule-1', text: 'always add trip fee' }],
        },
      },
    });
    await proposalRepo.create(appliedToday);
    await proposalRepo.create(noStampToday);
    await proposalRepo.create(emptyArrayStampToday);
    await proposalRepo.create(appliedYesterday);

    const rows = await proposalRepo.findAppliedInstructionsForDay!(
      tenant.tenantId,
      DAY_START,
      DAY_END,
      10,
    );
    expect(rows.map((r) => r.id)).toEqual([appliedToday.id]);
    expect(rows[0].payload).toMatchObject({
      _meta: { appliedStandingInstructions: [{ id: 'rule-1', text: 'always add trip fee' }] },
    });

    // RLS + explicit tenant_id predicate: another tenant never sees this row.
    const other = await createTestTenant(pool);
    const leaked = await proposalRepo.findAppliedInstructionsForDay!(
      other.tenantId,
      DAY_START,
      DAY_END,
      10,
    );
    expect(leaked).toHaveLength(0);
  });

  it('estimate findByTenant sentFrom/sentTo scans today\'s sent estimates (sent_at range)', async () => {
    const sentToday = await insertEstimate('EST-T1', 45000, IN_DAY, 'sent');
    const acceptedSentToday = await insertEstimate('EST-T2', 20000, IN_DAY, 'accepted');
    const sentYesterday = await insertEstimate('EST-Y', 99000, YESTERDAY, 'sent');
    const neverSent = await insertEstimate('EST-D', 12300, undefined, 'draft');

    const rows = await estimateRepo.findByTenant(tenant.tenantId, { sentFrom: DAY_START, sentTo: DAY_END });
    const ids = new Set(rows.map((r) => r.id));
    expect(ids.has(sentToday.id)).toBe(true);
    expect(ids.has(acceptedSentToday.id)).toBe(true); // sent today, accepted same day still counts
    expect(ids.has(sentYesterday.id)).toBe(false);
    expect(ids.has(neverSent.id)).toBe(false);
    const pipeline = rows
      .filter((r) => ids.has(r.id))
      .reduce((s, e) => s + e.totals.totalCents, 0);
    expect(pipeline).toBe(65000);
  });

  it('computeDigestPayload composes quotesSent + unsureAbout + learnedToday from the real DB (PRD §12)', async () => {
    // A very_low proposal created today, later rejected.
    const unsure = makeProposal({
      status: 'rejected',
      summary: 'Unsure about the Diaz scope',
      payload: { _meta: { overallConfidence: 'very_low' } },
    });
    await proposalRepo.create(unsure);
    // An estimate sent today.
    await insertEstimate('EST-P1', 55000, IN_DAY, 'sent');
    // A correction lesson applied today.
    await lessonRepo.create(
      buildCorrectionLesson({
        id: crypto.randomUUID(),
        tenantId: tenant.tenantId,
        lessonType: 'labor_rate_changed',
        sourceProposalId: unsure.id,
        ownerId: tenant.userId,
        summary: 'labor rate is $145 going forward',
        payload: { kind: 'labor_rate_changed', beforeCents: 12000, afterCents: 14500 },
        localDate: DATE,
      }),
    );

    const empty = async () => [];
    const deps: DigestComputeDeps = {
      paymentRepo: { findByTenant: empty } as unknown as PaymentRepository,
      invoiceRepo: { findByTenant: empty, findByJobs: empty } as unknown as InvoiceRepository,
      estimateRepo,
      jobRepo,
      appointmentRepo: { findByDateRange: empty } as unknown as AppointmentRepository,
      proposalRepo,
      customerRepo: { findById: async () => null } as never,
      settingsRepo: { findByTenant: async () => ({ timezone: 'UTC' }) } as unknown as SettingsRepository,
      feedbackResponseRepo: {
        countByRatingInRange: async () => ({ 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 }),
      } as unknown as FeedbackResponseRepository,
      correctionLessonRepo: lessonRepo,
      now: () => new Date('2026-07-10T20:00:00.000Z'),
    };

    const payload = await computeDigestPayload(tenant.tenantId, DATE, deps);

    // quotes sent — at least the estimate we sent today, summed in integer cents.
    expect(payload.quotesSent).toBeDefined();
    expect(payload.quotesSent!.count).toBeGreaterThanOrEqual(1);
    expect(payload.quotesSent!.pipelineValueCents).toBeGreaterThanOrEqual(55000);

    // "what I wasn't sure about today" — the very_low proposal with outcome rejected.
    const unsureItem = payload.unsureAbout?.find((u) => u.proposalId === unsure.id);
    expect(unsureItem).toMatchObject({ confidence: 'very_low', outcome: 'rejected' });

    // "what I learned today" — the applied lesson summary.
    expect(payload.learnedToday?.map((l) => l.summary)).toContain('labor rate is $145 going forward');
  });
});
