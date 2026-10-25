/**
 * OBS-2 — an AI-drafted proposal joins to the model run that authored it, and
 * that run is findable from the conversation, against real Postgres.
 *
 * Before: drafting handlers passed no gateway metadata (ai_runs.correlation_id
 * was a random uuid — no key back to the conversation) and set no aiRunId
 * (proposals.ai_run_id NULL for every chat- and memo-drafted proposal).
 *
 * Drives the real EstimateTaskHandler through a real LLMGateway wired with
 * PgAiRunRepository (so the completion writes an ai_runs row and returns its
 * id), persists through PgProposalRepository (the FK proposals.ai_run_id →
 * ai_runs(id) is enforced), and proves:
 *   - the persisted proposal's ai_run_id resolves to that ai_runs row;
 *   - the row's correlation_id is the conversation id, so "every AI run on
 *     this conversation" is one indexed-column query, not a timestamp guess;
 *   - a second tenant's query finds nothing (tenant-scoped).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { Pool } from 'pg';
import { getSharedTestDb, createTestTenant } from './shared';
import { PgProposalRepository } from '../../src/proposals/pg-proposal';
import { PgAiRunRepository } from '../../src/ai/pg-ai-run';
import { LLMGateway, type LLMProvider, type LLMRequest, type LLMResponse } from '../../src/ai/gateway/gateway';
import { EstimateTaskHandler } from '../../src/ai/tasks/estimate-task';
import { RespondToReviewTaskHandler } from '../../src/ai/tasks/review-response-task';
import { runGoogleReviewsSweep } from '../../src/workers/google-reviews';
import { PgReviewRepository } from '../../src/reputation/pg-review';
import { InMemoryReviewPollStateRepository } from '../../src/reputation/poll-state';
import { NoopBrandVoiceLoader } from '../../src/reputation/brand-voice';
import { InMemoryServiceCreditRepository } from '../../src/reputation/service-credit';
import type { BuildReviewResponseProposalDeps } from '../../src/reputation/build-proposal';
import { createLogger } from '../../src/logging/logger';
import { classifyIntent } from '../../src/ai/orchestration/intent-classifier';

describe('OBS-2 — proposals.ai_run_id → the drafting run, keyed to the conversation (Postgres)', () => {
  let pool: Pool;
  let tenant: { tenantId: string; userId: string };

  beforeAll(async () => {
    pool = await getSharedTestDb();
    tenant = await createTestTenant(pool);
  });

  function gateway(): LLMGateway {
    const provider: LLMProvider = {
      name: 'stub',
      isAvailable: async () => true,
      complete: async (_req: LLMRequest): Promise<LLMResponse> => ({
        content: JSON.stringify({
          lineItems: [{ description: 'Capacitor replacement', quantity: 1, unitPrice: 18900 }],
          confidence_score: 0.8,
        }),
        model: 'stub-model',
        provider: 'stub',
        tokenUsage: { input: 10, output: 5, total: 15 },
        latencyMs: 1,
      }),
    };
    return new LLMGateway(
      { defaultProvider: 'stub' },
      new Map([['stub', provider]]),
      undefined,
      new PgAiRunRepository(pool),
    );
  }

  it('the persisted proposal joins to its drafting run, whose correlation_id is the conversation', async () => {
    const conversationId = crypto.randomUUID();
    const { proposal } = await new EstimateTaskHandler(gateway()).handle({
      tenantId: tenant.tenantId,
      userId: tenant.userId,
      message: 'Quote a capacitor replacement',
      conversationId,
      customerId: crypto.randomUUID(),
    });
    expect(proposal.aiRunId).toBeDefined();

    // The FK is enforced here: a made-up id would make this insert throw.
    await new PgProposalRepository(pool).create(proposal);

    const { rows } = await pool.query(
      `SELECT r.id, r.task_type, r.correlation_id
         FROM proposals p JOIN ai_runs r ON r.id = p.ai_run_id
        WHERE p.tenant_id = $1 AND p.id = $2`,
      [tenant.tenantId, proposal.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].task_type).toBe('draft_estimate');
    expect(rows[0].correlation_id).toBe(conversationId);

    // "Every AI run on this conversation" — one keyed query.
    const { rows: onConversation } = await pool.query(
      `SELECT id FROM ai_runs WHERE tenant_id = $1 AND correlation_id = $2`,
      [tenant.tenantId, conversationId],
    );
    expect(onConversation.map((r) => r.id)).toEqual([proposal.aiRunId]);

    const other = await createTestTenant(pool);
    const { rows: foreign } = await pool.query(
      `SELECT id FROM ai_runs WHERE tenant_id = $1 AND correlation_id = $2`,
      [other.tenantId, conversationId],
    );
    expect(foreign).toEqual([]);
  });

  // B3 — a chat correction ("no, make it …") and an entity-pick re-draft
  // rewrite the SAME row with a fresh draft through the generic update. The
  // row must then join to the run that authored the new payload, and a fresh
  // draft with no persisted run must clear the link rather than keep naming
  // the first run (the FK makes a made-up id impossible either way).
  it('a rewrite through the generic update re-points ai_run_id to the fresh draft run, or clears it', async () => {
    const repo = new PgProposalRepository(pool);
    const conversationId = crypto.randomUUID();
    const draft = (message: string) =>
      new EstimateTaskHandler(gateway()).handle({
        tenantId: tenant.tenantId,
        userId: tenant.userId,
        message,
        conversationId,
        customerId: crypto.randomUUID(),
      });
    const { proposal: first } = await draft('Quote a capacitor replacement');
    await repo.create(first);
    const { proposal: correction } = await draft('no, make it two capacitors');
    expect(correction.aiRunId).toBeDefined();
    expect(correction.aiRunId).not.toBe(first.aiRunId);

    await repo.update(tenant.tenantId, first.id, {
      payload: correction.payload,
      aiRunId: correction.aiRunId,
      confidenceFactors: correction.confidenceFactors,
      explanation: correction.explanation,
    });
    const { rows } = await pool.query(
      `SELECT ai_run_id, confidence_factors FROM proposals WHERE tenant_id = $1 AND id = $2`,
      [tenant.tenantId, first.id],
    );
    expect(rows[0].ai_run_id).toBe(correction.aiRunId);
    expect(rows[0].confidence_factors).toEqual(correction.confidenceFactors ?? null);

    await repo.update(tenant.tenantId, first.id, { aiRunId: undefined });
    expect((await repo.findById(tenant.tenantId, first.id))?.aiRunId).toBeUndefined();
  });

  // OBS-2 — the two review_response_proposal creators. Their payload comes from
  // up to three runs (classification, public reply, private follow-up); the
  // proposal joins to the public-reply run, and every run in the draft shares
  // the creator's correlation_id.
  const REPLIES: Record<string, string> = {
    review_classify: JSON.stringify({ classification: 'vague_complaint', confidence: 0.9 }),
    review_public_response: 'Sorry the visit fell short — please reach out so we can make it right.',
  };

  function reviewGateway(): LLMGateway {
    const provider: LLMProvider = {
      name: 'stub',
      isAvailable: async () => true,
      complete: async (req: LLMRequest): Promise<LLMResponse> => ({
        content: REPLIES[req.taskType] ?? '{}',
        model: 'stub-model',
        provider: 'stub',
        tokenUsage: { input: 10, output: 5, total: 15 },
        latencyMs: 1,
      }),
    };
    return new LLMGateway(
      { defaultProvider: 'stub' },
      new Map([['stub', provider]]),
      undefined,
      new PgAiRunRepository(pool),
    );
  }

  function reviewDraftDeps(): BuildReviewResponseProposalDeps {
    return {
      llmGateway: reviewGateway(),
      // No matched customer: classification + public reply only.
      customerLoader: { findRecentCustomersWithName: async () => [] },
      brandVoiceLoader: new NoopBrandVoiceLoader(),
      serviceCreditRepo: new InMemoryServiceCreditRepository(),
    };
  }

  async function runsOn(tenantId: string, correlationId: string) {
    const { rows } = await pool.query(
      `SELECT id, task_type FROM ai_runs WHERE tenant_id = $1 AND correlation_id = $2 ORDER BY created_at, task_type`,
      [tenantId, correlationId],
    );
    return rows as Array<{ id: string; task_type: string }>;
  }

  it('a spoken review response joins to its public-reply run, keyed with the rest of the draft to the conversation', async () => {
    const reviewTenant = await createTestTenant(pool);
    const reviewRepo = new PgReviewRepository(pool);
    const now = new Date();
    const { review } = await reviewRepo.upsert({
      id: crypto.randomUUID(),
      tenantId: reviewTenant.tenantId,
      externalReviewId: `accounts/A/locations/L/reviews/${crypto.randomUUID()}`,
      locationId: 'accounts/A/locations/L',
      reviewerDisplayName: 'Maria Alvarez',
      reviewerProfileUrl: null,
      rating: 2,
      commentText: 'It was okay I suppose',
      createTime: new Date(now.getTime() - 60 * 60 * 1000),
      updateTime: null,
      firstFetchedAt: now,
      lastFetchedAt: now,
    });
    const repo = new PgProposalRepository(pool);
    const conversationId = crypto.randomUUID();
    const { proposal } = await new RespondToReviewTaskHandler(repo, reviewRepo, reviewDraftDeps()).handle({
      tenantId: reviewTenant.tenantId,
      userId: reviewTenant.userId,
      message: 'Respond to that 2-star review',
      existingEntities: { reviewReference: 'that 2-star review' },
      conversationId,
    });
    expect(proposal.proposalType).toBe('review_response_proposal');
    expect(proposal.aiRunId).toBeDefined();
    await repo.create(proposal); // the FK is enforced here

    const { rows } = await pool.query(
      `SELECT r.task_type, r.correlation_id
         FROM proposals p JOIN ai_runs r ON r.id = p.ai_run_id
        WHERE p.tenant_id = $1 AND p.id = $2`,
      [reviewTenant.tenantId, proposal.id],
    );
    expect(rows).toEqual([{ task_type: 'review_public_response', correlation_id: conversationId }]);
    expect((await runsOn(reviewTenant.tenantId, conversationId)).map((r) => r.task_type).sort()).toEqual([
      'review_classify',
      'review_public_response',
    ]);
  });

  it('a polled review response joins to its public-reply run, keyed with the rest of the draft to the review', async () => {
    const reviewTenant = await createTestTenant(pool);
    const reviewRepo = new PgReviewRepository(pool);
    const proposalRepo = new PgProposalRepository(pool);
    const externalReviewId = `accounts/A/locations/L/reviews/${crypto.randomUUID()}`;
    const updateTime = new Date().toISOString();
    const result = await runGoogleReviewsSweep({
      reviewRepo,
      pollStateRepo: new InMemoryReviewPollStateRepository(),
      credentialResolver: {
        async getCredential(tenantId: string) {
          return {
            tenant_id: tenantId,
            provider: 'google_business',
            credentials: { accessToken: 'at', providerData: { accountId: 'A', locationId: 'L' } },
            credential_version: 1,
          };
        },
        async close() {},
      },
      listTenantIds: async () => [reviewTenant.tenantId],
      logger: createLogger({ service: 'test', environment: 'test', level: 'error' }),
      fetchFn: async () =>
        new Response(
          JSON.stringify({
            reviews: [
              {
                name: externalReviewId,
                reviewer: { displayName: 'Maria Alvarez' },
                starRating: 'TWO',
                comment: 'It was okay I suppose',
                createTime: updateTime,
                updateTime,
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      proposalEmission: { proposalRepo, buildProposalDeps: reviewDraftDeps() },
    });
    expect(result.proposalsEmitted).toBe(1);

    const review = await reviewRepo.findByExternalId(reviewTenant.tenantId, externalReviewId);
    expect(review).not.toBeNull();
    const { rows } = await pool.query(
      `SELECT p.target_entity_id, r.task_type, r.correlation_id
         FROM proposals p JOIN ai_runs r ON r.id = p.ai_run_id
        WHERE p.tenant_id = $1 AND p.proposal_type = 'review_response_proposal'`,
      [reviewTenant.tenantId],
    );
    expect(rows).toEqual([
      { target_entity_id: review!.id, task_type: 'review_public_response', correlation_id: review!.id },
    ]);
    expect((await runsOn(reviewTenant.tenantId, review!.id)).map((r) => r.task_type).sort()).toEqual([
      'review_classify',
      'review_public_response',
    ]);
  });

  // OBS-2 — the routing decision is found with the runs it led to: the
  // classifier's run on a conversation carries the conversation as its
  // correlation_id, the same key as the drafting run it routed to.
  it("every AI run on a conversation includes the classifier's", async () => {
    const provider: LLMProvider = {
      name: 'stub',
      isAvailable: async () => true,
      complete: async (req: LLMRequest): Promise<LLMResponse> => ({
        content:
          req.taskType === 'classify_intent'
            ? JSON.stringify({ intentType: 'draft_estimate', confidence: 0.95, extractedEntities: {} })
            : JSON.stringify({
                lineItems: [{ description: 'Capacitor replacement', quantity: 1, unitPrice: 18900 }],
                confidence_score: 0.8,
              }),
        model: 'stub-model',
        provider: 'stub',
        tokenUsage: { input: 10, output: 5, total: 15 },
        latencyMs: 1,
      }),
    };
    const gw = new LLMGateway(
      { defaultProvider: 'stub' },
      new Map([['stub', provider]]),
      undefined,
      new PgAiRunRepository(pool),
    );
    const conversationId = crypto.randomUUID();
    const classification = await classifyIntent(
      'Quote a capacitor replacement',
      { tenantId: tenant.tenantId, sessionId: conversationId },
      gw,
    );
    expect(classification.aiRunId).toBeDefined();
    const { proposal } = await new EstimateTaskHandler(gw).handle({
      tenantId: tenant.tenantId,
      userId: tenant.userId,
      message: 'Quote a capacitor replacement',
      conversationId,
      customerId: crypto.randomUUID(),
    });

    const { rows } = await pool.query(
      `SELECT id, task_type FROM ai_runs WHERE tenant_id = $1 AND correlation_id = $2 ORDER BY task_type`,
      [tenant.tenantId, conversationId],
    );
    expect(rows).toEqual([
      { id: classification.aiRunId, task_type: 'classify_intent' },
      { id: proposal.aiRunId, task_type: 'draft_estimate' },
    ]);
  });
});
