import { describe, it, expect } from 'vitest';
import { MockLLMProvider, scriptHermeticResponse } from '../../../src/ai/providers/mock';
import { createHermeticMockLLMGateway } from '../../../src/ai/gateway/factory';
import type { LLMRequest } from '../../../src/ai/gateway/gateway';

function req(taskType: string, userText: string): LLMRequest {
  return {
    taskType,
    messages: [{ role: 'user', content: userText }],
  };
}

describe('scriptHermeticResponse', () => {
  it('classifies create_customer with a display name', () => {
    const raw = scriptHermeticResponse(
      req('classify_intent', 'Create a customer named Jane Doe'),
    );
    const parsed = JSON.parse(raw) as {
      intentType: string;
      confidence: number;
      extractedEntities: { displayName: string };
    };
    expect(parsed.intentType).toBe('create_customer');
    expect(parsed.confidence).toBeGreaterThan(0.8);
    expect(parsed.extractedEntities.displayName).toContain('Jane');
  });

  it('classifies draft_estimate and draft_invoice', () => {
    expect(
      JSON.parse(scriptHermeticResponse(req('classify_intent', 'Draft an estimate for Acme'))).intentType,
    ).toBe('draft_estimate');
    expect(
      JSON.parse(scriptHermeticResponse(req('classify_intent', 'Create an invoice for Acme'))).intentType,
    ).toBe('create_invoice');
  });

  it('returns unitPrice (cents) for draft_estimate completions', () => {
    const parsed = JSON.parse(
      scriptHermeticResponse(req('draft_estimate', 'Estimate for Acme HVAC')),
    ) as { lineItems: Array<{ unitPrice: number }> };
    expect(parsed.lineItems[0]?.unitPrice).toBe(15000);
  });
});

describe('MockLLMProvider hermetic mode', () => {
  it('scripts classify_intent instead of the fixed defaultResponse', async () => {
    const provider = new MockLLMProvider('{"intentType":"unknown","confidence":0}', {
      hermetic: true,
    });
    const res = await provider.complete(req('classify_intent', 'Add a new customer named Sam'));
    expect(JSON.parse(res.content).intentType).toBe('create_customer');
  });

  it('createHermeticMockLLMGateway routes through the scripted provider', async () => {
    const { gateway, provider } = createHermeticMockLLMGateway();
    expect(provider.name).toBe('mock');
    const res = await gateway.complete({
      taskType: 'classify_intent',
      tenantId: 'tenant-hermetic-test',
      messages: [{ role: 'user', content: 'Create a customer named Pat Lee' }],
    });
    expect(JSON.parse(res.content).intentType).toBe('create_customer');
  });
});
