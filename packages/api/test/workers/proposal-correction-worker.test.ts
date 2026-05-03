import { describe, it, expect, vi } from 'vitest';
import {
  createProposalCorrectionWorker,
  computeTopLevelDiff,
} from '../../src/workers/proposal-correction-worker';
import { InMemoryProposalRepository, createProposal } from '../../src/proposals/proposal';
import { InMemoryProposalExecutionRepository } from '../../src/proposals/proposal-execution';
import {
  EMBEDDING_DIMENSIONS,
  EMBEDDING_MODEL,
  InMemoryKnowledgeChunkRepository,
} from '../../src/ai/training/knowledge-chunks';
import { InMemoryRetrievalEvalRunRepository } from '../../src/ai/training/retrieval-eval-run';
import type {
  EmbeddingProvider,
  EmbeddingResult,
} from '../../src/ai/providers/openai-compatible';
import { createLogger } from '../../src/logging/logger';
import { QueueMessage } from '../../src/queues/queue';

const TENANT_A = '11111111-1111-1111-1111-111111111111';

function unitVec(dim: number, fn: (i: number) => number): number[] {
  const raw = Array.from({ length: dim }, (_, i) => fn(i));
  const norm = Math.sqrt(raw.reduce((s, x) => s + x * x, 0));
  return raw.map((x) => x / (norm || 1));
}

// Constant unit vector so cosine similarity against the test query
// (also a unit vector of all-1s) is positive and the chunk passes the
// repo's minSimilarity floor regardless of the input string.
const CONST_EMBEDDING = unitVec(EMBEDDING_DIMENSIONS, () => 1);

function stubEmbedder(opts: { fail?: boolean } = {}): EmbeddingProvider {
  return {
    name: 'stub',
    async createEmbedding(_input: string): Promise<EmbeddingResult> {
      if (opts.fail) throw new Error('embedder stubbed to fail');
      return {
        embedding: [...CONST_EMBEDDING],
        model: EMBEDDING_MODEL,
        tokenUsage: 10,
        latencyMs: 1,
      };
    },
  };
}

const logger = createLogger({ service: 'test', environment: 'test', level: 'error' });

function buildMessage(payload: Record<string, unknown>): QueueMessage<any> {
  return {
    id: 'msg-1',
    type: 'proposal_correction',
    payload,
    attempts: 1,
    maxAttempts: 3,
    idempotencyKey: 'idem-1',
    createdAt: new Date().toISOString(),
  };
}

describe('proposal-correction-worker', () => {
  it('non-empty diff: emits a correction chunk with edited fields', async () => {
    const proposalRepo = new InMemoryProposalRepository();
    const proposalExecutionRepo = new InMemoryProposalExecutionRepository();
    const knowledgeChunkRepo = new InMemoryKnowledgeChunkRepository();

    const proposal = createProposal({
      tenantId: TENANT_A,
      proposalType: 'create_appointment',
      payload: {
        scheduledStart: '2026-04-21T11:00:00Z',
        scheduledEnd: '2026-04-21T12:00:00Z',
        summary: 'Tune-up',
      },
      summary: 'AI draft',
      createdBy: 'user-1',
    });
    await proposalRepo.create(proposal);

    const execution = await proposalExecutionRepo.recordExecution({
      tenantId: TENANT_A,
      proposalId: proposal.id,
      executedPayload: {
        scheduledStart: '2026-04-21T13:00:00Z', // dispatcher edited
        scheduledEnd: '2026-04-21T14:00:00Z',   // dispatcher edited
        summary: 'Tune-up',                      // unchanged
      },
      executedBy: 'dispatcher-1',
      status: 'succeeded',
    });

    const worker = createProposalCorrectionWorker({
      proposalRepo,
      proposalExecutionRepo,
      knowledgeChunkRepo,
      embeddings: stubEmbedder(),
    });
    await worker.handle(
      buildMessage({ tenantId: TENANT_A, proposalId: proposal.id, executionId: execution.id }),
      logger,
    );

    const hits = await knowledgeChunkRepo.search({
      tenantId: TENANT_A,
      queryEmbedding: [...CONST_EMBEDDING],
      sourceTypes: ['proposal_correction'],
      minSimilarity: 0,
      k: 10,
    });
    expect(hits.length).toBe(1);
    const chunk = hits[0].chunk;
    expect(chunk.sourceId).toBe(execution.id);
    expect(chunk.contentScrubbed).toContain('intent=create_appointment');
    expect(chunk.contentScrubbed).toContain('scheduledStart');
    expect(chunk.contentScrubbed).toContain('scheduledEnd');
    expect(chunk.contentScrubbed).not.toContain('summary'); // unchanged field omitted
    expect(chunk.metadata.editedFields).toEqual(['scheduledEnd', 'scheduledStart']);
  });

  it('empty diff (clean approval): no chunk written, attaches outcome when eval-run linked', async () => {
    const proposalRepo = new InMemoryProposalRepository();
    const proposalExecutionRepo = new InMemoryProposalExecutionRepository();
    const knowledgeChunkRepo = new InMemoryKnowledgeChunkRepository();
    const retrievalEvalRunRepo = new InMemoryRetrievalEvalRunRepository();

    const evalRun = await retrievalEvalRunRepo.recordRun({
      tenantId: TENANT_A,
      queryText: 'something',
      retrievedChunkIds: [],
      retrievedScores: [],
    });

    const payload = { name: 'Customer X' };
    const proposal = createProposal({
      tenantId: TENANT_A,
      proposalType: 'create_customer',
      payload,
      summary: 'AI draft',
      createdBy: 'user-1',
      sourceContext: { retrievalEvalRunId: evalRun.id },
    });
    await proposalRepo.create(proposal);
    await proposalExecutionRepo.recordExecution({
      tenantId: TENANT_A,
      proposalId: proposal.id,
      executedPayload: payload, // identical
      executedBy: 'dispatcher-1',
      status: 'succeeded',
    });

    const worker = createProposalCorrectionWorker({
      proposalRepo,
      proposalExecutionRepo,
      knowledgeChunkRepo,
      embeddings: stubEmbedder(),
      retrievalEvalRunRepo,
    });
    await worker.handle(
      buildMessage({ tenantId: TENANT_A, proposalId: proposal.id }),
      logger,
    );

    const hits = await knowledgeChunkRepo.search({
      tenantId: TENANT_A,
      queryEmbedding: unitVec(EMBEDDING_DIMENSIONS, () => 1),
      sourceTypes: ['proposal_correction'],
      minSimilarity: 0,
      k: 10,
    });
    expect(hits.length).toBe(0);

    const updated = await retrievalEvalRunRepo.findById(TENANT_A, evalRun.id);
    expect(updated?.downstreamProposalId).toBe(proposal.id);
    expect(updated?.downstreamOutcome).toBe('approved_no_edits');
  });

  it('skips when execution status is failed', async () => {
    const proposalRepo = new InMemoryProposalRepository();
    const proposalExecutionRepo = new InMemoryProposalExecutionRepository();
    const knowledgeChunkRepo = new InMemoryKnowledgeChunkRepository();

    const proposal = createProposal({
      tenantId: TENANT_A,
      proposalType: 'create_customer',
      payload: { name: 'X' },
      summary: 'AI draft',
      createdBy: 'user-1',
    });
    await proposalRepo.create(proposal);
    await proposalExecutionRepo.recordExecution({
      tenantId: TENANT_A,
      proposalId: proposal.id,
      executedPayload: { name: 'Y' },
      executedBy: 'dispatcher-1',
      status: 'failed',
      errorMessage: 'something',
    });

    const worker = createProposalCorrectionWorker({
      proposalRepo,
      proposalExecutionRepo,
      knowledgeChunkRepo,
      embeddings: stubEmbedder(),
    });
    await worker.handle(buildMessage({ tenantId: TENANT_A, proposalId: proposal.id }), logger);

    const hits = await knowledgeChunkRepo.search({
      tenantId: TENANT_A,
      queryEmbedding: unitVec(EMBEDDING_DIMENSIONS, () => 1),
      minSimilarity: 0,
      k: 10,
    });
    expect(hits.length).toBe(0);
  });

  it('failure-soft: embed error drops the chunk but does not throw', async () => {
    const proposalRepo = new InMemoryProposalRepository();
    const proposalExecutionRepo = new InMemoryProposalExecutionRepository();
    const knowledgeChunkRepo = new InMemoryKnowledgeChunkRepository();

    const proposal = createProposal({
      tenantId: TENANT_A,
      proposalType: 'create_customer',
      payload: { name: 'AI Draft' },
      summary: 'AI draft',
      createdBy: 'user-1',
    });
    await proposalRepo.create(proposal);
    await proposalExecutionRepo.recordExecution({
      tenantId: TENANT_A,
      proposalId: proposal.id,
      executedPayload: { name: 'Dispatcher Edit' },
      executedBy: 'dispatcher-1',
      status: 'succeeded',
    });

    const worker = createProposalCorrectionWorker({
      proposalRepo,
      proposalExecutionRepo,
      knowledgeChunkRepo,
      embeddings: stubEmbedder({ fail: true }),
    });
    await expect(
      worker.handle(buildMessage({ tenantId: TENANT_A, proposalId: proposal.id }), logger),
    ).resolves.toBeUndefined();
  });

  it('proposal not found: soft-skip', async () => {
    const proposalRepo = new InMemoryProposalRepository();
    const proposalExecutionRepo = new InMemoryProposalExecutionRepository();
    const knowledgeChunkRepo = new InMemoryKnowledgeChunkRepository();

    const worker = createProposalCorrectionWorker({
      proposalRepo,
      proposalExecutionRepo,
      knowledgeChunkRepo,
      embeddings: stubEmbedder(),
    });
    await expect(
      worker.handle(
        buildMessage({ tenantId: TENANT_A, proposalId: '00000000-0000-0000-0000-000000000000' }),
        logger,
      ),
    ).resolves.toBeUndefined();
  });

  it('execution not found: soft-skip', async () => {
    const proposalRepo = new InMemoryProposalRepository();
    const proposalExecutionRepo = new InMemoryProposalExecutionRepository();
    const knowledgeChunkRepo = new InMemoryKnowledgeChunkRepository();
    const proposal = createProposal({
      tenantId: TENANT_A,
      proposalType: 'create_customer',
      payload: { name: 'X' },
      summary: 'AI draft',
      createdBy: 'user-1',
    });
    await proposalRepo.create(proposal);

    const worker = createProposalCorrectionWorker({
      proposalRepo,
      proposalExecutionRepo,
      knowledgeChunkRepo,
      embeddings: stubEmbedder(),
    });
    await expect(
      worker.handle(buildMessage({ tenantId: TENANT_A, proposalId: proposal.id }), logger),
    ).resolves.toBeUndefined();
  });
});

describe('computeTopLevelDiff', () => {
  it('ignores unchanged fields', () => {
    const diffs = computeTopLevelDiff({ a: 1, b: 2 }, { a: 1, b: 3 });
    expect(diffs).toEqual([{ field: 'b', drafted: 2, executed: 3 }]);
  });

  it('catches missing-on-one-side via undefined comparison', () => {
    const diffs = computeTopLevelDiff({ a: 1 }, { a: 1, b: 2 });
    expect(diffs).toEqual([{ field: 'b', drafted: undefined, executed: 2 }]);
  });

  it('compares nested objects via JSON.stringify (no recursion in v1)', () => {
    const diffs = computeTopLevelDiff(
      { line_items: [{ qty: 1 }] },
      { line_items: [{ qty: 2 }] },
    );
    expect(diffs.length).toBe(1);
    expect(diffs[0].field).toBe('line_items');
  });

  it('returns sorted-by-field for stable output', () => {
    const diffs = computeTopLevelDiff({ z: 1, a: 1 }, { z: 2, a: 2 });
    expect(diffs.map((d) => d.field)).toEqual(['a', 'z']);
  });
});
