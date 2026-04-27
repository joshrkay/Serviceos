/**
 * P2-013 — Low-confidence handling policy, wired through TaskRouter.
 *
 * Verifies that routeWithGuardrails runs the handler, applies the confidence
 * policy to the produced proposal, and surfaces the appropriate action
 * (ready_for_review / warnings / clarification / safe_failure).
 */
import { describe, it, expect } from 'vitest';
import {
  TaskRouter,
  routeWithGuardrails,
} from '../../src/ai/orchestration/task-router';
import {
  TaskHandler,
  TaskContext,
  TaskResult,
} from '../../src/ai/tasks/task-handlers';
import {
  createProposal,
  CreateProposalInput,
  ProposalType,
} from '../../src/proposals/proposal';

class FixedConfidenceHandler implements TaskHandler {
  readonly taskType: ProposalType = 'create_customer';
  constructor(
    private readonly confidence: number,
    private readonly factors: string[] = ['name', 'phone']
  ) {}
  async handle(context: TaskContext): Promise<TaskResult> {
    const input: CreateProposalInput = {
      tenantId: context.tenantId,
      proposalType: this.taskType,
      payload: { name: 'Test' },
      summary: context.message,
      confidenceScore: this.confidence,
      confidenceFactors: this.factors,
      createdBy: context.userId,
    };
    return { taskType: this.taskType, proposal: createProposal(input) };
  }
}

function buildRouter(confidence: number): TaskRouter {
  const router = new TaskRouter();
  router.register(new FixedConfidenceHandler(confidence));
  return router;
}

function ctx(overrides: Partial<TaskContext> = {}): TaskContext {
  return {
    tenantId: 'tenant-1',
    userId: 'user-1',
    message: 'Create customer',
    ...overrides,
  };
}

describe('routeWithGuardrails', () => {
  it('high confidence → ready_for_review, proposal status promoted', async () => {
    const router = buildRouter(0.95);
    const result = await routeWithGuardrails(router, 'create_customer', ctx());

    expect(result.confidenceAction.action).toBe('ready_for_review');
    expect(result.proposal.status).toBe('ready_for_review');
    expect(result.taskResult.taskType).toBe('create_customer');
  });

  it('medium confidence → ready_for_review_with_warnings', async () => {
    const router = buildRouter(0.65);
    const result = await routeWithGuardrails(router, 'create_customer', ctx());

    expect(result.confidenceAction.action).toBe('ready_for_review_with_warnings');
    expect(result.proposal.status).toBe('ready_for_review');
    if (result.confidenceAction.action === 'ready_for_review_with_warnings') {
      expect(result.confidenceAction.warnings.length).toBeGreaterThan(0);
    }
  });

  it('low confidence → request_clarification, proposal stays in draft', async () => {
    const router = buildRouter(0.35);
    const result = await routeWithGuardrails(router, 'create_customer', ctx());

    expect(result.confidenceAction.action).toBe('request_clarification');
    expect(result.proposal.status).toBe('draft');
    if (result.confidenceAction.action === 'request_clarification') {
      expect(result.confidenceAction.questions.length).toBeGreaterThan(0);
    }
  });

  it('very low confidence → safe_failure, proposal stays in draft', async () => {
    const router = buildRouter(0.1);
    const result = await routeWithGuardrails(router, 'create_customer', ctx());

    expect(result.confidenceAction.action).toBe('safe_failure');
    expect(result.proposal.status).toBe('draft');
    if (result.confidenceAction.action === 'safe_failure') {
      expect(result.confidenceAction.reason).toContain('minimum threshold');
    }
  });

  it('unsupported task type bubbles up as UNSUPPORTED_TASK error', async () => {
    const router = buildRouter(0.9);
    await expect(
      routeWithGuardrails(router, 'nonexistent_task' as 'create_customer', ctx())
    ).rejects.toThrow(/UNSUPPORTED_TASK|No handler registered/);
  });

  it('respects a custom ConfidencePolicy when provided', async () => {
    const router = buildRouter(0.7);
    // Tight thresholds — 0.7 now falls below high (0.85) so gets warnings
    const result = await routeWithGuardrails(router, 'create_customer', ctx(), {
      highThreshold: 0.85,
      mediumThreshold: 0.6,
      lowThreshold: 0.3,
    });

    expect(result.confidenceAction.action).toBe('ready_for_review_with_warnings');
  });
});
