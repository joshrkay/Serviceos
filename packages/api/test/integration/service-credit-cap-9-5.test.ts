/**
 * Docker-gated integration test — PRD v5 §8.9 row 9.5, "service credits
 * without over-giving", at real Postgres.
 *
 * ROW CRITERION: "Given $80 already issued in 12 months and a $50 tier
 * proposed, when the cap applies, then the credit is OMITTED, not zeroed —
 * because proposing '$0 credit' is worse than proposing none."
 *
 * WHY THIS FILE EXISTS. The row's only evidence was
 * `test/reputation/pg-service-credit.test.ts`, whose own header calls itself a
 * "smoke test — exercises the query string + row mapping by stubbing
 * pool.connect()". A stubbed `pool.connect()` returns whatever the test says
 * it returns, so it can prove the SQL string was assembled and cannot prove
 * `service_credits` has an `issued_at` column, that `NOW() - INTERVAL '12
 * months'` excludes what the caller believes it excludes, or that the RLS
 * policy scopes the SUM. That is the exact failure mode CLAUDE.md names.
 *
 * WHAT IS WIRED (read 2026-09-12):
 *  - `PgServiceCreditRepository.sumIssuedInLast12Months`
 *    (src/reputation/pg-service-credit.ts:80) runs the rolling-window
 *    aggregate under `withTenant`, so RLS scopes it.
 *  - `buildReviewResponseProposal` (src/reputation/build-proposal.ts:141-163)
 *    calls it at DRAFT time, feeds the total to `applyCreditCap`
 *    (src/reputation/credit-tier.ts:74), and leaves `serviceCredit` at its
 *    `null` initialiser when the capped amount is 0 — the omission the row
 *    asks for. app.ts wires the Pg repo into both that path and
 *    `ReviewResponseExecutionHandler` (src/proposals/execution/review-response-handler.ts:121).
 *
 * MONEY-ADJACENT: this file ASSERTS the cap arithmetic, it does not change it.
 * `CREDIT_CAP_CENTS_PER_12_MONTHS` stays $100 and `applyCreditCap` stays
 * "strict overflow only" — both are read here, never redefined.
 *
 * Run: cd packages/api && RLS_RUNTIME_ROLE=true npx vitest run \
 *   --config vitest.integration.config.ts --reporter=verbose \
 *   test/integration/service-credit-cap-9-5.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb, TestTenant } from './shared';
import { PgCustomerRepository } from '../../src/customers/pg-customer';
import { PgProposalRepository } from '../../src/proposals/pg-proposal';
import { PgAuditRepository } from '../../src/audit/pg-audit';
import { PgServiceCreditRepository } from '../../src/reputation/pg-service-credit';
import { PgReviewRepository } from '../../src/reputation/pg-review';
import {
  applyCreditCap,
  creditTierForReview,
  CREDIT_CAP_CENTS_PER_12_MONTHS,
} from '../../src/reputation/credit-tier';
import { buildReviewResponseProposal } from '../../src/reputation/build-proposal';
import { NEUTRAL_BRAND_VOICE } from '../../src/reputation/brand-voice';
import type { Review } from '../../src/reputation/review';
import type { MatchedCustomer } from '../../src/reputation/match-customer';
import type { LLMGateway } from '../../src/ai/gateway/gateway';
import type { CustomerLoader } from '../../src/reputation/match-customer';
import { createProposal, Proposal } from '../../src/proposals/proposal';
import { InMemoryProposalExecutionRepository } from '../../src/proposals/proposal-execution';
import { transitionProposal, UNDO_WINDOW_MS } from '../../src/proposals/lifecycle';
import { ProposalExecutor } from '../../src/proposals/execution/executor';
import { IdempotencyGuard } from '../../src/proposals/execution/idempotency';
import {
  createExecutionHandlerRegistry,
  ExecutionContext,
} from '../../src/proposals/execution/handlers';

const DOLLARS_80 = 8000;
const DOLLARS_50 = 5000;
const DAY_MS = 24 * 60 * 60 * 1000;

interface SeededTenant {
  tenant: TestTenant;
  customerId: string;
  /** A persisted proposal row — `service_credits.proposal_id` has an FK to it. */
  anchorProposalId: string;
}

describe('Postgres integration — §8.9 row 9.5 service credits without over-giving', () => {
  let pool: Pool;
  let customerRepo: PgCustomerRepository;
  let proposalRepo: PgProposalRepository;
  let auditRepo: PgAuditRepository;
  let creditRepo: PgServiceCreditRepository;
  let reviewRepo: PgReviewRepository;
  let tenantA: SeededTenant;
  let tenantB: SeededTenant;

  async function seedTenant(label: string): Promise<SeededTenant> {
    const tenant = await createTestTenant(pool);
    const customerId = crypto.randomUUID();
    await customerRepo.create({
      id: customerId,
      tenantId: tenant.tenantId,
      firstName: label,
      lastName: 'Reviewer',
      displayName: `${label} Reviewer`,
      email: `${label.toLowerCase()}-${customerId.slice(0, 8)}@example.com`,
      preferredChannel: 'email',
      smsConsent: false,
      isArchived: false,
      createdBy: tenant.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const anchor = await proposalRepo.create(
      createProposal({
        tenantId: tenant.tenantId,
        proposalType: 'review_response_proposal',
        payload: { note: 'FK anchor for seeded credits' },
        summary: `${label} prior credit anchor`,
        createdBy: tenant.userId,
      }),
    );
    return { tenant, customerId, anchorProposalId: anchor.id };
  }

  /** Issue a credit through the REAL repository, at a chosen issuance date. */
  async function issueCredit(
    seeded: SeededTenant,
    amountCents: number,
    issuedAt: Date,
  ): Promise<string> {
    const credit = await creditRepo.create({
      tenantId: seeded.tenant.tenantId,
      customerId: seeded.customerId,
      amountCents,
      reviewId: null,
      proposalId: seeded.anchorProposalId,
      issuedAt,
    });
    return credit.id;
  }

  /** Raw ledger read — bypasses the repo so the assertion is about the table. */
  async function ledgerRows(
    tenantId: string,
  ): Promise<Array<{ id: string; amount_cents: string; issued_at: Date }>> {
    const { rows } = await pool.query(
      `SELECT id, amount_cents, issued_at FROM service_credits
        WHERE tenant_id = $1 ORDER BY issued_at`,
      [tenantId],
    );
    return rows;
  }

  /**
   * Persist the review. `service_credits.review_id` carries an FK to
   * `google_reviews(id)`, so a review that exists only in memory makes every
   * credit insert fail on that FK — and any "no credit was issued" assertion
   * would then pass for the wrong reason rather than because the cap held.
   */
  async function seedReview(seeded: SeededTenant): Promise<Review> {
    const now = new Date();
    const review: Review = {
      id: crypto.randomUUID(),
      tenantId: seeded.tenant.tenantId,
      externalReviewId: `accounts/a/locations/l/reviews/${crypto.randomUUID()}`,
      locationId: 'accounts/a/locations/l',
      reviewerDisplayName: 'A Reviewer',
      reviewerProfileUrl: null,
      // specific_complaint + 2 stars is the $50 tier (credit-tier.ts:47).
      rating: 2,
      commentText: 'The technician never showed up for the window I was given.',
      createTime: now,
      updateTime: null,
      firstFetchedAt: now,
      lastFetchedAt: now,
    };
    const { review: persisted } = await reviewRepo.upsert(review);
    return persisted;
  }

  /**
   * The orchestrator with its LLM/matcher seams stubbed (the override hooks
   * `BuildReviewResponseProposalDeps` declares for exactly this) and the
   * credit leg REAL: `PgServiceCreditRepository` against Postgres.
   */
  async function buildProposalPayload(seeded: SeededTenant) {
    const matched: MatchedCustomer = {
      customerId: seeded.customerId,
      firstName: 'A',
      lastName: 'Reviewer',
      lastVisitAt: new Date(Date.now() - 5 * DAY_MS),
      matchScore: 0.99,
    };
    return buildReviewResponseProposal(await seedReview(seeded), {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      llmGateway: {} as unknown as LLMGateway,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      customerLoader: {} as unknown as CustomerLoader,
      brandVoiceLoader: { load: async () => NEUTRAL_BRAND_VOICE },
      serviceCreditRepo: creditRepo,
      classifier: async () => ({
        classification: 'specific_complaint',
        confidence: 0.95,
        source: 'llm' as const,
      }),
      matcher: async () => matched,
      draftPublic: async () => 'We are sorry we missed your window.',
      draftPrivate: async () => 'Please let us make this right.',
    });
  }

  beforeAll(async () => {
    pool = await getSharedTestDb();
    customerRepo = new PgCustomerRepository(pool);
    proposalRepo = new PgProposalRepository(pool);
    auditRepo = new PgAuditRepository(pool);
    creditRepo = new PgServiceCreditRepository(pool);
    reviewRepo = new PgReviewRepository(pool);
    tenantA = await seedTenant('Alpha');
    tenantB = await seedTenant('Bravo');

    // Tenant A: $80 inside the rolling window, split across two issuances,
    // plus one $80 credit issued 13 months ago — outside the window.
    await issueCredit(tenantA, 5000, new Date(Date.now() - 30 * DAY_MS));
    await issueCredit(tenantA, 3000, new Date(Date.now() - 200 * DAY_MS));
    await issueCredit(tenantA, 8000, new Date(Date.now() - 396 * DAY_MS));

    // Tenant B: its OWN $80 inside the window, same shape, different tenant.
    await issueCredit(tenantB, 8000, new Date(Date.now() - 30 * DAY_MS));
  }, 120_000);

  afterAll(async () => {
    await closeSharedTestDb();
  });

  it('ASSERTS (unchanged): the cap is $100 per 12 months and $80 prior + a $50 tier overflows it, so the tier caps to 0', () => {
    expect(CREDIT_CAP_CENTS_PER_12_MONTHS).toBe(10000);
    expect(creditTierForReview('specific_complaint', 2)).toBe(DOLLARS_50);
    expect(applyCreditCap(DOLLARS_50, DOLLARS_80)).toBe(0);
    // The documented edge: landing EXACTLY on the cap is allowed.
    expect(applyCreditCap(DOLLARS_50, 5000)).toBe(DOLLARS_50);
  });

  it('CURRENT: sumIssuedInLast12Months at real Postgres counts only the in-window credits — $80, with the 13-month-old $80 excluded', async () => {
    const sum = await creditRepo.sumIssuedInLast12Months(
      tenantA.tenant.tenantId,
      tenantA.customerId,
    );
    expect(sum).toBe(DOLLARS_80);

    // The excluded row is really in the table — the window did the excluding,
    // not an empty ledger.
    const rows = await ledgerRows(tenantA.tenant.tenantId);
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => Number(r.amount_cents)).reduce((a, b) => a + b, 0)).toBe(16000);
  });

  it('CURRENT: with $80 in the window and a $50 tier, the built proposal OMITS the credit — serviceCredit is null, not an amountCents of 0', async () => {
    const payload = await buildProposalPayload(tenantA);

    expect(payload.serviceCredit).toBeNull();
    // The distinction the row exists for: nothing anywhere in the payload
    // offers the owner a zero-dollar credit to approve.
    expect(JSON.stringify(payload)).not.toContain('"amountCents":0');
    // The rest of the proposal is intact — omission is not suppression.
    expect(payload.publicResponse.text.length).toBeGreaterThan(0);
    expect(payload.privateFollowUp?.customerId).toBe(tenantA.customerId);
  });

  it('CURRENT: building that proposal leaves the ledger byte-identical — a capped draft issues nothing', async () => {
    const before = await ledgerRows(tenantA.tenant.tenantId);
    await buildProposalPayload(tenantA);
    const after = await ledgerRows(tenantA.tenant.tenantId);
    expect(after.map((r) => r.id)).toEqual(before.map((r) => r.id));
    expect(after.map((r) => Number(r.amount_cents))).toEqual(
      before.map((r) => Number(r.amount_cents)),
    );
  });

  it('CURRENT (T1): a neighbour tenant`s $80 does not count against this tenant — tenant B, with no prior credit of its own to tenant A`s customer, still gets the $50 tier', async () => {
    // Tenant A's ledger is invisible when summing for tenant B's own customer.
    const sumB = await creditRepo.sumIssuedInLast12Months(
      tenantB.tenant.tenantId,
      tenantB.customerId,
    );
    expect(sumB).toBe(DOLLARS_80);

    // Tenant B asking about TENANT A's customer sees zero — another tenant's
    // credits are not merely uncounted, they are unreadable.
    const crossTenant = await creditRepo.sumIssuedInLast12Months(
      tenantB.tenant.tenantId,
      tenantA.customerId,
    );
    expect(crossTenant).toBe(0);

    // And a tenant with a CLEAN customer still gets the full $50 tier, so the
    // omission above is the cap firing, not a global "credits never propose".
    const freshTenant = await seedTenant('Charlie');
    const payload = await buildProposalPayload(freshTenant);
    expect(payload.serviceCredit).toEqual({
      customerId: freshTenant.customerId,
      amountCents: DOLLARS_50,
      approved: false,
    });
    expect(await ledgerRows(freshTenant.tenant.tenantId)).toHaveLength(0);
  });

  it('CURRENT: executing the capped proposal through the production registry issues no credit, and the review_response.executed audit row reads back via findByEntity', async () => {
    const payload = await buildProposalPayload(tenantA);
    expect(payload.serviceCredit).toBeNull();

    const registry = createExecutionHandlerRegistry({
      serviceCreditRepo: creditRepo,
      auditRepo,
      // Present only so the handler reports isFullyWired(); with every
      // component unapproved, no sub-action reaches them.
      googleReplyResolver: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        resolve: async () => null as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
      reviewPrivateMessageSender: {
        send: async () => ({ ok: true as const, messageId: 'noop' }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
    });
    // The proposal is persisted to Postgres, not just held in memory:
    // `service_credits.proposal_id` has an FK to `proposals(id)`, so an
    // in-memory-only proposal would make every credit insert fail on the FK
    // and any "no credit was issued" assertion would pass for the wrong
    // reason. Same in the it.fails below.
    const guard = new IdempotencyGuard(new InMemoryProposalExecutionRepository(), proposalRepo);
    const executor = new ProposalExecutor(registry, proposalRepo, guard, auditRepo);

    let proposal: Proposal = createProposal({
      tenantId: tenantA.tenant.tenantId,
      proposalType: 'review_response_proposal',
      payload: payload as unknown as Record<string, unknown>,
      summary: 'Respond to the 2-star review',
      createdBy: tenantA.tenant.userId,
    });
    proposal = transitionProposal(proposal, 'ready_for_review', tenantA.tenant.userId);
    proposal = transitionProposal(proposal, 'approved', tenantA.tenant.userId);
    proposal = { ...proposal, approvedAt: new Date(Date.now() - UNDO_WINDOW_MS - 100) };
    await proposalRepo.create(proposal);

    const before = await ledgerRows(tenantA.tenant.tenantId);
    const context: ExecutionContext = {
      tenantId: tenantA.tenant.tenantId,
      executedBy: tenantA.tenant.userId,
    };
    const { result } = await executor.execute(proposal, context);
    expect(result.success).toBe(true);

    // The ledger is untouched — no $0 row, no row at all.
    const after = await ledgerRows(tenantA.tenant.tenantId);
    expect(after.map((r) => r.id)).toEqual(before.map((r) => r.id));

    const events = await auditRepo.findByEntity(
      tenantA.tenant.tenantId,
      'proposal',
      proposal.id,
    );
    expect(events.map((e) => e.eventType)).toContain('review_response.executed');
    const executed = events.find((e) => e.eventType === 'review_response.executed')!;
    expect(executed.metadata).toMatchObject({ proposalType: 'review_response_proposal' });
    // No credit sub-action ran.
    expect(
      (executed.metadata as { subResults?: Array<{ kind: string }> }).subResults ?? [],
    ).toEqual([]);

    // The neighbour tenant reads none of it.
    const crossTenant = await auditRepo.findByEntity(
      tenantB.tenant.tenantId,
      'proposal',
      proposal.id,
    );
    expect(crossTenant).toHaveLength(0);
  });

  /**
   * THE ROW'S REMAINING GAP. The cap is enforced at DRAFT time only — and
   * `build-proposal.ts`'s own header says so: "a delayed approval after a
   * separate credit was issued in the meantime is still capped at-execute by
   * the issuance path (today the handler does not re-check; documented as a
   * known trade-off in the handler)".
   *
   * That trade-off is exactly the over-giving the row exists to prevent: a
   * $50 credit drafted while the customer sat at $40, approved a week later
   * after another $50 landed, executes into a ledger $100 over the cap. The
   * handler's `executeServiceCredit` (review-response-handler.ts:340) inserts
   * whatever the payload carries, with no re-read of the rolling sum.
   *
   * Whether to close it (re-check at execute) or keep it (draft-time only,
   * accepted) is Josh's call — see the drafted issue in the lane report.
   */
  it.fails(
    'DESIRED (row 9.5): a $50 credit approved after the customer crossed the cap is refused at EXECUTION time too, not just omitted at draft time',
    async () => {
      const seeded = await seedTenant('Delta');
      // Drafted when the customer sat at $40 — under the cap, so a $50 credit
      // is legitimately proposed.
      await issueCredit(seeded, 4000, new Date(Date.now() - 10 * DAY_MS));
      const payload = await buildProposalPayload(seeded);
      expect(payload.serviceCredit?.amountCents).toBe(DOLLARS_50);

      // …then another $50 is issued before the owner gets round to approving.
      await issueCredit(seeded, DOLLARS_50, new Date(Date.now() - 1 * DAY_MS));
      expect(
        await creditRepo.sumIssuedInLast12Months(seeded.tenant.tenantId, seeded.customerId),
      ).toBe(9000);

      const registry = createExecutionHandlerRegistry({
        serviceCreditRepo: creditRepo,
        auditRepo,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        googleReplyResolver: { resolve: async () => null as any } as any,
        reviewPrivateMessageSender: {
          send: async () => ({ ok: true as const, messageId: 'noop' }),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any,
      });
      const guard = new IdempotencyGuard(new InMemoryProposalExecutionRepository(), proposalRepo);
      const executor = new ProposalExecutor(registry, proposalRepo, guard, auditRepo);

      const approvedPayload = {
        ...payload,
        serviceCredit: { ...payload.serviceCredit!, approved: true },
      };
      let proposal: Proposal = createProposal({
        tenantId: seeded.tenant.tenantId,
        proposalType: 'review_response_proposal',
        payload: approvedPayload as unknown as Record<string, unknown>,
        summary: 'Respond, with the credit approved',
        createdBy: seeded.tenant.userId,
      });
      proposal = transitionProposal(proposal, 'ready_for_review', seeded.tenant.userId);
      proposal = transitionProposal(proposal, 'approved', seeded.tenant.userId);
      proposal = { ...proposal, approvedAt: new Date(Date.now() - UNDO_WINDOW_MS - 100) };
      await proposalRepo.create(proposal);

      await executor.execute(proposal, {
        tenantId: seeded.tenant.tenantId,
        executedBy: seeded.tenant.userId,
      });

      // DESIRED: the rolling total never exceeds the cap.
      const total = await creditRepo.sumIssuedInLast12Months(
        seeded.tenant.tenantId,
        seeded.customerId,
      );
      expect(total).toBeLessThanOrEqual(CREDIT_CAP_CENTS_PER_12_MONTHS);
    },
  );
});
