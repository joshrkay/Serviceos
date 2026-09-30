/**
 * #1468 — the booking / emergency intents must ask for the caller's problem
 * and the service address, and the classifier must return them.
 *
 * Live slot eval after #1470 (run 36516369060): problem_description F1 15%,
 * address recall 44%. The prompt only asked create_appointment for a short
 * `jobTitle`, asked emergency_dispatch for nothing, and asked no intent but
 * create_customer / add_service_location for an address.
 *
 * Seam: classifyIntent with a stub gateway — the test observes the system
 * message the classifier sends and the entities it returns. The live model's
 * extraction quality is measured by the live slot eval, not here.
 */
import { describe, it, expect, vi } from 'vitest';
import { classifyIntent } from '../../../src/ai/orchestration/intent-classifier';
import type { ClassifierProfile } from '../../../src/ai/orchestration/classifier-profile';
import type { LLMGateway, LLMResponse } from '../../../src/ai/gateway/gateway';

function stubGateway(reply: Record<string, unknown>): LLMGateway {
  return {
    complete: vi.fn(async () => ({
      content: JSON.stringify(reply),
      model: 'stub-model',
      provider: 'stub',
      tokenUsage: { input: 100, output: 50, total: 150 },
      latencyMs: 1,
    } satisfies LLMResponse)),
  } as unknown as LLMGateway;
}

const BOOKING_CALL =
  "Hi, this is Dana Ruiz. The water heater in the garage is leaking from the bottom. " +
  "I'm at 88 Cedar Lane, Mesa. Could someone come out Thursday morning?";

describe('#1468 — booking calls return the problem and the service address', () => {
  it('classifyIntent returns problemDescription and serviceAddress the model extracted on create_appointment', async () => {
    const gateway = stubGateway({
      intentType: 'create_appointment',
      confidence: 0.92,
      reasoning: 'stub',
      extractedEntities: {
        customerName: 'Dana Ruiz',
        jobTitle: 'Water heater repair',
        problemDescription: 'water heater in the garage leaking from the bottom',
        serviceAddress: '88 Cedar Lane, Mesa',
        dateTimeDescription: 'Thursday morning',
      },
    });
    const res = await classifyIntent(BOOKING_CALL, { tenantId: 't1' }, gateway);
    expect(res.extractedEntities?.problemDescription).toBe(
      'water heater in the garage leaking from the bottom',
    );
    expect(res.extractedEntities?.serviceAddress).toBe('88 Cedar Lane, Mesa');
  });

  async function systemPromptSent(profile?: ClassifierProfile): Promise<string> {
    const gateway = stubGateway({ intentType: 'unknown', confidence: 0.3, reasoning: 'stub' });
    await classifyIntent(
      BOOKING_CALL,
      { tenantId: 't1', ...(profile ? { classifierProfile: profile } : {}) },
      gateway,
    );
    const call = (gateway.complete as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
      messages: Array<{ role: string; content: string }>;
    };
    return call.messages[0].content;
  }

  function block(prompt: string, intent: string): string {
    const m = prompt.match(new RegExp(`^- "${intent}"[\\s\\S]*?(?=^- ")`, 'm'));
    expect(m, `${intent} block is advertised`).not.toBeNull();
    return m![0];
  }

  function entityLine(prompt: string, key: string): string | undefined {
    return prompt.split('\n').find((l) => l.trimStart().startsWith(`"${key}":`));
  }

  it.each([
    ['operator', undefined],
    ['caller', 'caller' as const],
  ])('%s: the create_appointment block asks for problemDescription and serviceAddress', async (_n, profile) => {
    const b = block(await systemPromptSent(profile), 'create_appointment');
    expect(b).toContain('problemDescription');
    expect(b).toContain('serviceAddress');
  });

  it.each([
    ['operator', undefined],
    ['caller', 'caller' as const],
  ])('%s: the entity dictionary advertises problemDescription and serviceAddress for bookings', async (_n, profile) => {
    const prompt = await systemPromptSent(profile);
    expect(entityLine(prompt, 'problemDescription')).toMatch(/create_appointment/);
    expect(entityLine(prompt, 'serviceAddress')).toMatch(/create_appointment/);
  });

  it('operator: the emergency_dispatch block asks for problemDescription and serviceAddress', async () => {
    const b = block(await systemPromptSent(), 'emergency_dispatch');
    expect(b).toContain('problemDescription');
    expect(b).toContain('serviceAddress');
  });
});
