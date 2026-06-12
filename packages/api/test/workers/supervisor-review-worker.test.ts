/**
 * Rivet P2 F-1 — supervisor advisory annotator sweep (mock gateway).
 *
 * Invariants pinned here:
 *   - annotation is written into payload._meta.supervisorAnnotation via
 *     the repo update path — status NEVER changes;
 *   - already-annotated / stale / non-ready proposals are skipped;
 *   - LLM failures and garbage output skip silently (advisory);
 *   - per-tenant failure isolation (tenant A blowing up never stops B);
 *   - the per-tenant 'supervisor_agent' flag gates the gateway spend.
 */
import { describe, it, expect, vi } from 'vitest';
import type { LLMRequest, LLMResponse } from '../../src/ai/gateway/gateway';
import {
  InMemoryProposalRepository,
  createProposal,
  type Proposal,
} from '../../src/proposals/proposal';
import {
  SUPERVISOR_ANNOTATE_TASK_TYPE,
  parseAnnotationResponse,
  runSupervisorAnnotationSweep,
  type SupervisorAnnotationSweepDeps,
} from '../../src/workers/supervisor-review-worker';
import { hasSupervisorAnnotation } from '../../src/proposals/supervisor/marker';

const TENANT_A = '11111111-1111-1111-1111-111111111111';
const TENANT_B = '22222222-2222-2222-2222-222222222222';
const NOW = new Date('2026-06-11T12:00:00.000Z');

const silentLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

function okResponse(content: string): LLMResponse {
  return {
    content,
    model: 'test-model',
    provider: 'mock',
    tokenUsage: { input: 1, output: 1, total: 2 },
    latencyMs: 1,
  };
}

const GOOD_JSON = JSON.stringify({
  riskSummary: 'Large invoice for a brand-new customer.',
  flags: ['high_amount', 'new_customer'],
});

async function seedReadyProposal(
  repo: InMemoryProposalRepository,
  tenantId: string,
  overrides: Partial<Proposal> = {},
): Promise<Proposal> {
  const proposal = createProposal({
    tenantId,
    proposalType: 'issue_invoice',
    payload: { totalCents: 125_000 },
    summary: 'Issue invoice for $1,250.00',
    confidenceScore: 0.8,
    createdBy: 'agent-1',
  });
  const ready: Proposal = {
    ...proposal,
    status: 'ready_for_review',
    createdAt: new Date(NOW.getTime() - 60_000),
    ...overrides,
  };
  await repo.create(ready);
  return ready;
}

function makeDeps(
  repo: InMemoryProposalRepository,
  overrides: Partial<SupervisorAnnotationSweepDeps> = {},
): SupervisorAnnotationSweepDeps & { complete: ReturnType<typeof vi.fn> } {
  const complete = vi.fn(async (_req: LLMRequest) => okResponse(GOOD_JSON));
  return {
    listTenantIds: async () => [TENANT_A],
    proposalRepo: repo,
    gateway: { complete },
    logger: silentLogger,
    now: () => NOW,
    complete,
    ...overrides,
  };
}

describe('runSupervisorAnnotationSweep', () => {
  it('annotates recent ready_for_review proposals via the update path — status untouched', async () => {
    const repo = new InMemoryProposalRepository();
    const proposal = await seedReadyProposal(repo, TENANT_A);
    const deps = makeDeps(repo);

    const result = await runSupervisorAnnotationSweep(deps);
    expect(result.annotated).toBe(1);

    const stored = await repo.findById(TENANT_A, proposal.id);
    expect(stored!.status).toBe('ready_for_review'); // NEVER a status change
    expect(hasSupervisorAnnotation(stored!.payload)).toBe(true);
    const meta = stored!.payload._meta as Record<string, unknown>;
    expect(meta.supervisorAnnotation).toEqual({
      riskSummary: 'Large invoice for a brand-new customer.',
      flags: ['high_amount', 'new_customer'],
      annotatedAt: NOW.toISOString(),
    });

    // One gateway call with the routed task type and tenant attribution.
    expect(deps.complete).toHaveBeenCalledTimes(1);
    const req = deps.complete.mock.calls[0][0] as LLMRequest;
    expect(req.taskType).toBe(SUPERVISOR_ANNOTATE_TASK_TYPE);
    expect(req.tenantId).toBe(TENANT_A);
    expect(req.responseFormat).toBe('json');
    // PII discipline: the prompt carries the summary, not the raw payload.
    expect(req.messages[0].content).toContain('Issue invoice for $1,250.00');
  });

  it('skips proposals that already carry an annotation (no second gateway call)', async () => {
    const repo = new InMemoryProposalRepository();
    await seedReadyProposal(repo, TENANT_A);
    const deps = makeDeps(repo);
    await runSupervisorAnnotationSweep(deps);
    const again = await runSupervisorAnnotationSweep(deps);
    expect(deps.complete).toHaveBeenCalledTimes(1);
    expect(again.annotated).toBe(0);
  });

  it('skips proposals outside the recency window and non-ready statuses', async () => {
    const repo = new InMemoryProposalRepository();
    await seedReadyProposal(repo, TENANT_A, {
      createdAt: new Date(NOW.getTime() - 48 * 60 * 60 * 1000), // 48h old
    });
    await seedReadyProposal(repo, TENANT_A, { status: 'draft' });
    const deps = makeDeps(repo);
    const result = await runSupervisorAnnotationSweep(deps);
    expect(result.annotated).toBe(0);
    expect(deps.complete).not.toHaveBeenCalled();
  });

  it('LLM failure skips silently — proposal intact, sweep continues to siblings', async () => {
    const repo = new InMemoryProposalRepository();
    const first = await seedReadyProposal(repo, TENANT_A, {
      createdAt: new Date(NOW.getTime() - 120_000),
    });
    const second = await seedReadyProposal(repo, TENANT_A, {
      createdAt: new Date(NOW.getTime() - 60_000),
    });
    const complete = vi
      .fn<[LLMRequest], Promise<LLMResponse>>()
      .mockRejectedValueOnce(new Error('provider down'))
      .mockResolvedValueOnce(okResponse(GOOD_JSON));
    const deps = makeDeps(repo, { gateway: { complete } });

    const result = await runSupervisorAnnotationSweep(deps);
    expect(result.annotated).toBe(1);
    expect(result.skipped).toBe(1);
    // Newest-first ordering: `second` was attempted first (and failed).
    const storedSecond = await repo.findById(TENANT_A, second.id);
    const storedFirst = await repo.findById(TENANT_A, first.id);
    expect(hasSupervisorAnnotation(storedSecond!.payload)).toBe(false);
    expect(storedSecond!.status).toBe('ready_for_review');
    expect(hasSupervisorAnnotation(storedFirst!.payload)).toBe(true);
  });

  it('malformed model output skips silently', async () => {
    const repo = new InMemoryProposalRepository();
    const proposal = await seedReadyProposal(repo, TENANT_A);
    const complete = vi.fn(async () => okResponse('not json at all'));
    const deps = makeDeps(repo, { gateway: { complete } });
    const result = await runSupervisorAnnotationSweep(deps);
    expect(result.annotated).toBe(0);
    expect(hasSupervisorAnnotation((await repo.findById(TENANT_A, proposal.id))!.payload)).toBe(
      false,
    );
  });

  it('per-tenant failure isolation: tenant A exploding never stops tenant B', async () => {
    const repo = new InMemoryProposalRepository();
    const bProposal = await seedReadyProposal(repo, TENANT_B);
    const deps = makeDeps(repo, {
      listTenantIds: async () => [TENANT_A, TENANT_B],
      proposalRepo: {
        findByStatus: async (tenantId, status) => {
          if (tenantId === TENANT_A) throw new Error('tenant A repo exploded');
          return repo.findByStatus(tenantId, status);
        },
        update: (tenantId, id, updates) => repo.update(tenantId, id, updates),
      },
    });
    const result = await runSupervisorAnnotationSweep(deps);
    expect(result.failures).toBe(1);
    expect(result.annotated).toBe(1);
    expect(hasSupervisorAnnotation((await repo.findById(TENANT_B, bProposal.id))!.payload)).toBe(
      true,
    );
  });

  it("the per-tenant 'supervisor_agent' flag gates the sweep (no gateway spend when off)", async () => {
    const repo = new InMemoryProposalRepository();
    await seedReadyProposal(repo, TENANT_A);
    await seedReadyProposal(repo, TENANT_B);
    const deps = makeDeps(repo, {
      listTenantIds: async () => [TENANT_A, TENANT_B],
      isEnabledForTenant: async (tenantId) => tenantId === TENANT_B,
    });
    const result = await runSupervisorAnnotationSweep(deps);
    expect(result.tenantsSwept).toBe(1);
    expect(result.annotated).toBe(1);
    expect(deps.complete).toHaveBeenCalledTimes(1);
    expect((deps.complete.mock.calls[0][0] as LLMRequest).tenantId).toBe(TENANT_B);
  });

  it('respects the per-tenant per-sweep budget', async () => {
    const repo = new InMemoryProposalRepository();
    for (let i = 0; i < 5; i++) {
      await seedReadyProposal(repo, TENANT_A, {
        createdAt: new Date(NOW.getTime() - (i + 1) * 1000),
      });
    }
    const deps = makeDeps(repo, { maxPerTenantPerSweep: 2 });
    const result = await runSupervisorAnnotationSweep(deps);
    expect(result.annotated).toBe(2);
    expect(deps.complete).toHaveBeenCalledTimes(2);
  });
});

describe('parseAnnotationResponse', () => {
  it('accepts the documented shape and bounds it', () => {
    const long = 'x'.repeat(1_000);
    const parsed = parseAnnotationResponse(
      JSON.stringify({ riskSummary: long, flags: Array(20).fill('f') }),
    );
    expect(parsed!.riskSummary).toHaveLength(500);
    expect(parsed!.flags).toHaveLength(10);
  });

  const bad: Array<[string, string]> = [
    ['non-JSON', 'nope'],
    ['JSON array', '[1,2]'],
    ['missing riskSummary', JSON.stringify({ flags: [] })],
    ['empty riskSummary', JSON.stringify({ riskSummary: '   ', flags: [] })],
    ['non-string flags', JSON.stringify({ riskSummary: 'ok', flags: [1] })],
    ['flags not array', JSON.stringify({ riskSummary: 'ok', flags: 'high' })],
  ];
  it.each(bad)('rejects %s', (_name, content) => {
    expect(parseAnnotationResponse(content)).toBeNull();
  });
});
