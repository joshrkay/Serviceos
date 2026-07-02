/**
 * U3 — respond_to_review voice on-ramp (task-handler level).
 *
 * The handler resolves "that 1-star review" deterministically against
 * ReviewRepository.findRecent, dedups against the polling worker's pending
 * auto-draft, and drafts via buildReviewResponseProposal with the SAME dep
 * bundle google-reviews wires (here with the override hooks the orchestrator
 * exposes, so no live LLM/matcher is needed).
 */
import { describe, expect, it, vi } from 'vitest';
import {
  RespondToReviewTaskHandler,
  parseStatedRating,
  REVIEW_LOOKBACK_MS,
} from '../../../src/ai/tasks/review-response-task';
import { TaskContext } from '../../../src/ai/tasks/task-handlers';
import {
  InMemoryProposalRepository,
  createProposal,
} from '../../../src/proposals/proposal';
import {
  InMemoryReviewRepository,
  Review,
} from '../../../src/reputation/review';
import type { BuildReviewResponseProposalDeps } from '../../../src/reputation/build-proposal';
import type { LLMGateway } from '../../../src/ai/gateway/gateway';

const NOW = new Date('2026-07-02T12:00:00Z');

function ctx(overrides: Partial<TaskContext> = {}): TaskContext {
  return {
    tenantId: 't-1',
    userId: 'u-1',
    message: 'Respond to that 1-star review',
    ...overrides,
  };
}

function review(overrides: Partial<Review>): Review {
  return {
    id: overrides.id ?? crypto.randomUUID(),
    tenantId: 't-1',
    externalReviewId: overrides.externalReviewId ?? `ext-${Math.random()}`,
    locationId: 'accounts/a/locations/l',
    reviewerDisplayName: 'Maria Alvarez',
    reviewerProfileUrl: null,
    rating: 1,
    commentText: 'Terrible service',
    createTime: new Date(NOW.getTime() - 24 * 60 * 60 * 1000),
    updateTime: null,
    firstFetchedAt: NOW,
    lastFetchedAt: NOW,
    ...overrides,
  };
}

/**
 * Draft deps with every LLM/matcher edge overridden — mirrors the override
 * hooks BuildReviewResponseProposalDeps exposes for tests.
 */
function draftDeps(overrides: Partial<BuildReviewResponseProposalDeps> = {}): BuildReviewResponseProposalDeps {
  return {
    llmGateway: {} as LLMGateway,
    customerLoader: { findCandidates: vi.fn(async () => []) } as never,
    brandVoiceLoader: { load: vi.fn(async () => ({ tone: 'neutral' })) } as never,
    serviceCreditRepo: { sumIssuedInLast12Months: vi.fn(async () => 0) } as never,
    classifier: async () => ({ classification: 'vague_complaint', confidence: 1, source: 'regex' }) as never,
    matcher: async () => null,
    draftPublic: vi.fn(async () => 'We are sorry — please reach out so we can make it right.'),
    ...overrides,
  };
}

async function seedReviews(repo: InMemoryReviewRepository, reviews: Review[]): Promise<void> {
  for (const r of reviews) await repo.upsert(r);
}

describe('parseStatedRating', () => {
  it('parses digit and word star counts, undefined otherwise', () => {
    expect(parseStatedRating('the 1-star from yesterday')).toBe(1);
    expect(parseStatedRating('that 2 star review')).toBe(2);
    expect(parseStatedRating('the one-star review')).toBe(1);
    expect(parseStatedRating('that three star rant')).toBe(3);
    expect(parseStatedRating('the bad review')).toBeUndefined();
    expect(parseStatedRating(undefined)).toBeUndefined();
  });
});

describe('RespondToReviewTaskHandler', () => {
  it('exactly one recent low review → drafts a review_response_proposal with idempotency key', async () => {
    const proposalRepo = new InMemoryProposalRepository();
    const reviewRepo = new InMemoryReviewRepository();
    const target = review({ id: 'rev-1' });
    await seedReviews(reviewRepo, [target]);

    const handler = new RespondToReviewTaskHandler(
      proposalRepo,
      reviewRepo,
      draftDeps(),
      () => NOW,
    );
    const res = await handler.handle(
      ctx({ existingEntities: { reviewReference: 'that 1-star review' } }),
    );

    expect(res.taskType).toBe('review_response_proposal');
    expect(res.proposal.proposalType).toBe('review_response_proposal');
    expect(res.proposal.payload.reviewId).toBe('rev-1');
    expect(
      (res.proposal.payload.publicResponse as { text: string; approved: boolean }).approved,
    ).toBe(false);
    expect(res.proposal.idempotencyKey).toBe('review_response:rev-1');
    expect(res.proposal.targetEntityId).toBe('rev-1');
    // Comms class — never auto-approves; no trust tier passed either.
    expect(res.proposal.status).toBe('draft');
  });

  it('stated star count filters the candidate set (1-star ignores a 3-star)', async () => {
    const proposalRepo = new InMemoryProposalRepository();
    const reviewRepo = new InMemoryReviewRepository();
    const oneStar = review({ id: 'rev-1', rating: 1 });
    const threeStar = review({ id: 'rev-3', rating: 3, reviewerDisplayName: 'Bob' });
    await seedReviews(reviewRepo, [oneStar, threeStar]);

    const handler = new RespondToReviewTaskHandler(proposalRepo, reviewRepo, draftDeps(), () => NOW);
    const res = await handler.handle(
      ctx({ existingEntities: { reviewReference: 'the 1-star from yesterday' } }),
    );

    // Without the rating filter this would be ambiguous (two matches ≤3).
    expect(res.proposal.proposalType).toBe('review_response_proposal');
    expect(res.proposal.payload.reviewId).toBe('rev-1');
  });

  it('0 matches → voice_clarification ("no recent low review")', async () => {
    const proposalRepo = new InMemoryProposalRepository();
    const reviewRepo = new InMemoryReviewRepository();
    // A 5-star and a stale low review — neither matches the default window.
    await seedReviews(reviewRepo, [
      review({ id: 'rev-good', rating: 5 }),
      review({
        id: 'rev-old',
        rating: 1,
        createTime: new Date(NOW.getTime() - REVIEW_LOOKBACK_MS - 1000),
      }),
    ]);

    const handler = new RespondToReviewTaskHandler(proposalRepo, reviewRepo, draftDeps(), () => NOW);
    const res = await handler.handle(ctx({ existingEntities: { reviewReference: 'that bad review' } }));

    expect(res.taskType).toBe('voice_clarification');
    expect(res.proposal.payload.reason).toBe('missing_entities');
    expect(String(res.proposal.payload.classifierReasoning)).toMatch(/no recent low review/i);
  });

  it('2+ plausible reviews → clarification with a candidate picker (reviewer + rating + date)', async () => {
    const proposalRepo = new InMemoryProposalRepository();
    const reviewRepo = new InMemoryReviewRepository();
    await seedReviews(reviewRepo, [
      review({ id: 'rev-a', rating: 1, reviewerDisplayName: 'Maria Alvarez' }),
      review({ id: 'rev-b', rating: 2, reviewerDisplayName: 'Bob Stone' }),
    ]);

    const handler = new RespondToReviewTaskHandler(proposalRepo, reviewRepo, draftDeps(), () => NOW);
    const res = await handler.handle(ctx({ existingEntities: { reviewReference: 'the bad review' } }));

    expect(res.taskType).toBe('voice_clarification');
    const payload = res.proposal.payload as {
      reason: string;
      entityCandidates: Array<{ id: string; label: string; hint?: string }>;
    };
    expect(payload.reason).toBe('ambiguous_entity');
    expect(payload.entityCandidates).toHaveLength(2);
    const labels = payload.entityCandidates.map((c) => c.label);
    expect(labels).toContain('Maria Alvarez');
    expect(labels).toContain('Bob Stone');
    for (const c of payload.entityCandidates) {
      expect(c.hint).toMatch(/[12]★ · \d{4}-\d{2}-\d{2}/);
    }
  });

  it('pending auto-draft for the same review → "already in your inbox" clarification, no duplicate', async () => {
    const proposalRepo = new InMemoryProposalRepository();
    const reviewRepo = new InMemoryReviewRepository();
    const target = review({ id: 'rev-1' });
    await seedReviews(reviewRepo, [target]);
    // Simulate the google-reviews worker's auto-draft sitting in the queue.
    await proposalRepo.create(
      createProposal({
        tenantId: 't-1',
        proposalType: 'review_response_proposal',
        payload: {
          reviewId: 'rev-1',
          classification: 'vague_complaint',
          publicResponse: { text: 'draft', approved: false },
          privateFollowUp: null,
          serviceCredit: null,
        },
        summary: 'Respond to 1★ review',
        createdBy: 'system:google-reviews-worker',
      }),
    );

    const draft = draftDeps();
    const handler = new RespondToReviewTaskHandler(proposalRepo, reviewRepo, draft, () => NOW);
    const res = await handler.handle(ctx({ existingEntities: { reviewReference: 'that 1-star review' } }));

    expect(res.taskType).toBe('voice_clarification');
    expect(String(res.proposal.payload.classifierReasoning)).toMatch(/already in your inbox/i);
    // No second draft was built.
    expect(draft.draftPublic).not.toHaveBeenCalled();
  });

  it('LLM/drafting failure → clarification, never a dropped utterance', async () => {
    const proposalRepo = new InMemoryProposalRepository();
    const reviewRepo = new InMemoryReviewRepository();
    await seedReviews(reviewRepo, [review({ id: 'rev-1' })]);

    const handler = new RespondToReviewTaskHandler(
      proposalRepo,
      reviewRepo,
      draftDeps({
        draftPublic: vi.fn(async () => {
          throw new Error('LLM down');
        }),
      }),
      () => NOW,
    );
    const res = await handler.handle(ctx({ existingEntities: { reviewReference: 'that 1-star review' } }));

    expect(res.taskType).toBe('voice_clarification');
    expect(String(res.proposal.payload.classifierReasoning)).toMatch(/could not draft/i);
  });

  it('no review repo wired → clarification (never a crash)', async () => {
    const handler = new RespondToReviewTaskHandler(new InMemoryProposalRepository());
    const res = await handler.handle(ctx({ existingEntities: { reviewReference: 'that review' } }));
    expect(res.taskType).toBe('voice_clarification');
  });
});

describe('InMemoryReviewRepository.findRecent', () => {
  it('filters by maxRating + since, newest first, capped at limit', async () => {
    const repo = new InMemoryReviewRepository();
    const day = 24 * 60 * 60 * 1000;
    await seedReviews(repo, [
      review({ id: 'r5', rating: 5, createTime: new Date(NOW.getTime() - 1 * day) }),
      review({ id: 'r1-old', rating: 1, createTime: new Date(NOW.getTime() - 30 * day) }),
      review({ id: 'r2', rating: 2, createTime: new Date(NOW.getTime() - 2 * day) }),
      review({ id: 'r3', rating: 3, createTime: new Date(NOW.getTime() - 1 * day) }),
      review({ id: 'r1', rating: 1, createTime: new Date(NOW.getTime() - 3 * day) }),
    ]);

    const since = new Date(NOW.getTime() - 14 * day);
    const found = await repo.findRecent('t-1', { maxRating: 3, since, limit: 2 });
    // Newest first: r3 (1 day) then r2 (2 days); r1 trimmed by limit; r5
    // rating-filtered; r1-old window-filtered.
    expect(found.map((r) => r.id)).toEqual(['r3', 'r2']);

    const all = await repo.findRecent('t-1', { limit: 10 });
    expect(all.map((r) => r.id)).toEqual(['r5', 'r3', 'r2', 'r1', 'r1-old']);
  });

  it('is tenant-scoped', async () => {
    const repo = new InMemoryReviewRepository();
    await seedReviews(repo, [review({ id: 'r1' })]);
    expect(await repo.findRecent('t-OTHER', { limit: 5 })).toEqual([]);
  });
});
