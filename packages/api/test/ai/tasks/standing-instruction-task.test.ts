/**
 * UB-A2 — create_standing_instruction voice on-ramp (task-handler level, LLM
 * gateway mocked). The v1 guarantee under test: the proposal ALWAYS lands in
 * 'draft' (no sourceTrustTier), the payload satisfies the Zod contract, and a
 * gateway failure degrades to the verbatim spoken text — never a dropped
 * utterance.
 */
import { describe, expect, it, vi } from 'vitest';
import { CreateStandingInstructionTaskHandler } from '../../../src/ai/tasks/standing-instruction-task';
import { TaskContext } from '../../../src/ai/tasks/task-handlers';
import { assertValidProposalPayload } from '../../../src/proposals/contracts';
import { missingFieldsFor } from '../../../src/proposals/proposal';
import type { LLMGateway, LLMResponse } from '../../../src/ai/gateway/gateway';

function gatewayReturning(content: string): LLMGateway {
  return {
    complete: vi.fn(async () => ({
      content,
      model: 'mock',
      provider: 'mock',
      tokenUsage: { input: 10, output: 10, total: 20 },
      latencyMs: 1,
    }) satisfies LLMResponse),
  } as unknown as LLMGateway;
}

function failingGateway(): LLMGateway {
  return {
    complete: vi.fn(async () => {
      throw new Error('gateway down');
    }),
  } as unknown as LLMGateway;
}

function ctx(overrides: Partial<TaskContext> = {}): TaskContext {
  return {
    tenantId: 't-1',
    userId: 'u-1',
    message: 'From now on always add a $79 diagnostic fee to AC calls',
    ...overrides,
  };
}

describe('CreateStandingInstructionTaskHandler', () => {
  it('normalizes via the gateway into { instruction, scope } and ALWAYS drafts for review', async () => {
    const gateway = gatewayReturning(
      JSON.stringify({
        instruction: 'Always add a $79 diagnostic fee to AC service calls',
        scope: { intents: ['create_invoice'], tradeCategories: ['hvac'], amountCents: 7900 },
      }),
    );
    const handler = new CreateStandingInstructionTaskHandler(gateway);

    const res = await handler.handle(
      ctx({
        existingEntities: {
          instructionText: 'from now on always add a $79 diagnostic fee to AC calls',
          scopeIntentHint: 'invoices',
          amount: 7900,
        },
      }),
    );

    expect(res.proposal.proposalType).toBe('create_standing_instruction');
    expect(res.proposal.payload.instruction).toBe(
      'Always add a $79 diagnostic fee to AC service calls',
    );
    expect(res.proposal.payload.scope).toEqual({
      intents: ['create_invoice'],
      tradeCategories: ['hvac'],
      amountCents: 7900,
    });
    assertValidProposalPayload('create_standing_instruction', res.proposal.payload);
    // v1 rule: no sourceTrustTier → decideInitialStatus lands it in draft,
    // regardless of confidence or supervisor presence.
    expect(res.proposal.status).toBe('draft');
    expect(missingFieldsFor(res.proposal)).toEqual([]);
    // Routed through the gateway with the task-type + tenant metadata convention.
    const call = (gateway.complete as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.taskType).toBe('create_standing_instruction');
    expect(call.metadata).toEqual({ tenantId: 't-1' });
  });

  it('transcript-derived amount OVERRIDES a model-emitted amountCents', async () => {
    const gateway = gatewayReturning(
      JSON.stringify({
        instruction: 'Always add a diagnostic fee to AC calls',
        scope: { amountCents: 123456789 }, // model-invented money
      }),
    );
    const res = await new CreateStandingInstructionTaskHandler(gateway).handle(
      ctx({ existingEntities: { instructionText: 'always add a $79 diagnostic fee', amount: 7900 } }),
    );
    expect((res.proposal.payload.scope as { amountCents: number }).amountCents).toBe(7900);
  });

  it('invalid model scope is dropped; valid instruction text is kept', async () => {
    const gateway = gatewayReturning(
      JSON.stringify({
        instruction: 'Never offer weekend slots to new customers',
        scope: { customerSegment: 'vip', junk: true }, // fails the domain schema
      }),
    );
    const res = await new CreateStandingInstructionTaskHandler(gateway).handle(
      ctx({ existingEntities: { instructionText: 'never offer weekend slots to new customers' } }),
    );
    expect(res.proposal.payload.instruction).toBe('Never offer weekend slots to new customers');
    expect(res.proposal.payload.scope).toBeUndefined();
    assertValidProposalPayload('create_standing_instruction', res.proposal.payload);
  });

  it('gateway failure degrades to the verbatim spoken text (no scope), still draft', async () => {
    const res = await new CreateStandingInstructionTaskHandler(failingGateway()).handle(
      ctx({
        existingEntities: {
          instructionText: 'always include a fuel surcharge on invoices',
        },
      }),
    );
    expect(res.proposal.payload.instruction).toBe('always include a fuel surcharge on invoices');
    expect(res.proposal.payload.scope).toBeUndefined();
    expect(res.proposal.status).toBe('draft');
    assertValidProposalPayload('create_standing_instruction', res.proposal.payload);
  });

  it('unparseable gateway JSON degrades to the transcript when no instructionText was extracted', async () => {
    const res = await new CreateStandingInstructionTaskHandler(gatewayReturning('not json')).handle(
      ctx({ existingEntities: {} }),
    );
    expect(res.proposal.payload.instruction).toBe(
      'From now on always add a $79 diagnostic fee to AC calls',
    );
    expect(res.proposal.status).toBe('draft');
  });

  it('caps the instruction at the domain max length', async () => {
    const long = 'always '.repeat(200);
    const res = await new CreateStandingInstructionTaskHandler(failingGateway()).handle(
      ctx({ existingEntities: { instructionText: long } }),
    );
    expect((res.proposal.payload.instruction as string).length).toBeLessThanOrEqual(500);
    assertValidProposalPayload('create_standing_instruction', res.proposal.payload);
  });
});
