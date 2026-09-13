/**
 * Postgres integration — §8.9 row 9.4 (Google reviews: classification +
 * drafting halves at real Postgres).
 *
 * test/integration/google-reviews-worker.test.ts already pins the poll/
 * persist/RLS/throttle contract at real Postgres and says explicitly:
 * "The handler / pagination / proposal-emission logic is covered by
 * test/workers/google-reviews.test.ts against in-memory repos" and
 * "Classification and drafting are unit-only" (PRD row note). The gap this
 * file closes: `PgCustomerLoader` (reputation/match-customer.ts) — the ONE
 * DB-touching step in the classify→match→draft pipeline (the customers ⋈
 * jobs ⋈ appointments join used to find a review's matching customer) — had
 * ZERO test coverage anywhere in the repo (grepped; only referenced from
 * app.ts wiring). `classifyReview` and the draft composers are pure/LLM-only
 * and have nothing further to prove against a database — "real DB where the
 * code allows" for this row is the customer loader.
 *
 * Not attempted here: rung 5. That needs a connected Google Business Profile
 * (a live OAuth integration + real reviews from Google) — out of scope for
 * this repo's test harness and not faked. See PR #1027 / #1013's own note:
 * "OAuth parked."
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { v4 as uuidv4 } from 'uuid';
import { getSharedTestDb, createTestTenant, closeSharedTestDb, TestTenant } from './shared';
import { PgCustomerRepository } from '../../src/customers/pg-customer';
import { PgJobRepository } from '../../src/jobs/pg-job';
import { PgAppointmentRepository } from '../../src/appointments/pg-appointment';
import { createAppointment } from '../../src/appointments/appointment';
import { PgCustomerLoader, matchReviewerToCustomer } from '../../src/reputation/match-customer';
import { buildReviewResponseProposal } from '../../src/reputation/build-proposal';
import { NoopBrandVoiceLoader } from '../../src/reputation/brand-voice';
import { InMemoryServiceCreditRepository } from '../../src/reputation/service-credit';
import type { Review } from '../../src/reputation/review';
import type { LLMGateway } from '../../src/ai/gateway/gateway';

const DAY_MS = 24 * 60 * 60 * 1000;

describe('Postgres integration — 9.4 Google reviews: customer matching against real DB', () => {
  let pool: Pool;
  let customerRepo: PgCustomerRepository;
  let jobRepo: PgJobRepository;
  let appointmentRepo: PgAppointmentRepository;
  let customerLoader: PgCustomerLoader;

  beforeAll(async () => {
    pool = await getSharedTestDb();
    customerRepo = new PgCustomerRepository(pool);
    jobRepo = new PgJobRepository(pool);
    appointmentRepo = new PgAppointmentRepository(pool);
    customerLoader = new PgCustomerLoader(pool);
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  /** A customer with a real job + appointment `daysAgo` in the past. */
  async function seedVisitor(
    tenant: TestTenant,
    firstName: string,
    lastName: string,
    daysAgo: number,
  ): Promise<string> {
    const customerId = uuidv4();
    await customerRepo.create({
      id: customerId,
      tenantId: tenant.tenantId,
      firstName,
      lastName,
      displayName: `${firstName} ${lastName}`,
      preferredChannel: 'email',
      smsConsent: false,
      isArchived: false,
      createdBy: tenant.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const locationId = uuidv4();
    await pool.query(
      `INSERT INTO service_locations (id, tenant_id, customer_id, street1, city, state, postal_code, country)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [locationId, tenant.tenantId, customerId, '1 Main St', 'Austin', 'TX', '78701', 'US'],
    );
    const jobId = uuidv4();
    await jobRepo.create({
      id: jobId,
      tenantId: tenant.tenantId,
      customerId,
      locationId,
      jobNumber: `JOB-${jobId.slice(0, 8)}`,
      summary: 'Review-matching fixture job',
      status: 'completed',
      priority: 'normal',
      createdBy: tenant.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const start = new Date(Date.now() - daysAgo * DAY_MS);
    await createAppointment(
      {
        tenantId: tenant.tenantId,
        jobId,
        scheduledStart: start,
        scheduledEnd: new Date(start.getTime() + 60 * 60 * 1000),
        timezone: 'America/Chicago',
        createdBy: tenant.userId,
      },
      appointmentRepo,
    );
    return customerId;
  }

  it('finds a candidate with a recent (within 60d) appointment, tenant-scoped', async () => {
    const tenant = await createTestTenant(pool);
    const customerId = await seedVisitor(tenant, 'Alice', 'Johnson', 10);

    const candidates = await customerLoader.findRecentCustomersWithName(
      tenant.tenantId,
      'Alice Johnson',
      60,
    );
    expect(candidates.map((c) => c.id)).toContain(customerId);
  });

  it('excludes a candidate whose only appointment is OUTSIDE the 60-day window', async () => {
    const tenant = await createTestTenant(pool);
    const staleCustomerId = await seedVisitor(tenant, 'Wanda', 'Stale', 90);

    const candidates = await customerLoader.findRecentCustomersWithName(
      tenant.tenantId,
      'Wanda Stale',
      60,
    );
    expect(candidates.map((c) => c.id)).not.toContain(staleCustomerId);
  });

  it('T1: an identically-named customer in a NEIGHBOUR tenant never surfaces as a candidate', async () => {
    const tenantA = await createTestTenant(pool);
    const neighbourTenant = await createTestTenant(pool);

    const aCustomerId = await seedVisitor(tenantA, 'Carlos', 'Diaz', 5);
    const neighbourCustomerId = await seedVisitor(neighbourTenant, 'Carlos', 'Diaz', 5);
    expect(aCustomerId).not.toBe(neighbourCustomerId);

    const candidatesForA = await customerLoader.findRecentCustomersWithName(
      tenantA.tenantId,
      'Carlos Diaz',
      60,
    );
    expect(candidatesForA.map((c) => c.id)).toContain(aCustomerId);
    expect(candidatesForA.map((c) => c.id)).not.toContain(neighbourCustomerId);
  });

  it('matchReviewerToCustomer, driven by the REAL PgCustomerLoader, resolves a confident match', async () => {
    const tenant = await createTestTenant(pool);
    const customerId = await seedVisitor(tenant, 'Priya', 'Nair', 20);

    const review: Review = {
      id: uuidv4(),
      tenantId: tenant.tenantId,
      externalReviewId: 'accounts/1/locations/1/reviews/match1',
      locationId: 'accounts/1/locations/1',
      reviewerDisplayName: 'Priya Nair',
      reviewerProfileUrl: null,
      rating: 1,
      commentText: 'Never showed up and never called.',
      createTime: new Date(),
      updateTime: null,
      firstFetchedAt: new Date(),
      lastFetchedAt: new Date(),
    };

    const matched = await matchReviewerToCustomer(review, { customerLoader });
    expect(matched?.customerId).toBe(customerId);
  });

  /**
   * Full classify → match → draft pipeline, with the match step driven by
   * real Postgres data (not an injected fake). classifyReview's regex path
   * handles this comment ("no-show" hits the high-precision complaint
   * regex) so no LLM call is needed; draftPublic/draftPrivate are faked
   * (they are LLM calls, already unit-tested in
   * test/reputation/draft-public-response.test.ts and
   * draft-private-followup.test.ts) so this test's only live dependency is
   * the database.
   */
  it('buildReviewResponseProposal: private follow-up + service credit target the REAL matched customer', async () => {
    const tenant = await createTestTenant(pool);
    const customerId = await seedVisitor(tenant, 'Devon', 'Marsh', 3);

    const review: Review = {
      id: uuidv4(),
      tenantId: tenant.tenantId,
      externalReviewId: 'accounts/1/locations/1/reviews/pipeline1',
      locationId: 'accounts/1/locations/1',
      reviewerDisplayName: 'Devon Marsh',
      reviewerProfileUrl: null,
      rating: 1,
      commentText: 'The tech never showed and never called to reschedule.',
      createTime: new Date(),
      updateTime: null,
      firstFetchedAt: new Date(),
      lastFetchedAt: new Date(),
    };

    const proposal = await buildReviewResponseProposal(review, {
      llmGateway: {} as unknown as LLMGateway,
      customerLoader,
      brandVoiceLoader: new NoopBrandVoiceLoader(),
      serviceCreditRepo: new InMemoryServiceCreditRepository(),
      draftPublic: async () => 'PUBLIC_DRAFT',
      draftPrivate: async () => 'PRIVATE_DRAFT',
    });

    // Regex classifier, not overridden — proves the real classification path.
    expect(proposal.classification).toBe('specific_complaint');
    expect(proposal.publicResponse.text).toBe('PUBLIC_DRAFT');
    // The private follow-up and credit both key off the customerId the REAL
    // PgCustomerLoader resolved, not a fixture id.
    expect(proposal.privateFollowUp).not.toBeNull();
    expect(proposal.privateFollowUp!.customerId).toBe(customerId);
    expect(proposal.privateFollowUp!.body).toBe('PRIVATE_DRAFT');
    expect(proposal.serviceCredit).not.toBeNull();
    expect(proposal.serviceCredit!.customerId).toBe(customerId);
    expect(proposal.serviceCredit!.amountCents).toBe(10000);
  });
});
