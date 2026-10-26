/**
 * OBS-2 — an AI-drafted proposal is traceable to the model run that authored
 * it, and that run is findable from the conversation.
 *
 * Before: every drafting handler called `gateway.complete` with no metadata,
 * so the ai_runs row got a random correlation_id (no join key back to the
 * conversation or recording), and no handler set `aiRunId` on its
 * CreateProposalInput — proposals.ai_run_id was NULL for every chat- and
 * memo-drafted proposal. "Why did the AI quote $X on this conversation?"
 * could only be answered by guessing on timestamps.
 *
 * After: one helper (task-handlers.ts `draftingRunMetadata`) keys the run's
 * correlation_id to the conversation (or the recording, for a memo with no
 * conversation), and each handler links the run that authored the payload —
 * only when the gateway actually persisted one (the FK needs a real row).
 *
 * Every drafting handler, table-driven, with a mocked gateway.
 */
import { describe, it, expect, vi } from 'vitest';
import type { LLMGateway, LLMRequest, LLMResponse } from '../../../src/ai/gateway/gateway';
import type { TaskContext, TaskHandler } from '../../../src/ai/tasks/task-handlers';
import type { Proposal } from '../../../src/proposals/proposal';
import { EstimateTaskHandler } from '../../../src/ai/tasks/estimate-task';
import { EstimateEditTaskHandler } from '../../../src/ai/tasks/estimate-edit-task';
import { InvoiceTaskHandler } from '../../../src/ai/tasks/invoice-task';
import { InvoiceEditTaskHandler } from '../../../src/ai/tasks/invoice-edit-task';
import { UpdateJobTaskHandler } from '../../../src/ai/tasks/job-edit-task';
import { CreateAppointmentAITaskHandler } from '../../../src/ai/tasks/create-appointment-task';
import { SendCustomerMessageTaskHandler } from '../../../src/ai/tasks/send-customer-message-task';
import { CreateStandingInstructionTaskHandler } from '../../../src/ai/tasks/standing-instruction-task';
import { UpdateBrandVoiceTaskHandler } from '../../../src/ai/tasks/brand-voice-task';
import { MmsEstimateTaskHandler } from '../../../src/ai/tasks/mms-estimate-task';

const TENANT = 'tenant-obs2';
const CUSTOMER = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const RUN_ID = 'run-obs2-1';

const REPLIES: Record<string, string> = {
  draft_estimate: JSON.stringify({
    lineItems: [{ description: 'Capacitor replacement', quantity: 1, unitPrice: 18900 }],
    confidence_score: 0.8,
  }),
  update_estimate: JSON.stringify({
    estimateReference: 'EST-0001',
    editActions: [{ type: 'remove_line_item', description: 'disposal fee' }],
    confidence_score: 0.8,
  }),
  draft_invoice: JSON.stringify({
    lineItems: [{ description: 'Capacitor replacement', quantity: 1, unitPrice: 18900 }],
    confidence_score: 0.8,
  }),
  update_invoice: JSON.stringify({
    invoiceReference: 'INV-0042',
    editActions: [{ type: 'remove_line_item', description: 'trip fee' }],
    confidence_score: 0.8,
  }),
  update_job: JSON.stringify({ jobReference: 'the Miller job', status: 'completed', confidence_score: 0.8 }),
  create_appointment: JSON.stringify({
    customerName: 'Mrs Lee',
    scheduledStart: '2026-11-03T21:00:00Z',
    scheduledEnd: '2026-11-03T22:00:00Z',
    confidence_score: 0.8,
  }),
  send_customer_message: 'Running about 20 minutes late, sorry!',
  create_standing_instruction: JSON.stringify({ instruction: 'Always mention the 1-year warranty' }),
  update_brand_voice: JSON.stringify({ register: 'friendly', confidence_score: 0.8 }),
  mms_estimate: JSON.stringify({
    lineItems: [{ description: 'Water heater replacement', quantity: 1, unitPrice: 150000 }],
    confidence_score: 0.8,
  }),
};

function capturingGateway(withRunId = true): { gateway: LLMGateway; requests: LLMRequest[] } {
  const requests: LLMRequest[] = [];
  const gateway = {
    complete: vi.fn(async (req: LLMRequest): Promise<LLMResponse> => {
      requests.push(req);
      return {
        content: REPLIES[req.taskType] ?? '{}',
        model: 'mock',
        provider: 'mock',
        tokenUsage: { input: 1, output: 1, total: 2 },
        latencyMs: 1,
        ...(withRunId ? { aiRunId: RUN_ID } : {}),
      };
    }),
  } as unknown as LLMGateway;
  return { gateway, requests };
}

const baseContext = (overrides: Partial<TaskContext> = {}): TaskContext => ({
  tenantId: TENANT,
  userId: 'user-obs2',
  message: 'do the thing',
  conversationId: 'conv-obs2',
  customerId: CUSTOMER,
  timezone: 'America/Phoenix',
  now: new Date('2026-11-01T12:00:00Z'),
  ...overrides,
});

interface Case {
  name: string;
  run: (gateway: LLMGateway, context: TaskContext) => Promise<Proposal>;
  context?: Partial<TaskContext>;
}

const viaHandler =
  (make: (g: LLMGateway) => TaskHandler) =>
  async (gateway: LLMGateway, context: TaskContext) =>
    (await make(gateway).handle(context)).proposal;

const CASES: Case[] = [
  { name: 'draft_estimate', run: viaHandler((g) => new EstimateTaskHandler(g)) },
  { name: 'update_estimate', run: viaHandler((g) => new EstimateEditTaskHandler(g)) },
  { name: 'draft_invoice', run: viaHandler((g) => new InvoiceTaskHandler(g)) },
  { name: 'update_invoice', run: viaHandler((g) => new InvoiceEditTaskHandler(g)) },
  { name: 'update_job', run: viaHandler((g) => new UpdateJobTaskHandler(g)) },
  {
    name: 'create_appointment',
    run: viaHandler((g) => new CreateAppointmentAITaskHandler(g)),
    context: {
      message: 'Book Mrs Lee next Tuesday at 2pm',
      existingEntities: { customerName: 'Mrs Lee', dateTimeDescription: 'next Tuesday at 2pm' },
    },
  },
  {
    name: 'send_customer_message',
    run: viaHandler((g) => new SendCustomerMessageTaskHandler(g)),
    context: { existingEntities: { customerMessageBody: 'running late' } },
  },
  {
    name: 'create_standing_instruction',
    run: viaHandler((g) => new CreateStandingInstructionTaskHandler(g)),
    context: { existingEntities: { instructionText: 'always mention the warranty' } },
  },
  {
    name: 'update_brand_voice',
    run: viaHandler((g) => new UpdateBrandVoiceTaskHandler(g)),
    context: { existingEntities: { brandVoiceInstruction: 'be friendlier' } },
  },
  {
    name: 'mms_estimate',
    run: async (gateway, context) => {
      const result = await new MmsEstimateTaskHandler(gateway).handle({
        tenantId: context.tenantId,
        customerId: CUSTOMER,
        images: [{ url: 'https://files.example.test/heater.jpg' }],
        createdBy: 'system:mms-intake',
        ...(context.conversationId ? { conversationId: context.conversationId } : {}),
      });
      if (result.status !== 'drafted') throw new Error(`mms draft failed: ${result.reason}`);
      return result.proposal;
    },
  },
];

describe('OBS-2 — every drafting handler links its proposal to the run that authored it', () => {
  for (const c of CASES) {
    it(`${c.name}: the run is keyed to the conversation and linked on the proposal`, async () => {
      const { gateway, requests } = capturingGateway();
      const proposal = await c.run(gateway, baseContext(c.context));

      // A real draft, not a clarification (clarifications link no run).
      expect(proposal.proposalType).not.toBe('voice_clarification');
      expect(requests.length).toBeGreaterThan(0);
      for (const req of requests) {
        expect(req.metadata?.correlationId, `${c.name} correlationId`).toBe('conv-obs2');
        expect(req.metadata?.sessionId, `${c.name} sessionId`).toBe('conv-obs2');
      }
      expect(proposal.aiRunId).toBe(RUN_ID);
    });

    it(`${c.name}: no persisted run → no aiRunId (the FK needs a real row)`, async () => {
      const { gateway } = capturingGateway(false);
      const proposal = await c.run(gateway, baseContext(c.context));
      expect(proposal.aiRunId).toBeUndefined();
    });
  }

  it('a memo with no conversation keys the run to its recording', async () => {
    const { gateway, requests } = capturingGateway();
    await new EstimateTaskHandler(gateway).handle(
      baseContext({ conversationId: undefined, recordingId: 'rec-obs2' }),
    );
    expect(requests[0].metadata?.correlationId).toBe('rec-obs2');
    expect(requests[0].metadata?.sessionId).toBeUndefined();
  });

  it('brand voice keeps its existing tenantId metadata alongside the join keys', async () => {
    const { gateway, requests } = capturingGateway();
    await new UpdateBrandVoiceTaskHandler(gateway).handle(
      baseContext({ existingEntities: { brandVoiceInstruction: 'be friendlier' } }),
    );
    expect(requests[0].metadata).toMatchObject({ tenantId: TENANT, correlationId: 'conv-obs2' });
  });

  it('a rewrite the handler discards authored nothing: send_customer_message links no run', async () => {
    const { gateway } = capturingGateway();
    (gateway.complete as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      content: 'x'.repeat(5000), // over the body cap → the spoken text wins
      model: 'mock',
      provider: 'mock',
      tokenUsage: { input: 1, output: 1, total: 2 },
      latencyMs: 1,
      aiRunId: RUN_ID,
    });
    const { proposal } = await new SendCustomerMessageTaskHandler(gateway).handle(
      baseContext({ existingEntities: { customerMessageBody: 'running late' } }),
    );
    expect(proposal.payload.body).toBe('running late');
    expect(proposal.aiRunId).toBeUndefined();
  });
});

// The two production surfaces that persist these proposals: the drafting run
// rides proposals.ai_run_id, the classifier run rides
// sourceContext.classifierAiRunId.
describe('OBS-2 — chat and memo surfaces persist both runs', () => {
  function runPerTask(): LLMGateway {
    return {
      complete: vi.fn(async (req: LLMRequest): Promise<LLMResponse> => ({
        content:
          req.taskType === 'classify_intent'
            ? JSON.stringify({
                intentType: 'update_job',
                confidence: 0.95,
                extractedEntities: { jobReference: 'the Miller job', status: 'completed' },
              })
            : REPLIES[req.taskType] ?? '{}',
        model: 'mock',
        provider: 'mock',
        tokenUsage: { input: 1, output: 1, total: 2 },
        latencyMs: 1,
        aiRunId: `run-${req.taskType}`,
      })),
    } as unknown as LLMGateway;
  }

  it('voice memo: drafting run on the proposal, classifier run on its sourceContext', async () => {
    const { createVoiceActionRouterWorker } = await import('../../../src/workers/voice-action-router');
    const { InMemoryProposalRepository } = await import('../../../src/proposals/proposal');
    const proposalRepo = new InMemoryProposalRepository();
    const worker = createVoiceActionRouterWorker({ gateway: runPerTask(), proposalRepo });
    await worker.handle(
      {
        id: 'm',
        type: 'voice_action_router',
        payload: {
          tenantId: TENANT,
          userId: 'u',
          transcript: 'Mark the Miller job completed',
          conversationId: 'conv-memo',
        },
        attempts: 1,
        maxAttempts: 3,
        idempotencyKey: 'k',
        createdAt: new Date().toISOString(),
      },
      { debug() {}, info() {}, warn() {}, error() {}, child() { return this; } } as never,
    );
    const [stored] = await proposalRepo.findByTenant(TENANT);
    expect(stored.proposalType).toBe('update_job');
    expect(stored.aiRunId).toBe('run-update_job');
    expect(stored.sourceContext?.classifierAiRunId).toBe('run-classify_intent');
  });

  it('assistant chat: drafting run on the proposal, classifier run on its sourceContext', async () => {
    const express = (await import('express')).default;
    const request = (await import('supertest')).default;
    const { createAssistantRouter } = await import('../../../src/routes/assistant');
    const { InMemoryProposalRepository } = await import('../../../src/proposals/proposal');
    const proposalRepo = new InMemoryProposalRepository();
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as unknown as { auth: Record<string, string> }).auth = {
        userId: 'u',
        sessionId: 's',
        tenantId: TENANT,
        role: 'owner',
      };
      next();
    });
    app.use('/api/assistant', createAssistantRouter({ gateway: runPerTask(), proposalRepo }));
    const res = await request(app)
      .post('/api/assistant/chat')
      .send({ messages: [{ role: 'user', content: 'Mark the Miller job completed' }] });
    expect(res.status).toBe(200);
    const [stored] = await proposalRepo.findByTenant(TENANT);
    expect(stored.proposalType).toBe('update_job');
    expect(stored.aiRunId).toBe('run-update_job');
    expect(stored.sourceContext?.classifierAiRunId).toBe('run-classify_intent');
  });
});

// OBS-2 — the two review_response_proposal creators. The payload is assembled
// from up to three runs (the review classification, the public reply, the
// private follow-up). Every one of them carries the creator's join key, and the
// proposal links the PUBLIC-REPLY run: the one component every review response
// has, and the text that is posted to Google as written.
describe('OBS-2 — review_response_proposal: every run in the pipeline keyed, the public-reply run linked', () => {
  const NOW = new Date('2026-11-01T12:00:00Z');
  const REVIEW_COMMENT = 'It was okay I suppose'; // no regex hit at 2★ → the review classifier asks the model

  function reviewGateway(withRunId = true): { gateway: LLMGateway; requests: LLMRequest[] } {
    const requests: LLMRequest[] = [];
    const replies: Record<string, string> = {
      review_classify: JSON.stringify({ classification: 'vague_complaint', confidence: 0.9 }),
      review_public_response: 'Sorry the visit fell short — please reach out so we can make it right.',
      review_private_followup: 'Hi Maria, sorry the visit fell short. What could we have done better?',
    };
    const gateway = {
      complete: vi.fn(async (req: LLMRequest): Promise<LLMResponse> => {
        requests.push(req);
        return {
          content: replies[req.taskType] ?? '{}',
          model: 'mock',
          provider: 'mock',
          tokenUsage: { input: 1, output: 1, total: 2 },
          latencyMs: 1,
          ...(withRunId ? { aiRunId: `run-${req.taskType}` } : {}),
        };
      }),
    } as unknown as LLMGateway;
    return { gateway, requests };
  }

  async function draftDeps(gateway: LLMGateway) {
    const { NoopBrandVoiceLoader } = await import('../../../src/reputation/brand-voice');
    const { InMemoryServiceCreditRepository } = await import('../../../src/reputation/service-credit');
    // A confident match, so the private follow-up is drafted too.
    return {
      llmGateway: gateway,
      customerLoader: {
        findRecentCustomersWithName: async () => [
          { id: CUSTOMER, firstName: 'Maria', lastName: 'Alvarez', lastVisitAt: new Date('2026-10-20T12:00:00Z') },
        ],
      },
      brandVoiceLoader: new NoopBrandVoiceLoader(),
      serviceCreditRepo: new InMemoryServiceCreditRepository(),
    };
  }

  async function respondToReview(gateway: LLMGateway, context: Partial<TaskContext>): Promise<Proposal> {
    const { RespondToReviewTaskHandler } = await import('../../../src/ai/tasks/review-response-task');
    const { InMemoryProposalRepository } = await import('../../../src/proposals/proposal');
    const { InMemoryReviewRepository } = await import('../../../src/reputation/review');
    const reviewRepo = new InMemoryReviewRepository();
    await reviewRepo.upsert({
      id: 'review-obs2',
      tenantId: TENANT,
      externalReviewId: 'accounts/A/locations/L/reviews/R1',
      locationId: 'accounts/A/locations/L',
      reviewerDisplayName: 'Maria Alvarez',
      reviewerProfileUrl: null,
      rating: 2,
      commentText: REVIEW_COMMENT,
      createTime: new Date(NOW.getTime() - 24 * 60 * 60 * 1000),
      updateTime: null,
      firstFetchedAt: NOW,
      lastFetchedAt: NOW,
    });
    const handler = new RespondToReviewTaskHandler(
      new InMemoryProposalRepository(),
      reviewRepo,
      await draftDeps(gateway),
      () => NOW,
    );
    const { proposal } = await handler.handle({
      tenantId: TENANT,
      userId: 'user-obs2',
      message: 'Respond to that 2-star review',
      existingEntities: { reviewReference: 'that 2-star review' },
      intent: 'respond_to_review',
      ...context,
    });
    return proposal;
  }

  const TASK_TYPES = ['review_classify', 'review_public_response', 'review_private_followup'];

  it('the spoken/chat on-ramp keys every run to the conversation and links the public-reply run', async () => {
    const { gateway, requests } = reviewGateway();
    const proposal = await respondToReview(gateway, { conversationId: 'conv-obs2' });

    expect(proposal.proposalType).toBe('review_response_proposal');
    expect(requests.map((r) => r.taskType)).toEqual(TASK_TYPES);
    for (const req of requests) {
      expect(req.metadata?.correlationId, `${req.taskType} correlationId`).toBe('conv-obs2');
      expect(req.metadata?.sessionId, `${req.taskType} sessionId`).toBe('conv-obs2');
    }
    expect(proposal.aiRunId).toBe('run-review_public_response');
  });

  it('on a live call (no conversation) every run is keyed to the voice session, like the classifier', async () => {
    const { gateway, requests } = reviewGateway();
    const proposal = await respondToReview(gateway, { voiceSessionId: 'voice-sess-obs2' });

    expect(requests.length).toBe(3);
    for (const req of requests) {
      expect(req.metadata?.correlationId, `${req.taskType} correlationId`).toBe('voice-sess-obs2');
      expect(req.metadata?.sessionId, `${req.taskType} sessionId`).toBe('voice-sess-obs2');
    }
    expect(proposal.aiRunId).toBe('run-review_public_response');
  });

  it('with no conversation, call or recording the runs are keyed to the review, never a random id', async () => {
    const { gateway, requests } = reviewGateway();
    await respondToReview(gateway, {});
    for (const req of requests) {
      expect(req.metadata?.correlationId, `${req.taskType} correlationId`).toBe('review-obs2');
    }
  });

  it('the spoken/chat on-ramp: no persisted run → no aiRunId (the FK needs a real row)', async () => {
    const { gateway } = reviewGateway(false);
    const proposal = await respondToReview(gateway, { conversationId: 'conv-obs2' });
    expect(proposal.proposalType).toBe('review_response_proposal');
    expect(proposal.aiRunId).toBeUndefined();
  });

  async function pollOneReview(gateway: LLMGateway): Promise<Proposal[]> {
    const { runGoogleReviewsSweep } = await import('../../../src/workers/google-reviews');
    const { InMemoryReviewRepository } = await import('../../../src/reputation/review');
    const { InMemoryReviewPollStateRepository } = await import('../../../src/reputation/poll-state');
    const { InMemoryProposalRepository } = await import('../../../src/proposals/proposal');
    const { createLogger } = await import('../../../src/logging/logger');
    const proposalRepo = new InMemoryProposalRepository();
    const result = await runGoogleReviewsSweep({
      reviewRepo: new InMemoryReviewRepository(),
      pollStateRepo: new InMemoryReviewPollStateRepository(() => NOW),
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
      listTenantIds: async () => [TENANT],
      logger: createLogger({ service: 'test', environment: 'test', level: 'error' }),
      now: () => NOW,
      fetchFn: async () =>
        new Response(
          JSON.stringify({
            reviews: [
              {
                name: 'accounts/A/locations/L/reviews/R1',
                reviewer: { displayName: 'Maria Alvarez' },
                starRating: 'TWO',
                comment: REVIEW_COMMENT,
                createTime: '2026-10-31T10:00:00Z',
                updateTime: '2026-10-31T10:00:00Z',
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      proposalEmission: { proposalRepo, buildProposalDeps: await draftDeps(gateway) },
    });
    expect(result.proposalsEmitted).toBe(1);
    return proposalRepo.findByTenant(TENANT);
  }

  it('the polling worker keys every run to the review and links the public-reply run', async () => {
    const { gateway, requests } = reviewGateway();
    const [proposal] = await pollOneReview(gateway);

    expect(proposal.proposalType).toBe('review_response_proposal');
    expect(proposal.targetEntityId).toBeDefined();
    expect(requests.map((r) => r.taskType)).toEqual(TASK_TYPES);
    for (const req of requests) {
      // The review row's id: the proposal's targetEntityId and payload.reviewId.
      expect(req.metadata?.correlationId, `${req.taskType} correlationId`).toBe(proposal.targetEntityId);
      expect((proposal.payload as { reviewId?: string }).reviewId).toBe(proposal.targetEntityId);
    }
    expect(proposal.aiRunId).toBe('run-review_public_response');
  });

  it('the polling worker: no persisted run → no aiRunId', async () => {
    const { gateway } = reviewGateway(false);
    const [proposal] = await pollOneReview(gateway);
    expect(proposal.aiRunId).toBeUndefined();
  });
});
