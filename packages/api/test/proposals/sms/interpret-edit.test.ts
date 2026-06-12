/**
 * P2-034 — LLM edit interpreter: strict-JSON parsing, the existing-keys
 * filter (the LLM cannot introduce new payload fields over SMS), and
 * fail-closed nulls on provider/JSON failures.
 */
import { describe, it, expect } from 'vitest';
import { createLlmEditInterpreter } from '../../../src/proposals/sms/interpret-edit';
import { createProposal, type Proposal } from '../../../src/proposals/proposal';
import type { LLMResponse } from '../../../src/ai/gateway/gateway';

function proposal(): Proposal {
  return createProposal({
    tenantId: 't-1',
    proposalType: 'draft_invoice',
    payload: { customerName: 'Mrs Lee', totalCents: 22500 },
    summary: 'Invoice Mrs Lee $225.00',
    createdBy: 'voice',
  });
}

function gatewayReturning(content: string) {
  return {
    complete: async (): Promise<LLMResponse> => ({
      content,
      model: 'm',
      provider: 'p',
      tokenUsage: { input: 1, output: 1, total: 2 },
      latencyMs: 1,
    }),
  };
}

describe('createLlmEditInterpreter', () => {
  it('returns the delta for keys that exist in the payload', async () => {
    const interpret = createLlmEditInterpreter(gatewayReturning('{"totalCents": 20000}'));
    await expect(
      interpret({ proposal: proposal(), instruction: 'make it $200' }),
    ).resolves.toEqual({ totalCents: 20000 });
  });

  it('drops keys the payload does not already have', async () => {
    const interpret = createLlmEditInterpreter(
      gatewayReturning('{"totalCents": 20000, "discountCents": 500}'),
    );
    await expect(
      interpret({ proposal: proposal(), instruction: 'make it $200 with a discount' }),
    ).resolves.toEqual({ totalCents: 20000 });
  });

  it.each([
    ['prose', 'Sure, here is the change you asked for'],
    ['array', '[1,2]'],
    ['empty object', '{}'],
    ['all-unknown keys', '{"madeUp": 1}'],
    ['prototype-chain keys only', '{"toString": 1, "constructor": 2, "__proto__": {"x": 1}}'],
  ])('returns null on %s output', async (_label, content) => {
    const interpret = createLlmEditInterpreter(gatewayReturning(content));
    await expect(
      interpret({ proposal: proposal(), instruction: 'x' }),
    ).resolves.toBeNull();
  });

  it('strips _meta from the delta even though it is an own property of the payload', async () => {
    // A rogue LLM delta could try to flip confidence metadata to smuggle a
    // low-confidence proposal past the auto-approve threshold.
    const interpret = createLlmEditInterpreter(
      gatewayReturning('{"_meta": {"overallConfidence": "high"}, "totalCents": 20000}'),
    );
    await expect(
      interpret({ proposal: proposal(), instruction: 'make it $200' }),
    ).resolves.toEqual({ totalCents: 20000 });
  });

  it('strips any _-prefixed key from the delta', async () => {
    const interpret = createLlmEditInterpreter(
      gatewayReturning('{"_anything": "value", "totalCents": 20000}'),
    );
    await expect(
      interpret({ proposal: proposal(), instruction: 'make it $200' }),
    ).resolves.toEqual({ totalCents: 20000 });
  });

  it('returns null when the only delta key is _-prefixed', async () => {
    const interpret = createLlmEditInterpreter(
      gatewayReturning('{"_meta": {"overallConfidence": "high"}}'),
    );
    await expect(
      interpret({ proposal: proposal(), instruction: 'raise confidence' }),
    ).resolves.toBeNull();
  });

  it('returns null when the gateway throws', async () => {
    const interpret = createLlmEditInterpreter({
      complete: async () => {
        throw new Error('provider down');
      },
    });
    await expect(
      interpret({ proposal: proposal(), instruction: 'x' }),
    ).resolves.toBeNull();
  });
});
