/**
 * Intent classifier unit tests.
 *
 * Covers Phase 1 of the voice-to-action plan: transcript → task-type
 * decision. The classifier wraps the LLM gateway and returns a
 * structured classification. If confidence is below threshold it must
 * return 'unknown' so the caller asks a clarifying question instead
 * of routing to a handler.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  classifyIntent,
  IntentClassification,
  IntentType,
  CLASSIFIER_CONFIDENCE_THRESHOLD,
  parseClassifierJson,
} from '../../../src/ai/orchestration/intent-classifier';
import { LLMGateway, LLMResponse } from '../../../src/ai/gateway/gateway';

function mockGateway(jsonContent: string): LLMGateway {
  const gateway = {
    complete: vi.fn(async () => ({
      content: jsonContent,
      model: 'mock-model',
      provider: 'mock',
      tokenUsage: { input: 100, output: 50, total: 150 },
      latencyMs: 42,
    } satisfies LLMResponse)),
  } as unknown as LLMGateway;
  return gateway;
}

describe('intent-classifier — parseClassifierJson', () => {
  it('parses well-formed classification', () => {
    const out = parseClassifierJson(JSON.stringify({
      intentType: 'create_invoice',
      confidence: 0.92,
      reasoning: 'user said "create an invoice for Acme"',
      extractedEntities: { customerName: 'Acme' },
    }));
    expect(out?.intentType).toBe('create_invoice');
    expect(out?.confidence).toBe(0.92);
  });

  it('returns null on invalid JSON', () => {
    expect(parseClassifierJson('not json')).toBeNull();
    expect(parseClassifierJson('{"unclosed":')).toBeNull();
  });

  it('returns null when intentType is not a supported value', () => {
    const out = parseClassifierJson(JSON.stringify({
      intentType: 'delete_everything',
      confidence: 0.99,
    }));
    expect(out).toBeNull();
  });

  it('clamps confidence to [0,1]', () => {
    const hi = parseClassifierJson(JSON.stringify({ intentType: 'unknown', confidence: 1.5 }));
    expect(hi?.confidence).toBe(1);
    const lo = parseClassifierJson(JSON.stringify({ intentType: 'unknown', confidence: -0.3 }));
    expect(lo?.confidence).toBe(0);
  });

  it('defaults confidence to 0 when missing', () => {
    const out = parseClassifierJson(JSON.stringify({ intentType: 'unknown' }));
    expect(out?.confidence).toBe(0);
  });
});

describe('intent-classifier — classifyIntent', () => {
  const tenantId = 'tenant-1';

  const cases: Array<{
    transcript: string;
    expectedIntent: IntentType;
    llmResponse: Partial<IntentClassification>;
  }> = [
    {
      transcript: 'Create an invoice for Acme Plumbing for 450 dollars',
      expectedIntent: 'create_invoice',
      llmResponse: {
        intentType: 'create_invoice',
        confidence: 0.92,
        extractedEntities: { customerName: 'Acme Plumbing', amount: 45000 },
      },
    },
    {
      transcript: 'Draft an estimate for the Johnson water heater job',
      expectedIntent: 'draft_estimate',
      llmResponse: {
        intentType: 'draft_estimate',
        confidence: 0.88,
        extractedEntities: { customerName: 'Johnson', jobReference: 'water heater' },
      },
    },
    {
      transcript: 'Schedule a follow up with Mrs Lee for next Tuesday at 2pm',
      expectedIntent: 'create_appointment',
      llmResponse: {
        intentType: 'create_appointment',
        confidence: 0.85,
        extractedEntities: {
          customerName: 'Mrs Lee',
          dateTimeDescription: 'next Tuesday at 2pm',
        },
      },
    },
    {
      transcript: 'Add a water heater install for 850 to invoice INV-0042',
      expectedIntent: 'update_invoice',
      llmResponse: {
        intentType: 'update_invoice',
        confidence: 0.9,
        extractedEntities: {
          jobReference: 'INV-0042',
          lineItemDescriptions: ['water heater install'],
        },
      },
    },
    {
      transcript: 'Remove the plumbing repair from invoice INV-0042',
      expectedIntent: 'update_invoice',
      llmResponse: {
        intentType: 'update_invoice',
        confidence: 0.88,
        extractedEntities: {
          jobReference: 'INV-0042',
          lineItemDescriptions: ['plumbing repair'],
        },
      },
    },
  ];

  for (const { transcript, expectedIntent, llmResponse } of cases) {
    it(`classifies: "${transcript.slice(0, 40)}..." → ${expectedIntent}`, async () => {
      const gateway = mockGateway(JSON.stringify(llmResponse));
      const result = await classifyIntent(transcript, { tenantId }, gateway);
      expect(result.intentType).toBe(expectedIntent);
      expect(result.confidence).toBeGreaterThan(CLASSIFIER_CONFIDENCE_THRESHOLD);
    });
  }

  it('returns unknown when LLM confidence falls below threshold', async () => {
    const gateway = mockGateway(
      JSON.stringify({ intentType: 'create_invoice', confidence: 0.4 })
    );
    const result = await classifyIntent('um, do the thing with the stuff', { tenantId }, gateway);
    expect(result.intentType).toBe('unknown');
    expect(result.confidence).toBeLessThan(CLASSIFIER_CONFIDENCE_THRESHOLD);
  });

  it('returns unknown when LLM returns garbage JSON', async () => {
    const gateway = mockGateway('not json at all');
    const result = await classifyIntent('create an invoice', { tenantId }, gateway);
    expect(result.intentType).toBe('unknown');
    expect(result.confidence).toBe(0);
  });

  it('returns unknown when LLM returns an unsupported intentType', async () => {
    const gateway = mockGateway(
      JSON.stringify({ intentType: 'send_invoice', confidence: 0.95 })
    );
    const result = await classifyIntent('send the invoice', { tenantId }, gateway);
    expect(result.intentType).toBe('unknown');
  });

  it('passes taskType "classify_intent" to the gateway', async () => {
    const gateway = mockGateway(
      JSON.stringify({ intentType: 'create_invoice', confidence: 0.9 })
    );
    await classifyIntent('create an invoice', { tenantId }, gateway);
    const call = (gateway.complete as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.taskType).toBe('classify_intent');
    expect(call.responseFormat).toBe('json');
    expect(call.messages[0].role).toBe('system');
    expect(call.messages[1]).toEqual({ role: 'user', content: expect.any(String) });
  });

  it('handles empty transcript gracefully', async () => {
    const gateway = mockGateway(JSON.stringify({ intentType: 'unknown', confidence: 0 }));
    const result = await classifyIntent('', { tenantId }, gateway);
    expect(result.intentType).toBe('unknown');
    // Should not call the LLM with an empty transcript — cheap short-circuit.
    expect(gateway.complete).not.toHaveBeenCalled();
  });

  it('handles whitespace-only transcript gracefully', async () => {
    const gateway = mockGateway(JSON.stringify({ intentType: 'unknown', confidence: 0 }));
    const result = await classifyIntent('   \n\t  ', { tenantId }, gateway);
    expect(result.intentType).toBe('unknown');
    expect(gateway.complete).not.toHaveBeenCalled();
  });

  it('surfaces LLM errors as thrown exceptions (caller decides retry policy)', async () => {
    const gateway = {
      complete: vi.fn(async () => {
        throw new Error('upstream 502');
      }),
    } as unknown as LLMGateway;
    await expect(
      classifyIntent('create an invoice', { tenantId }, gateway)
    ).rejects.toThrow(/upstream 502/);
  });
});
