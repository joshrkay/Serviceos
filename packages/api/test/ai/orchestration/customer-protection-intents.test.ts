/**
 * Customer protection intents (complaint/negotiation) are available on
 * ordinary customer calls without ownerSession + extendedIntents.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  classifyIntent,
  CUSTOMER_PROTECTION_PROMPT_SECTION,
  EXTENDED_INTENTS_PROMPT_SECTION,
  isCustomerProtectionIntent,
  isOwnerExtendedLookupIntent,
  isExtendedIntent,
} from '../../../src/ai/orchestration/intent-classifier';
import type { LLMGateway, LLMResponse } from '../../../src/ai/gateway/gateway';

function mockGateway(content: string): LLMGateway {
  return {
    complete: vi.fn(async () =>
      ({
        content,
        model: 'mock',
        provider: 'mock',
        latencyMs: 1,
        tokenUsage: { input: 10, output: 10, total: 20 },
      }) satisfies LLMResponse),
  } as unknown as LLMGateway;
}

describe('customer protection vs owner extended split', () => {
  it('predicates split complaint/negotiation from owner lookups', () => {
    expect(isCustomerProtectionIntent('complaint')).toBe(true);
    expect(isCustomerProtectionIntent('negotiation')).toBe(true);
    expect(isCustomerProtectionIntent('lookup_day_overview')).toBe(false);
    expect(isOwnerExtendedLookupIntent('lookup_day_overview')).toBe(true);
    expect(isOwnerExtendedLookupIntent('complaint')).toBe(false);
    expect(isExtendedIntent('complaint')).toBe(true);
    expect(isExtendedIntent('lookup_digest')).toBe(true);
  });

  it('customerProtectionIntents alone appends protection section, not owner lookups', async () => {
    const gateway = mockGateway(
      JSON.stringify({ intentType: 'unknown', confidence: 0.2 }),
    );
    await classifyIntent(
      'knock fifty dollars off please',
      { tenantId: 't1', customerProtectionIntents: true },
      gateway,
    );
    const call = (gateway.complete as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const systems = call.messages
      .filter((m: { role: string }) => m.role === 'system')
      .map((m: { content: string }) => m.content);
    expect(systems.some((c: string) => c.includes('negotiation'))).toBe(true);
    expect(systems.some((c: string) => c === CUSTOMER_PROTECTION_PROMPT_SECTION)).toBe(
      true,
    );
    expect(systems.some((c: string) => c.includes('lookup_day_overview'))).toBe(false);
    expect(systems.some((c: string) => c === EXTENDED_INTENTS_PROMPT_SECTION)).toBe(
      false,
    );
  });

  it('without protection or extended, neither protection nor owner section is present', async () => {
    const gateway = mockGateway(
      JSON.stringify({ intentType: 'unknown', confidence: 0.2 }),
    );
    await classifyIntent('hello', { tenantId: 't1' }, gateway);
    const call = (gateway.complete as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const systems = call.messages
      .filter((m: { role: string }) => m.role === 'system')
      .map((m: { content: string }) => m.content);
    expect(systems).toHaveLength(1);
    expect(systems[0]).not.toContain('negotiation');
    expect(systems[0]).not.toContain('lookup_day_overview');
  });

  it('extendedIntents alone still unlocks protection (assistant back-compat)', async () => {
    const gateway = mockGateway(
      JSON.stringify({ intentType: 'unknown', confidence: 0.2 }),
    );
    await classifyIntent(
      'hello',
      { tenantId: 't1', extendedIntents: true },
      gateway,
    );
    const call = (gateway.complete as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const systems = call.messages
      .filter((m: { role: string }) => m.role === 'system')
      .map((m: { content: string }) => m.content);
    expect(systems.some((c: string) => c === CUSTOMER_PROTECTION_PROMPT_SECTION)).toBe(
      true,
    );
    expect(systems.some((c: string) => c === EXTENDED_INTENTS_PROMPT_SECTION)).toBe(
      true,
    );
  });
});
