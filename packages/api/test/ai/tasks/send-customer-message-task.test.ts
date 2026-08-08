/**
 * Tradesperson wave 1, Task 5 — SendCustomerMessageTaskHandler (drafting leg).
 *
 * Standalone file per the quality-review ratchet (mirrors complaint-task.ts /
 * brand-voice-task.ts / apply-credit-task.ts) — voice-extended-tasks.ts stays
 * untouched; new drafting handlers land in their own file.
 *
 * Customer resolution mirrors `UpdateCustomerTaskHandler` (voice-extended-
 * tasks.ts): `send_customer_message` joins `CUSTOMER_REF_INTENTS`
 * (ai/agents/customer-calling/entity-resolution.ts), so the voice-action-
 * router resolves the spoken customer name to a verified id BEFORE this
 * handler runs and threads it onto `context.customerId` (or short-circuits
 * to a `voice_clarification` on an ambiguous match, or leaves it absent on
 * no match / nothing spoken). An unresolved reference gates
 * `missingFields: ['customerId']`.
 *
 * The spoken message body rides `customerMessageBody` and is optionally
 * cleaned up by a second, degradable LLM rewrite pass (mirrors
 * `SuggestReplyTask`'s house pattern): present gateway + successful call →
 * use the rewritten text; absent gateway, or ANY rewrite failure → fall
 * back to the verbatim spoken text. Never fabricates content beyond what
 * the operator said.
 */
import { describe, it, expect, vi } from 'vitest';
import { SendCustomerMessageTaskHandler } from '../../../src/ai/tasks/send-customer-message-task';
import { TaskContext } from '../../../src/ai/tasks/task-handlers';
import { missingFieldsFor, actionClassForProposalType } from '../../../src/proposals/proposal';
import type { LLMGateway, LLMResponse } from '../../../src/ai/gateway/gateway';

const TENANT_ID = 't-1';
const CUSTOMER_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';

function ctx(overrides: Partial<TaskContext>): TaskContext {
  return {
    tenantId: TENANT_ID,
    userId: 'u-1',
    message: 'text the hendersons the part arrived',
    ...overrides,
  };
}

function gatewayReturning(content: string): LLMGateway {
  return {
    complete: vi.fn(async () =>
      ({
        content,
        model: 'mock',
        provider: 'mock',
        tokenUsage: { input: 10, output: 10, total: 20 },
        latencyMs: 5,
      }) satisfies LLMResponse,
    ),
  } as unknown as LLMGateway;
}

function throwingGateway(): LLMGateway {
  return {
    complete: vi.fn(async () => {
      throw new Error('gateway unavailable');
    }),
  } as unknown as LLMGateway;
}

describe('SendCustomerMessageTaskHandler', () => {
  it('a resolved customerId (context.customerId) + a spoken body draft ungated with channel defaulted to sms, no gateway wired (verbatim passthrough)', async () => {
    const { proposal, taskType } = await new SendCustomerMessageTaskHandler().handle(
      ctx({
        customerId: CUSTOMER_ID,
        existingEntities: { customerMessageBody: 'the part arrived, we can come thursday morning' },
      }),
    );

    expect(taskType).toBe('send_customer_message');
    expect(actionClassForProposalType(proposal.proposalType)).toBe('comms');
    const payload = proposal.payload as Record<string, unknown>;
    expect(payload.customerId).toBe(CUSTOMER_ID);
    expect(payload.channel).toBe('sms');
    expect(payload.body).toBe('the part arrived, we can come thursday morning');
    expect(missingFieldsFor(proposal)).toEqual([]);
  });

  it('an unresolved customer reference (no context.customerId) gates with a FLAT customerId key', async () => {
    const { proposal } = await new SendCustomerMessageTaskHandler().handle(
      ctx({ existingEntities: { customerMessageBody: 'the part arrived' } }),
    );

    expect(missingFieldsFor(proposal)).toContain('customerId');
    expect(missingFieldsFor(proposal).every((f) => !f.includes(' '))).toBe(true);
  });

  it('a missing body gates with a FLAT body key', async () => {
    const { proposal } = await new SendCustomerMessageTaskHandler().handle(
      ctx({ customerId: CUSTOMER_ID, existingEntities: {} }),
    );

    expect(missingFieldsFor(proposal)).toContain('body');
    const payload = proposal.payload as Record<string, unknown>;
    expect(payload.body).toBeUndefined();
  });

  it('a whitespace-only spoken body is not trusted as real content (gates on body)', async () => {
    const { proposal } = await new SendCustomerMessageTaskHandler().handle(
      ctx({ customerId: CUSTOMER_ID, existingEntities: { customerMessageBody: '   ' } }),
    );

    expect(missingFieldsFor(proposal)).toContain('body');
  });

  it('a stated customerMessageChannel overrides the sms default', async () => {
    const { proposal } = await new SendCustomerMessageTaskHandler().handle(
      ctx({
        customerId: CUSTOMER_ID,
        existingEntities: {
          customerMessageBody: 'the inspection passed',
          customerMessageChannel: 'email',
        },
      }),
    );

    const payload = proposal.payload as Record<string, unknown>;
    expect(payload.channel).toBe('email');
  });

  it('with a gateway wired, the rewritten text (not the raw spoken text) rides the payload', async () => {
    const gateway = gatewayReturning('Your part arrived — we can come Thursday morning.');
    const { proposal } = await new SendCustomerMessageTaskHandler(gateway).handle(
      ctx({
        customerId: CUSTOMER_ID,
        existingEntities: { customerMessageBody: 'the part arrived we can come thursday morning' },
      }),
    );

    const payload = proposal.payload as Record<string, unknown>;
    expect(payload.body).toBe('Your part arrived — we can come Thursday morning.');
    expect(gateway.complete).toHaveBeenCalledTimes(1);
  });

  it('the rewrite system prompt instructs the model not to add promises, prices, or times the operator did not say', async () => {
    const gateway = gatewayReturning('Your part arrived.');
    await new SendCustomerMessageTaskHandler(gateway).handle(
      ctx({
        customerId: CUSTOMER_ID,
        existingEntities: { customerMessageBody: 'the part arrived' },
      }),
    );

    const call = (gateway.complete as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const systemMessage = call.messages.find((m: { role: string }) => m.role === 'system');
    expect(systemMessage.content).toBe(
      'Rewrite the operator\'s spoken message as a short, polite customer message. Do not add promises, prices, or times the operator did not say.',
    );
  });

  it('a gateway failure degrades to the verbatim spoken body — never blocks, never fabricates', async () => {
    const gateway = throwingGateway();
    const { proposal } = await new SendCustomerMessageTaskHandler(gateway).handle(
      ctx({
        customerId: CUSTOMER_ID,
        existingEntities: { customerMessageBody: 'the part arrived' },
      }),
    );

    const payload = proposal.payload as Record<string, unknown>;
    expect(payload.body).toBe('the part arrived');
    expect(missingFieldsFor(proposal)).toEqual([]);
  });

  it('no gateway wired never calls it and passes the spoken body through verbatim', async () => {
    const { proposal } = await new SendCustomerMessageTaskHandler(undefined).handle(
      ctx({
        customerId: CUSTOMER_ID,
        existingEntities: { customerMessageBody: 'we are finished, the gate is locked' },
      }),
    );

    const payload = proposal.payload as Record<string, unknown>;
    expect(payload.body).toBe('we are finished, the gate is locked');
  });
});
