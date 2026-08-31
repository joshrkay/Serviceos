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
  isLookupIntent,
  isInventoryLoggingPhrasing,
  INTENT_TAXONOMY_VERSION,
  SUPPORTED_INTENTS,
} from '../../../src/ai/orchestration/intent-classifier';
import { LLMGateway, LLMResponse } from '../../../src/ai/gateway/gateway';
import { formatVerticalForCallerPrompt } from '../../../src/verticals/context-assembly';
import { createHvacPack } from '../../../src/verticals/packs/hvac';
import { createPlumbingPack } from '../../../src/verticals/packs/plumbing';
import { TAU_INT } from '../../../src/ai/agents/customer-calling/transitions';

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
    {
      transcript: 'Add a site visit for 150 to estimate EST-0001',
      expectedIntent: 'update_estimate',
      llmResponse: {
        intentType: 'update_estimate',
        confidence: 0.9,
        extractedEntities: {
          jobReference: 'EST-0001',
          lineItemDescriptions: ['site visit'],
        },
      },
    },
    {
      transcript: 'Remove the old heater from estimate EST-0001',
      expectedIntent: 'update_estimate',
      llmResponse: {
        intentType: 'update_estimate',
        confidence: 0.86,
        extractedEntities: {
          jobReference: 'EST-0001',
          lineItemDescriptions: ['old heater'],
        },
      },
    },
    {
      transcript: 'Create a new customer named Alex',
      expectedIntent: 'create_customer',
      llmResponse: {
        intentType: 'create_customer',
        confidence: 0.9,
        extractedEntities: { displayName: 'Alex' },
      },
    },
    {
      transcript: 'Add customer Acme Corp, email alex@acme.com',
      expectedIntent: 'create_customer',
      llmResponse: {
        intentType: 'create_customer',
        confidence: 0.92,
        extractedEntities: { displayName: 'Acme Corp', email: 'alex@acme.com' },
      },
    },
    {
      transcript: 'New customer: Sarah, phone 555-0100',
      expectedIntent: 'create_customer',
      llmResponse: {
        intentType: 'create_customer',
        confidence: 0.91,
        extractedEntities: { displayName: 'Sarah', phone: '555-0100' },
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
    // Low-confidence path tags the reason and preserves the guessed
    // intent so the downstream clarification proposal can render a
    // "did you mean: create invoice?" suggestion chip.
    expect(result.unknownReason).toBe('low_confidence');
    expect(result.lowConfidenceIntent).toBe('create_invoice');
  });

  it('returns unknown when LLM returns garbage JSON', async () => {
    const gateway = mockGateway('not json at all');
    const result = await classifyIntent('create an invoice', { tenantId }, gateway);
    expect(result.intentType).toBe('unknown');
    expect(result.confidence).toBe(0);
    expect(result.unknownReason).toBe('parse_failed');
  });

  it('tags unknown_intent reason when classifier picks unknown at adequate confidence', async () => {
    const gateway = mockGateway(
      JSON.stringify({ intentType: 'unknown', confidence: 0.9 })
    );
    const result = await classifyIntent('send that invoice', { tenantId }, gateway);
    expect(result.intentType).toBe('unknown');
    expect(result.unknownReason).toBe('unknown_intent');
  });

  it('tags empty_transcript reason without calling the LLM', async () => {
    const gateway = mockGateway('{"intentType":"unknown","confidence":0}');
    const result = await classifyIntent('   ', { tenantId }, gateway);
    expect(result.intentType).toBe('unknown');
    expect(result.unknownReason).toBe('empty_transcript');
    expect(gateway.complete).not.toHaveBeenCalled();
  });

  it('passes tenantId to the gateway in request metadata', async () => {
    const gateway = mockGateway(
      JSON.stringify({ intentType: 'create_invoice', confidence: 0.9 })
    );
    await classifyIntent('create an invoice', { tenantId: 'tenant-xyz' }, gateway);
    const call = (gateway.complete as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.metadata).toEqual({ tenantId: 'tenant-xyz' });
  });

  it('uses the dedicated voice-safe classifier deadline instead of the lightweight tier deadline', async () => {
    const gateway = mockGateway(
      JSON.stringify({ intentType: 'create_invoice', confidence: 0.9 })
    );

    await classifyIntent('create an invoice', { tenantId: 'tenant-xyz' }, gateway);

    const call = (gateway.complete as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.deadlineMs).toBe(4_000);
  });

  // P0 scaling bug regression: the resilience wrappers (ProviderTenantQuotaWrapper /
  // CachingGatewayWrapper) read request.tenantId at the TOP LEVEL of the LLMRequest,
  // not metadata.tenantId. Nesting it only in metadata collapsed every tenant's
  // classify_intent calls onto the shared "system" quota bucket (concurrency 8 for
  // the whole platform) and, if the gateway cache is ever enabled, onto a shared
  // cache key (cross-tenant leak of classification + extracted entities).
  it('passes tenantId as a TOP-LEVEL field on the LLMRequest (not only in metadata)', async () => {
    const gateway = mockGateway(
      JSON.stringify({ intentType: 'create_invoice', confidence: 0.9 })
    );
    await classifyIntent('create an invoice', { tenantId: 'tenant-xyz' }, gateway);
    const call = (gateway.complete as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.tenantId).toBe('tenant-xyz');
    // Still present in metadata for any downstream reader that expects it there.
    expect(call.metadata).toEqual({ tenantId: 'tenant-xyz' });
  });

  it('returns unknown when LLM returns an unsupported intentType', async () => {
    // Use a clearly-never-supported intent name so this test doesn't
    // regress whenever we expand the supported-intent list. (Earlier
    // it used `send_invoice`, which is now a real supported intent.)
    const gateway = mockGateway(
      JSON.stringify({ intentType: 'delete_database', confidence: 0.95 })
    );
    const result = await classifyIntent('drop everything', { tenantId }, gateway);
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

  describe('§3B vertical-aware system prompt', () => {
    it('emits a single system message when no vertical context is supplied', async () => {
      const gateway = mockGateway(
        JSON.stringify({ intentType: 'create_invoice', confidence: 0.9 })
      );
      await classifyIntent('create an invoice', { tenantId }, gateway);
      const call = (gateway.complete as ReturnType<typeof vi.fn>).mock.calls[0][0];
      const systemMessages = call.messages.filter((m: { role: string }) => m.role === 'system');
      expect(systemMessages).toHaveLength(1);
    });

    it('appends a second system message carrying the vertical prompt section', async () => {
      const gateway = mockGateway(
        JSON.stringify({ intentType: 'create_appointment', confidence: 0.85 })
      );
      const verticalPromptSection = [
        'Service vertical: HVAC Professional',
        'Equipment and terminology recognized:',
        '  - Furnace (heater, heating unit)',
      ].join('\n');
      await classifyIntent(
        'my heater is broken',
        { tenantId, verticalPromptSection },
        gateway,
      );
      const call = (gateway.complete as ReturnType<typeof vi.fn>).mock.calls[0][0];
      const systemMessages = call.messages.filter((m: { role: string }) => m.role === 'system');
      expect(systemMessages).toHaveLength(2);
      expect(systemMessages[1].content).toContain('Tenant vertical context');
      expect(systemMessages[1].content).toContain('Furnace (heater, heating unit)');
      // User message is still the last entry.
      expect(call.messages[call.messages.length - 1]).toEqual({
        role: 'user',
        content: 'my heater is broken',
      });
    });

    it('skips the vertical message when the section is empty / whitespace', async () => {
      const gateway = mockGateway(
        JSON.stringify({ intentType: 'create_invoice', confidence: 0.9 })
      );
      await classifyIntent(
        'create an invoice',
        { tenantId, verticalPromptSection: '   \n\t  ' },
        gateway,
      );
      const call = (gateway.complete as ReturnType<typeof vi.fn>).mock.calls[0][0];
      const systemMessages = call.messages.filter((m: { role: string }) => m.role === 'system');
      expect(systemMessages).toHaveLength(1);
    });

    // End-to-end producer → consumer seam. The other tests in this block
    // hand-craft the vertical string. This one threads the real
    // formatVerticalForCallerPrompt() output for HVAC vs. plumbing packs
    // through classifyIntent() so a regression in either side
    // (helper renames, missing terminology, dropped wire-up) flips this
    // test red — locking the §3B integration the calling agent depends on.
    it('integration — HVAC vs plumbing pack output reaches the classifier prompt', async () => {
      const hvacGateway = mockGateway(
        JSON.stringify({ intentType: 'create_appointment', confidence: 0.9 }),
      );
      await classifyIntent(
        'my heater is broken',
        { tenantId, verticalPromptSection: formatVerticalForCallerPrompt(createHvacPack()) },
        hvacGateway,
      );
      const hvacCall = (hvacGateway.complete as ReturnType<typeof vi.fn>).mock.calls[0][0];
      const hvacSystem = hvacCall.messages.filter((m: { role: string }) => m.role === 'system');
      expect(hvacSystem).toHaveLength(2);
      expect(hvacSystem[1].content).toContain('Furnace');
      expect(hvacSystem[1].content).toContain('Air Conditioner');
      expect(hvacSystem[1].content).not.toContain('Water Heater');

      const plumbingGateway = mockGateway(
        JSON.stringify({ intentType: 'create_appointment', confidence: 0.9 }),
      );
      await classifyIntent(
        'my pipe is leaking',
        { tenantId, verticalPromptSection: formatVerticalForCallerPrompt(createPlumbingPack()) },
        plumbingGateway,
      );
      const plumbingCall = (plumbingGateway.complete as ReturnType<typeof vi.fn>).mock.calls[0][0];
      const plumbingSystem = plumbingCall.messages.filter((m: { role: string }) => m.role === 'system');
      expect(plumbingSystem).toHaveLength(2);
      expect(plumbingSystem[1].content).not.toContain('Furnace');
    });
  });

  describe('§3C planPromptSection', () => {
    it('appends a third system message with the caller plan context', async () => {
      const gateway = mockGateway(
        JSON.stringify({ intentType: 'create_appointment', confidence: 0.9 })
      );
      await classifyIntent(
        'when is my next visit',
        {
          tenantId,
          verticalPromptSection: 'Service vertical: HVAC',
          planPromptSection: 'Caller is on an active maintenance plan.\nPlans: Gold Membership',
        },
        gateway,
      );
      const call = (gateway.complete as ReturnType<typeof vi.fn>).mock.calls[0][0];
      const systemMessages = call.messages.filter((m: { role: string }) => m.role === 'system');
      expect(systemMessages).toHaveLength(3);
      expect(systemMessages[1].content).toContain('Tenant vertical context');
      expect(systemMessages[2].content).toContain('Caller plan context');
      expect(systemMessages[2].content).toContain('Gold Membership');
    });

    it('emits plan section only (no vertical) when only plan is supplied', async () => {
      const gateway = mockGateway(
        JSON.stringify({ intentType: 'create_appointment', confidence: 0.9 })
      );
      await classifyIntent(
        'when is my next visit',
        {
          tenantId,
          planPromptSection: 'Caller is on an active maintenance plan.\nPlans: Gold',
        },
        gateway,
      );
      const call = (gateway.complete as ReturnType<typeof vi.fn>).mock.calls[0][0];
      const systemMessages = call.messages.filter((m: { role: string }) => m.role === 'system');
      expect(systemMessages).toHaveLength(2);
      expect(systemMessages[1].content).toContain('Caller plan context');
    });
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

  describe('create_customer', () => {
    it('extracts displayName, email, and phone into the classification', async () => {
      const gateway = mockGateway(
        JSON.stringify({
          intentType: 'create_customer',
          confidence: 0.94,
          extractedEntities: {
            displayName: 'Acme Corp',
            email: 'alex@acme.com',
            phone: '555-0100',
          },
        })
      );
      const result = await classifyIntent(
        'Add customer Acme Corp, email alex@acme.com, phone 555-0100',
        { tenantId },
        gateway
      );
      expect(result.intentType).toBe('create_customer');
      expect(result.extractedEntities?.displayName).toBe('Acme Corp');
      expect(result.extractedEntities?.email).toBe('alex@acme.com');
      expect(result.extractedEntities?.phone).toBe('555-0100');
    });

    it('still classifies as create_customer when only the name is given (clarification, not unknown)', async () => {
      // Missing email/phone must NOT downgrade the intent to 'unknown' —
      // downstream flow owns the clarification prompt.
      const gateway = mockGateway(
        JSON.stringify({
          intentType: 'create_customer',
          confidence: 0.88,
          extractedEntities: { displayName: 'Alex' },
        })
      );
      const result = await classifyIntent('Create a new customer named Alex', { tenantId }, gateway);
      expect(result.intentType).toBe('create_customer');
      expect(result.extractedEntities?.displayName).toBe('Alex');
      expect(result.extractedEntities?.email).toBeUndefined();
      expect(result.extractedEntities?.phone).toBeUndefined();
    });

    it('PR #265 review — "set up an account for my appointment" stays as create_appointment (no false override)', async () => {
      // The deterministic create_customer signup-phrasing regex used
      // to fire on "set up an account" even when the sentence was
      // unambiguously about scheduling. Negative-lookahead now
      // excludes appointment/schedule context.
      const gateway = mockGateway(
        JSON.stringify({
          intentType: 'create_appointment',
          confidence: 0.9,
          extractedEntities: { dateTimeDescription: 'tomorrow at 2pm' },
        })
      );
      const result = await classifyIntent(
        'Could you set up an account for my appointment tomorrow at 2pm?',
        { tenantId },
        gateway
      );
      expect(result.intentType).toBe('create_appointment');
    });

    it('PR #265 review — "add me to the schedule" stays as create_appointment', async () => {
      // The previous /\b(?:add|register)\s+me\b/i was so loose it
      // caught any "add me" phrasing. Tightened to require "to (your) system".
      const gateway = mockGateway(
        JSON.stringify({
          intentType: 'create_appointment',
          confidence: 0.88,
          extractedEntities: { dateTimeDescription: 'next Tuesday' },
        })
      );
      const result = await classifyIntent(
        'Add me to the schedule for next Tuesday',
        { tenantId },
        gateway
      );
      expect(result.intentType).toBe('create_appointment');
    });

    it('PR #265 review — "set up an account please" still classifies as create_customer', async () => {
      // Negative lookahead must NOT swallow legitimate signup phrasings
      // when no appointment/schedule context appears.
      const gateway = mockGateway(
        JSON.stringify({
          intentType: 'unknown',
          confidence: 0.4,
        })
      );
      const result = await classifyIntent(
        'Set up an account please',
        { tenantId },
        gateway
      );
      expect(result.intentType).toBe('create_customer');
    });

    it('PR #265 review — "register me to your system" classifies as create_customer', async () => {
      const gateway = mockGateway(
        JSON.stringify({
          intentType: 'unknown',
          confidence: 0.3,
        })
      );
      const result = await classifyIntent(
        'Please register me to your system',
        { tenantId },
        gateway
      );
      expect(result.intentType).toBe('create_customer');
    });

    it('P18-001 AC-1 — bumps weak create_customer on signup phrasing to ≥ 0.75 (FSM TAU_INT)', async () => {
      const gateway = mockGateway(
        JSON.stringify({
          intentType: 'create_customer',
          confidence: 0.65,
          extractedEntities: { displayName: 'Jane Smith' },
        })
      );
      const result = await classifyIntent(
        "I'd like to sign up as a new customer",
        { tenantId },
        gateway
      );
      expect(result.intentType).toBe('create_customer');
      expect(result.confidence).toBeGreaterThanOrEqual(0.75);
      expect(result.extractedEntities?.displayName).toBe('Jane Smith');
    });

    it('routes genuinely ambiguous input to unknown so clarification can ask for the intent', async () => {
      // "Add Jordan" could mean customer, line item, or team member.
      // When the LLM is not confident, the threshold guardrail must
      // send the transcript to the clarification path, not force a
      // create_customer proposal the operator never asked for.
      const gateway = mockGateway(
        JSON.stringify({
          intentType: 'create_customer',
          confidence: 0.45,
          extractedEntities: { displayName: 'Jordan' },
        })
      );
      const result = await classifyIntent('Add Jordan', { tenantId }, gateway);
      expect(result.intentType).toBe('unknown');
      expect(result.confidence).toBeLessThan(CLASSIFIER_CONFIDENCE_THRESHOLD);
    });
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

describe('U2 — deterministic owner operator commands', () => {
  const tenantId = 'tenant-1';
  const sinkResponse = JSON.stringify({ intentType: 'unknown', confidence: 0.9 });
  const cases: Array<{
    transcript: string;
    intentType: IntentType;
    entities: Record<string, unknown>;
  }> = [
    {
      transcript: 'New customer Maria Alvarez, phone 480-555-0102',
      intentType: 'create_customer',
      entities: { displayName: 'Maria Alvarez', phone: '480-555-0102' },
    },
    {
      transcript: 'Add customer James Patel, email james@patel.co',
      intentType: 'create_customer',
      entities: { displayName: 'James Patel', email: 'james@patel.co' },
    },
    {
      transcript: "Update Alvarez's phone number to 480-555-0199",
      intentType: 'update_customer',
      entities: { customerName: 'Alvarez', updatedPhone: '480-555-0199' },
    },
    {
      transcript: "Fix Mrs Lee's address to 88 Palm Court",
      intentType: 'update_customer',
      entities: { customerName: 'Mrs Lee', updatedAddress: '88 Palm Court' },
    },
    {
      transcript: 'Look up the Khan account',
      intentType: 'lookup_customer',
      entities: { customerName: 'Khan' },
    },
    {
      transcript: 'Convert the Greenfield lead to a customer',
      intentType: 'convert_lead',
      entities: { leadReference: 'Greenfield' },
    },
    {
      transcript: 'Open a job for Alvarez, no AC',
      intentType: 'create_job',
      entities: { customerName: 'Alvarez', jobTitle: 'no AC' },
    },
    {
      transcript: 'Add a trip fee to invoice INV-0042',
      intentType: 'update_invoice',
      entities: {
        jobReference: 'INV-0042',
        lineItemDescriptions: ['trip fee'],
      },
    },
    {
      transcript: 'Quote Khan for a three-ton condenser replacement',
      intentType: 'draft_estimate',
      entities: {
        customerName: 'Khan',
        jobReference: 'three-ton condenser replacement',
      },
    },
    {
      transcript: "Line item ninety dollar contactor on Smith's bill",
      intentType: 'update_invoice',
      entities: {
        customerName: 'Smith',
        lineItemDescriptions: ['ninety dollar contactor'],
      },
    },
    {
      transcript: 'SMS Smith the invoice link',
      intentType: 'send_invoice',
      entities: { customerName: 'Smith' },
    },
  ];

  for (const testCase of cases) {
    it(`short-circuits "${testCase.transcript}" with downstream references`, async () => {
      const gateway = mockGateway(sinkResponse);

      const result = await classifyIntent(
        testCase.transcript,
        { tenantId, ownerSession: true },
        gateway,
      );

      expect(result.intentType).toBe(testCase.intentType);
      expect(result.confidence).toBeGreaterThan(TAU_INT);
      expect(result.extractedEntities).toMatchObject(testCase.entities);
      expect(gateway.complete).not.toHaveBeenCalled();
    });
  }

  it.each([
    ['appointment setup', 'Set up an account for my appointment tomorrow at 2pm', 'create_appointment'],
    ['generic add', 'Add Jordan', 'unknown'],
    ['invoice creation', 'Create an invoice for Alvarez', 'create_invoice'],
  ])('does not capture owner input for %s', async (_label, transcript, modelIntent) => {
    const gateway = mockGateway(
      JSON.stringify({ intentType: modelIntent, confidence: 0.9 }),
    );

    const result = await classifyIntent(
      transcript,
      { tenantId, ownerSession: true },
      gateway,
    );

    expect(result.intentType).toBe(modelIntent);
    expect(gateway.complete).toHaveBeenCalledTimes(1);
  });

  it('does not capture the operator job command outside an owner session', async () => {
    const gateway = mockGateway(sinkResponse);

    const result = await classifyIntent(
      'Open a job for Alvarez, no AC',
      { tenantId, ownerSession: false },
      gateway,
    );

    expect(result.intentType).toBe('unknown');
    expect(gateway.complete).toHaveBeenCalledTimes(1);
  });
});

// ─── RV-071 — owner approval intents ─────────────────────────────────────────

import { OWNER_APPROVAL_PROMPT_SECTION, isVoiceApprovalIntent, isVoiceEditIntent } from '../../../src/ai/orchestration/intent-classifier';

describe('RV-071 — approve_proposal / reject_proposal intents', () => {
  it('parseClassifierJson accepts approve_proposal with a proposalReference', () => {
    const out = parseClassifierJson(JSON.stringify({
      intentType: 'approve_proposal',
      confidence: 0.93,
      reasoning: 'owner asked to approve the Henderson estimate',
      extractedEntities: { proposalReference: 'the Henderson estimate' },
    }));
    expect(out?.intentType).toBe('approve_proposal');
    expect(out?.extractedEntities?.proposalReference).toBe('the Henderson estimate');
  });

  it('parseClassifierJson accepts reject_proposal', () => {
    const out = parseClassifierJson(JSON.stringify({
      intentType: 'reject_proposal',
      confidence: 0.9,
      extractedEntities: { proposalReference: 'the Acme invoice' },
    }));
    expect(out?.intentType).toBe('reject_proposal');
  });

  it('isVoiceApprovalIntent matches exactly the two owner intents', () => {
    expect(isVoiceApprovalIntent('approve_proposal')).toBe(true);
    expect(isVoiceApprovalIntent('reject_proposal')).toBe(true);
    expect(isVoiceApprovalIntent('confirm')).toBe(false);
    expect(isVoiceApprovalIntent('create_invoice')).toBe(false);
    expect(isVoiceApprovalIntent('edit_proposal')).toBe(false);
    expect(isVoiceApprovalIntent(undefined)).toBe(false);
  });

  // RV-225 — edit_proposal owner intent
  it('parseClassifierJson accepts edit_proposal with proposalReference + editInstruction', () => {
    const out = parseClassifierJson(JSON.stringify({
      intentType: 'edit_proposal',
      confidence: 0.91,
      extractedEntities: {
        proposalReference: 'the Henderson estimate',
        editInstruction: 'change the second line to 200 dollars',
      },
    }));
    expect(out?.intentType).toBe('edit_proposal');
    expect(out?.extractedEntities?.proposalReference).toBe('the Henderson estimate');
    expect(out?.extractedEntities?.editInstruction).toBe('change the second line to 200 dollars');
  });

  it('isVoiceEditIntent matches exactly edit_proposal', () => {
    expect(isVoiceEditIntent('edit_proposal')).toBe(true);
    expect(isVoiceEditIntent('approve_proposal')).toBe(false);
    expect(isVoiceEditIntent('update_estimate')).toBe(false);
    expect(isVoiceEditIntent(undefined)).toBe(false);
  });

  it('the owner section documents edit_proposal; the base prompt never does', async () => {
    const gateway = mockGateway(JSON.stringify({
      intentType: 'edit_proposal',
      confidence: 0.9,
      extractedEntities: { editInstruction: 'change it to 200' },
    }));
    const result = await classifyIntent(
      'change the second line to 200 dollars',
      { tenantId: 't1', ownerSession: true },
      gateway,
    );
    expect(result.intentType).toBe('edit_proposal');
    const call = (gateway.complete as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const systemMessages = call.messages.filter((m: { role: string }) => m.role === 'system');
    expect(systemMessages[1].content).toContain('edit_proposal');
    expect(systemMessages[0].content).not.toContain('edit_proposal');
  });

  it('ownerSession: true appends the owner prompt section as a SEPARATE system message', async () => {
    const gateway = mockGateway(JSON.stringify({
      intentType: 'approve_proposal',
      confidence: 0.92,
      extractedEntities: { proposalReference: 'the Henderson estimate' },
    }));

    const result = await classifyIntent(
      'approve the Henderson estimate',
      { tenantId: 't1', ownerSession: true },
      gateway,
    );
    expect(result.intentType).toBe('approve_proposal');

    const call = (gateway.complete as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const systemMessages = call.messages.filter((m: { role: string }) => m.role === 'system');
    expect(systemMessages.length).toBe(2);
    expect(systemMessages[1].content).toBe(OWNER_APPROVAL_PROMPT_SECTION);
    // The BASE prompt is untouched — it must not mention the owner intents.
    expect(systemMessages[0].content).not.toContain('approve_proposal');
  });

  it('without ownerSession the prompt messages are byte-identical to the legacy shape (cassette stability)', async () => {
    const gatewayA = mockGateway('{"intentType":"unknown","confidence":0.9}');
    const gatewayB = mockGateway('{"intentType":"unknown","confidence":0.9}');

    await classifyIntent('approve the Henderson estimate', { tenantId: 't1' }, gatewayA);
    await classifyIntent(
      'approve the Henderson estimate',
      { tenantId: 't1', ownerSession: false },
      gatewayB,
    );

    const messagesA = (gatewayA.complete as ReturnType<typeof vi.fn>).mock.calls[0][0].messages;
    const messagesB = (gatewayB.complete as ReturnType<typeof vi.fn>).mock.calls[0][0].messages;
    expect(messagesB).toEqual(messagesA);
    expect(messagesA.filter((m: { role: string }) => m.role === 'system')).toHaveLength(1);
    for (const m of messagesA) {
      expect(m.content).not.toContain('approve_proposal');
      // RV-225 — the edit intent rides the same owner-only system message;
      // non-owner prompts must stay byte-identical.
      expect(m.content).not.toContain('edit_proposal');
    }
  });
});

// eslint-disable-next-line import/first
import {
  EXTENDED_INTENTS_PROMPT_SECTION,
  EXTENDED_INTENT_TYPES,
  OWNER_EXTENDED_LOOKUP_INTENT_TYPES,
  CUSTOMER_PROTECTION_PROMPT_SECTION,
  matchExtendedIntentPhrase,
} from '../../../src/ai/orchestration/intent-classifier';

// ─── Consistency pin: EXTENDED_INTENT_TYPES ↔ EXTENDED_INTENTS_PROMPT_SECTION ──
//
// Encodes three invariants established by the Architect:
//   1. The set of intent names quoted in EXTENDED_INTENTS_PROMPT_SECTION equals
//      the set of members in EXTENDED_INTENT_TYPES.
//   2. Every EXTENDED_INTENT_TYPES member appears in SUPPORTED_INTENTS.
//   3. Every EXTENDED_INTENT_PHRASES entry is in the read-only-entity-free
//      allowlist {lookup_day_overview, lookup_digest, lookup_pending_items} —
//      i.e. `complaint` (proposal-driving) is excluded.
//
// These tests will fail red if a new extended intent is added to one place
// but not the other, or if a proposal-driving intent is accidentally added
// to the phrase short-circuit list.

describe('consistency pin — EXTENDED_INTENT_TYPES', () => {
  const PHRASE_MATCH_ALLOWLIST = new Set([
    'lookup_day_overview',
    'lookup_digest',
    'lookup_pending_items',
    // #910 — lookup_revenue/lookup_my_day/lookup_leads added to
    // EXTENDED_INTENT_PHRASES; all three are entity-free/read-only (see
    // that table's doc comment), same as the three above.
    'lookup_revenue',
    'lookup_my_day',
    'lookup_leads',
    // #910 completion — lookup_materials (bare, no-job phrasing only) and
    // lookup_catalog (never entity-bearing) added; see the table's doc
    // comment for why lookup_availability/lookup_crew_schedule/
    // lookup_timesheets were deliberately left out.
    'lookup_materials',
    'lookup_catalog',
  ]);

  // Extract quoted intent names from EXTENDED_INTENTS_PROMPT_SECTION.
  // The prompt uses `- "intent_name"` syntax; this regex collects every
  // quoted token on a line that starts with `- "`.
  function intentNamesFromPrompt(section: string): Set<string> {
    const names = new Set<string>();
    for (const line of section.split('\n')) {
      const m = /^-\s+"([a-z_]+)"/.exec(line.trim());
      if (m) names.add(m[1]);
    }
    return names;
  }

  it('quoted intents in EXTENDED_INTENTS_PROMPT_SECTION match owner extended lookups only', () => {
    const fromPrompt = intentNamesFromPrompt(EXTENDED_INTENTS_PROMPT_SECTION);
    const fromSet = new Set(OWNER_EXTENDED_LOOKUP_INTENT_TYPES);
    for (const name of fromPrompt) {
      expect(fromSet.has(name as never), `"${name}" in prompt but not in OWNER_EXTENDED_LOOKUP_INTENT_TYPES`).toBe(true);
    }
    for (const name of fromSet) {
      expect(fromPrompt.has(name), `"${name}" in OWNER_EXTENDED_LOOKUP_INTENT_TYPES but not quoted in prompt`).toBe(true);
    }
  });

  it('CUSTOMER_PROTECTION_PROMPT_SECTION quotes complaint and negotiation', () => {
    const fromPrompt = intentNamesFromPrompt(CUSTOMER_PROTECTION_PROMPT_SECTION);
    expect(fromPrompt.has('complaint')).toBe(true);
    expect(fromPrompt.has('negotiation')).toBe(true);
    expect(fromPrompt.has('lookup_day_overview')).toBe(false);
  });

  it('every EXTENDED_INTENT_TYPES member is in SUPPORTED_INTENTS', () => {
    // SUPPORTED_INTENTS is not exported; test via parseClassifierJson (imported
    // at the top of this file): it returns non-null only for supported intents.
    for (const intent of EXTENDED_INTENT_TYPES) {
      const result = parseClassifierJson(JSON.stringify({ intentType: intent, confidence: 0.9 }));
      expect(result, `"${intent}" in EXTENDED_INTENT_TYPES but not accepted by parseClassifierJson`).not.toBeNull();
    }
  });

  it('every EXTENDED_INTENT_PHRASES key is in the entity-free read-only allowlist', () => {
    // matchExtendedIntentPhrase tests reveal which intents are phrase-matched.
    // We verify indirectly: all phrase-triggered intents must be in PHRASE_MATCH_ALLOWLIST.
    // Use a set of unambiguous stereotype transcripts for each allowlist member.
    const triggersByIntent: Record<string, string[]> = {
      lookup_day_overview: ["What's my day look like?", 'Give me my morning overview'],
      lookup_digest: ['Read me my day', 'give me the daily digest'],
      lookup_pending_items: ['What am I waiting on?', 'what are we still waiting on'],
      lookup_revenue: ['What did we sell last month?', 'How much did we make this month?'],
      lookup_my_day: ["What's on my schedule today?", "What's my next job?"],
      lookup_leads: ['Any new leads?', 'How many open leads do we have?'],
      lookup_materials: ["What's on the shopping list?"],
      lookup_catalog: ['Show the price book'],
    };
    for (const [intent, transcripts] of Object.entries(triggersByIntent)) {
      expect(PHRASE_MATCH_ALLOWLIST.has(intent), `"${intent}" must be in the phrase-match allowlist`).toBe(true);
      for (const tx of transcripts) {
        expect(matchExtendedIntentPhrase(tx), `"${tx}" should match "${intent}"`).toBe(intent);
      }
    }
    // complaint must NOT be phrase-matchable (it's proposal-driving).
    expect(matchExtendedIntentPhrase('I want to file a complaint about the install')).toBeNull();
    expect(matchExtendedIntentPhrase('I have a complaint')).toBeNull();
  });
});

describe('Phase-2 Track A — extended operator intents', () => {
  it('parseClassifierJson accepts the new intents', () => {
    for (const intentType of ['lookup_day_overview', 'lookup_digest', 'lookup_pending_items', 'complaint'] as const) {
      const out = parseClassifierJson(JSON.stringify({ intentType, confidence: 0.9 }));
      expect(out?.intentType).toBe(intentType);
    }
  });

  it('isLookupIntent covers the new lookup intents', () => {
    expect(isLookupIntent('lookup_day_overview')).toBe(true);
    expect(isLookupIntent('lookup_digest')).toBe(true);
    expect(isLookupIntent('lookup_pending_items')).toBe(true);
  });

  it('matchExtendedIntentPhrase matches the canonical pending-items phrasings only', () => {
    expect(matchExtendedIntentPhrase('What am I waiting on?')).toBe('lookup_pending_items');
    expect(matchExtendedIntentPhrase('what are we still waiting on')).toBe('lookup_pending_items');
    expect(matchExtendedIntentPhrase('I am waiting on a delivery tomorrow')).toBeNull();
  });

  it('matchExtendedIntentPhrase does NOT match complaint phrasings (complaint is LLM-path only)', () => {
    // complaint was removed from EXTENDED_INTENT_PHRASES because it is
    // a proposal-driving intent that extracts entities (noteBody /
    // customerName / jobReference). The deterministic path returns no
    // entities, creating a quality cliff. The LLM prompt section
    // (EXTENDED_INTENTS_PROMPT_SECTION) owns complaint classification
    // and entity extraction entirely.
    expect(matchExtendedIntentPhrase('I want to file a complaint about the install')).toBeNull();
    expect(matchExtendedIntentPhrase('I would like to complain')).toBeNull();
    expect(matchExtendedIntentPhrase("I'd like to complain about the service")).toBeNull();
    expect(matchExtendedIntentPhrase('I have a complaint')).toBeNull();
    // Corpus safety: vague unhappiness also not matched (trivially true
    // now that the whole complaint block is absent).
    expect(matchExtendedIntentPhrase("I'm not happy with my last service.")).toBeNull();
  });

  it('matchExtendedIntentPhrase matches the canonical digest phrasings only', () => {
    expect(matchExtendedIntentPhrase('Read me my day')).toBe('lookup_digest');
    expect(matchExtendedIntentPhrase('read my day')).toBe('lookup_digest');
    expect(matchExtendedIntentPhrase('give me the daily digest')).toBe('lookup_digest');
    expect(matchExtendedIntentPhrase('what did the digest say?')).toBe('lookup_digest');
    expect(matchExtendedIntentPhrase('read me the Smith invoice')).toBeNull();
  });

  it('matchExtendedIntentPhrase matches the canonical day-overview phrasings only', () => {
    expect(matchExtendedIntentPhrase("What's my day look like?")).toBe('lookup_day_overview');
    expect(matchExtendedIntentPhrase('what does my day look like')).toBe('lookup_day_overview');
    expect(matchExtendedIntentPhrase("how's my day looking?")).toBe('lookup_day_overview');
    expect(matchExtendedIntentPhrase('Give me my morning overview')).toBe('lookup_day_overview');
    expect(matchExtendedIntentPhrase('What appointments are scheduled today?')).toBe('lookup_day_overview');
    expect(matchExtendedIntentPhrase("Show me today's schedule")).toBe('lookup_day_overview');
    // Ordinary commands never collapse into a lookup.
    expect(matchExtendedIntentPhrase('Create an invoice for Acme for 450 dollars')).toBeNull();
    expect(matchExtendedIntentPhrase('Schedule my day off next Tuesday')).toBeNull();
    expect(matchExtendedIntentPhrase('')).toBeNull();
  });

  it('owner schedule questions bypass feature-flag and provider drift', async () => {
    const gateway = mockGateway('{"intentType":"unknown","confidence":0.2}');
    const result = await classifyIntent(
      'What appointments are scheduled today?',
      { ownerSession: true },
      gateway,
    );
    expect(result.intentType).toBe('lookup_day_overview');
    expect(result.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it('extendedIntents: deterministic phrase short-circuits WITHOUT an LLM call', async () => {
    const gateway = mockGateway('{"intentType":"unknown","confidence":0.2}');
    const result = await classifyIntent(
      "What's my day look like?",
      { tenantId: 't1', extendedIntents: true },
      gateway,
    );
    expect(result.intentType).toBe('lookup_day_overview');
    expect(result.confidence).toBeGreaterThanOrEqual(CLASSIFIER_CONFIDENCE_THRESHOLD);
    expect(gateway.complete).not.toHaveBeenCalled();
  });

  it('extendedIntents: true appends protection + owner-lookup sections as SEPARATE system messages', async () => {
    const gateway = mockGateway('{"intentType":"lookup_day_overview","confidence":0.85}');
    const result = await classifyIntent(
      'morning rundown please, schedule and approvals',
      { tenantId: 't1', extendedIntents: true },
      gateway,
    );
    expect(result.intentType).toBe('lookup_day_overview');
    const call = (gateway.complete as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const systemMessages = call.messages.filter((m: { role: string }) => m.role === 'system');
    // base + customer protection + owner extended lookups
    expect(systemMessages.length).toBe(3);
    expect(systemMessages.some((m: { content: string }) => m.content === EXTENDED_INTENTS_PROMPT_SECTION)).toBe(true);
    // The BASE prompt is untouched — it must not mention the new intents.
    expect(systemMessages[0].content).not.toContain('lookup_day_overview');
  });

  it('without extendedIntents the prompt messages are byte-identical to the legacy shape (cassette stability)', async () => {
    const gatewayA = mockGateway('{"intentType":"unknown","confidence":0.9}');
    const gatewayB = mockGateway('{"intentType":"unknown","confidence":0.9}');

    await classifyIntent("What's my day look like?", { tenantId: 't1' }, gatewayA);
    await classifyIntent(
      "What's my day look like?",
      { tenantId: 't1', extendedIntents: false },
      gatewayB,
    );

    const messagesA = (gatewayA.complete as ReturnType<typeof vi.fn>).mock.calls[0][0].messages;
    const messagesB = (gatewayB.complete as ReturnType<typeof vi.fn>).mock.calls[0][0].messages;
    expect(messagesB).toEqual(messagesA);
    expect(messagesA.filter((m: { role: string }) => m.role === 'system')).toHaveLength(1);
    for (const m of messagesA) {
      expect(m.content).not.toContain('lookup_day_overview');
    }
  });

  it('without extendedIntents the deterministic matcher never fires (LLM result wins)', async () => {
    const gateway = mockGateway('{"intentType":"unknown","confidence":0.9}');
    const result = await classifyIntent("What's my day look like?", { tenantId: 't1' }, gateway);
    expect(gateway.complete).toHaveBeenCalledTimes(1);
    expect(result.intentType).toBe('unknown');
  });
});

// ─── #910 — lookup routing determinism ─────────────────────────────────────
//
// The 2026-08-29 live sweep (issue #910) found L08 (lookup_estimates), L11
// (lookup_revenue), L19 (lookup_my_day), C02 (en_route) and R03
// (lookup_leads) intermittently answered from routes/assistant.ts's DB-less
// generic-LLM fallback (model gpt-4o-mini/assistant.general, content like
// "I do not have access to...") instead of the data-lookup skill / the
// en_route direct-act path — non-deterministically (the same corpus case
// passed on one run and failed on another).
//
// Root cause, pinned here: routes/assistant.ts's dispatch order was already
// correct — `isLookupIntent(classification.intentType)` is checked, and the
// `en_route` branch is reached, BEFORE any fallback path can run (see
// routes/assistant.ts's "Lookup path" / "en_route path" comments). The seam
// was entirely upstream, in THIS module: `classifyIntentRaw`'s LLM call
// (`gateway.complete({ taskType: 'classify_intent', ... })`) intermittently
// returned an intentType other than the correct `lookup_*` / `en_route` for
// these exact stereotyped phrasings — gpt-4o-mini classification is not
// deterministic. The fix mirrors the EXISTING deterministic-phrase
// precedent (matchExtendedIntentPhrase, already used for
// lookup_day_overview/digest/pending_items): a narrow, anchored pre-scan
// consulted BEFORE the LLM call so these five rows' exact utterances never
// depend on model luck again. Negative controls below pin that unrelated /
// entity-bearing phrasings still fall through to the LLM exactly as before
// — no behavior change for non-lookup, non-en_route utterances.
describe('#910 — lookup routing determinism (corpus rows L08/L11/L19/C02/R03)', () => {
  const chatContext = { tenantId: 't1', extendedIntents: true };

  it('L08 — "What estimates does {{FIXTURE_CUSTOMER}} have?" routes to lookup_estimates with customerName extracted, no LLM call', async () => {
    const gateway = mockGateway('{"intentType":"unknown","confidence":0.2}');
    const result = await classifyIntent(
      'What estimates does Jane Doe have?',
      chatContext,
      gateway,
    );
    expect(result.intentType).toBe('lookup_estimates');
    expect(result.confidence).toBeGreaterThanOrEqual(CLASSIFIER_CONFIDENCE_THRESHOLD);
    expect(result.extractedEntities?.customerName).toBe('Jane Doe');
    expect(gateway.complete).not.toHaveBeenCalled();
  });

  it('L11 — "What did we sell last month?" routes to lookup_revenue, no LLM call', async () => {
    const gateway = mockGateway('{"intentType":"unknown","confidence":0.2}');
    const result = await classifyIntent('What did we sell last month?', chatContext, gateway);
    expect(result.intentType).toBe('lookup_revenue');
    expect(result.confidence).toBeGreaterThanOrEqual(CLASSIFIER_CONFIDENCE_THRESHOLD);
    expect(gateway.complete).not.toHaveBeenCalled();
  });

  it("L19 — \"What's on my schedule today?\" routes to lookup_my_day, no LLM call", async () => {
    const gateway = mockGateway('{"intentType":"unknown","confidence":0.2}');
    const result = await classifyIntent("What's on my schedule today?", chatContext, gateway);
    expect(result.intentType).toBe('lookup_my_day');
    expect(result.confidence).toBeGreaterThanOrEqual(CLASSIFIER_CONFIDENCE_THRESHOLD);
    expect(gateway.complete).not.toHaveBeenCalled();
  });

  it('R03 — "Any new leads?" routes to lookup_leads, no LLM call (technician actor — same deterministic match regardless of role; RBAC is enforced downstream, not by classification)', async () => {
    const gateway = mockGateway('{"intentType":"unknown","confidence":0.2}');
    const result = await classifyIntent('Any new leads?', chatContext, gateway);
    expect(result.intentType).toBe('lookup_leads');
    expect(result.confidence).toBeGreaterThanOrEqual(CLASSIFIER_CONFIDENCE_THRESHOLD);
    expect(gateway.complete).not.toHaveBeenCalled();
  });

  it('C02 — "On my way to the job" routes to en_route, no LLM call, no extractedEntities (identity gate stays downstream)', async () => {
    const gateway = mockGateway('{"intentType":"unknown","confidence":0.2}');
    const result = await classifyIntent('On my way to the job', chatContext, gateway);
    expect(result.intentType).toBe('en_route');
    expect(result.confidence).toBeGreaterThanOrEqual(CLASSIFIER_CONFIDENCE_THRESHOLD);
    expect(result.extractedEntities).toBeUndefined();
    expect(gateway.complete).not.toHaveBeenCalled();
  });

  it('en_route phrase variants also short-circuit: "omw", "I\'m on my way", "heading out now"', async () => {
    for (const transcript of ['omw', "I'm on my way", 'heading out now', 'heading over']) {
      const gateway = mockGateway('{"intentType":"unknown","confidence":0.2}');
      const result = await classifyIntent(transcript, chatContext, gateway);
      expect(result.intentType, `"${transcript}" should route to en_route`).toBe('en_route');
      expect(gateway.complete).not.toHaveBeenCalled();
    }
  });

  it('negative control: en_route pattern does NOT match a named-job utterance (falls through to the LLM, entity extraction unaffected)', async () => {
    const gateway = mockGateway(
      JSON.stringify({
        intentType: 'en_route',
        confidence: 0.9,
        extractedEntities: { jobReference: 'the Garcia job' },
      }),
    );
    const result = await classifyIntent('On my way to the Garcia job', chatContext, gateway);
    expect(gateway.complete).toHaveBeenCalledTimes(1);
    expect(result.intentType).toBe('en_route');
    expect(result.extractedEntities?.jobReference).toBe('the Garcia job');
  });

  it('negative control: ordinary non-lookup, non-en_route utterances still reach the LLM unchanged', async () => {
    const gateway = mockGateway('{"intentType":"create_invoice","confidence":0.9}');
    const result = await classifyIntent(
      'Create an invoice for Acme for 450 dollars',
      chatContext,
      gateway,
    );
    expect(gateway.complete).toHaveBeenCalledTimes(1);
    expect(result.intentType).toBe('create_invoice');
  });

  it('negative control: "I sold my old truck last month" does not collapse into lookup_revenue', async () => {
    const gateway = mockGateway('{"intentType":"unknown","confidence":0.3}');
    const result = await classifyIntent('I sold my old truck last month', chatContext, gateway);
    expect(gateway.complete).toHaveBeenCalledTimes(1);
    expect(result.intentType).toBe('unknown');
  });

  it('negative control: a named crew member is NOT captured by the lookup_my_day short-circuit ("Mike\'s schedule" stays LLM-routed → lookup_crew_schedule)', async () => {
    const gateway = mockGateway(
      JSON.stringify({
        intentType: 'lookup_crew_schedule',
        confidence: 0.9,
        extractedEntities: { targetTechnicianName: 'Mike' },
      }),
    );
    const result = await classifyIntent("What's on Mike's schedule today?", chatContext, gateway);
    expect(gateway.complete).toHaveBeenCalledTimes(1);
    expect(result.intentType).toBe('lookup_crew_schedule');
  });

  it('negative control: without extendedIntents, none of the five new short-circuits fire (byte-identical legacy behavior)', async () => {
    for (const transcript of [
      'What estimates does Jane Doe have?',
      'What did we sell last month?',
      "What's on my schedule today?",
      'Any new leads?',
      'On my way to the job',
    ]) {
      const gateway = mockGateway('{"intentType":"unknown","confidence":0.9}');
      const result = await classifyIntent(transcript, { tenantId: 't1' }, gateway);
      expect(gateway.complete, `"${transcript}" without extendedIntents should still call the LLM`).toHaveBeenCalledTimes(1);
      expect(result.intentType).toBe('unknown');
    }
  });

  it('matchLookupEstimatesPhrase / matchEnRoutePhrase unit-level: exact corpus utterances match, empty/unrelated text does not', async () => {
    const { matchLookupEstimatesPhrase, matchEnRoutePhrase } = await import(
      '../../../src/ai/orchestration/intent-classifier'
    );
    expect(matchLookupEstimatesPhrase('What estimates does Jane Doe have?')).toEqual({
      customerName: 'Jane Doe',
    });
    expect(matchLookupEstimatesPhrase('')).toBeNull();
    expect(matchLookupEstimatesPhrase('What invoices does Jane Doe have?')).toBeNull();

    expect(matchEnRoutePhrase('On my way to the job')).toBe(true);
    expect(matchEnRoutePhrase('omw')).toBe(true);
    expect(matchEnRoutePhrase('')).toBe(false);
    expect(matchEnRoutePhrase('On my way to the Garcia job')).toBe(false);
    expect(matchEnRoutePhrase("I'm running 20 minutes late")).toBe(false);
  });
});

// ─── #910 completion — remaining lookup routing determinism ────────────────
//
// The 2026-08-29 FOLLOW-UP live sweep (post-#916) found the SAME
// generic-LLM-fallthrough failure mode recurring, non-deterministically, on
// four rows #916 hadn't covered: L03 (lookup_balance), L06
// (lookup_account_summary), L13 (lookup_job_profit) and L20
// (lookup_materials) — each scored `lookup_answer_not_confirmed` with a
// reply from `assistant.general` after passing on an earlier run. Same root
// cause, same fix shape as #916: a narrow, anchored pre-scan consulted
// BEFORE the LLM call. Plus a systematic extension to `lookup_catalog`
// (never entity-bearing) as belt-and-braces against the same class of
// flakiness, even though it isn't itself evidenced as flaky in this sweep.
describe('#910 completion — lookup routing determinism (corpus rows L03/L06/L13/L20)', () => {
  const chatContext = { tenantId: 't1', extendedIntents: true };

  it('L03 — "What does {{FIXTURE_CUSTOMER}} owe me?" routes to lookup_balance with customerName extracted, no LLM call', async () => {
    const gateway = mockGateway('{"intentType":"unknown","confidence":0.2}');
    const result = await classifyIntent('What does Henderson owe me?', chatContext, gateway);
    expect(result.intentType).toBe('lookup_balance');
    expect(result.confidence).toBeGreaterThanOrEqual(CLASSIFIER_CONFIDENCE_THRESHOLD);
    expect(result.extractedEntities?.customerName).toBe('Henderson');
    expect(gateway.complete).not.toHaveBeenCalled();
  });

  it('L06 — "Give me an account summary for {{FIXTURE_CUSTOMER}}" routes to lookup_account_summary with customerName extracted, no LLM call', async () => {
    const gateway = mockGateway('{"intentType":"unknown","confidence":0.2}');
    const result = await classifyIntent(
      'Give me an account summary for Henderson',
      chatContext,
      gateway,
    );
    expect(result.intentType).toBe('lookup_account_summary');
    expect(result.confidence).toBeGreaterThanOrEqual(CLASSIFIER_CONFIDENCE_THRESHOLD);
    expect(result.extractedEntities?.customerName).toBe('Henderson');
    expect(gateway.complete).not.toHaveBeenCalled();
  });

  it('L13 — "Did I make money on the {{FIXTURE_JOB}} job?" routes to lookup_job_profit with jobReference extracted, no LLM call', async () => {
    const gateway = mockGateway('{"intentType":"unknown","confidence":0.2}');
    const result = await classifyIntent(
      'Did I make money on the Miller job?',
      chatContext,
      gateway,
    );
    expect(result.intentType).toBe('lookup_job_profit');
    expect(result.confidence).toBeGreaterThanOrEqual(CLASSIFIER_CONFIDENCE_THRESHOLD);
    expect(result.extractedEntities?.jobReference).toBe('Miller');
    expect(gateway.complete).not.toHaveBeenCalled();
  });

  it("L20 — \"What's on the shopping list?\" routes to lookup_materials, no LLM call, no extractedEntities", async () => {
    const gateway = mockGateway('{"intentType":"unknown","confidence":0.2}');
    const result = await classifyIntent("What's on the shopping list?", chatContext, gateway);
    expect(result.intentType).toBe('lookup_materials');
    expect(result.confidence).toBeGreaterThanOrEqual(CLASSIFIER_CONFIDENCE_THRESHOLD);
    expect(result.extractedEntities).toBeUndefined();
    expect(gateway.complete).not.toHaveBeenCalled();
  });

  it('systematic extension — "Show the price book" routes to lookup_catalog, no LLM call (not evidenced as flaky; belt-and-braces)', async () => {
    const gateway = mockGateway('{"intentType":"unknown","confidence":0.2}');
    const result = await classifyIntent('Show the price book', chatContext, gateway);
    expect(result.intentType).toBe('lookup_catalog');
    expect(result.confidence).toBeGreaterThanOrEqual(CLASSIFIER_CONFIDENCE_THRESHOLD);
    expect(gateway.complete).not.toHaveBeenCalled();
  });

  it('negative control: a job-scoped materials ask still reaches the LLM unchanged (entities stay LLM-routed)', async () => {
    const gateway = mockGateway(
      JSON.stringify({
        intentType: 'lookup_materials',
        confidence: 0.9,
        extractedEntities: { jobReference: 'the Patel job' },
      }),
    );
    const result = await classifyIntent(
      'What materials are open on the Patel job?',
      chatContext,
      gateway,
    );
    expect(gateway.complete).toHaveBeenCalledTimes(1);
    expect(result.intentType).toBe('lookup_materials');
    expect(result.extractedEntities?.jobReference).toBe('the Patel job');
  });

  it('negative control: "who\'s free Thursday?" is NOT hard-coded to lookup_availability — stays LLM-routed (matches the live sweep\'s legitimate lookup_crew_schedule classification)', async () => {
    const gateway = mockGateway(
      JSON.stringify({ intentType: 'lookup_crew_schedule', confidence: 0.88 }),
    );
    const result = await classifyIntent("Who's free Thursday?", chatContext, gateway);
    expect(gateway.complete).toHaveBeenCalledTimes(1);
    expect(result.intentType).toBe('lookup_crew_schedule');
  });

  it('negative control: a balance ask naming a DIFFERENT subject than "me" is not captured ("what does he owe for the Henderson job?")', async () => {
    const gateway = mockGateway(
      JSON.stringify({ intentType: 'lookup_balance', confidence: 0.85, extractedEntities: {} }),
    );
    const result = await classifyIntent(
      'What does he owe for the Henderson job?',
      chatContext,
      gateway,
    );
    expect(gateway.complete).toHaveBeenCalledTimes(1);
    expect(result.intentType).toBe('lookup_balance');
  });

  it('negative control: the other job-profit phrasings stay LLM-routed (only the exact "did I make money" stereotype short-circuits)', async () => {
    const gateway = mockGateway(
      JSON.stringify({
        intentType: 'lookup_job_profit',
        confidence: 0.9,
        extractedEntities: { jobReference: "the Johnson install" },
      }),
    );
    const result = await classifyIntent(
      "What's my margin on the Johnson install?",
      chatContext,
      gateway,
    );
    expect(gateway.complete).toHaveBeenCalledTimes(1);
    expect(result.intentType).toBe('lookup_job_profit');
  });

  it('negative control: ordinary non-lookup utterances still reach the LLM unchanged', async () => {
    const gateway = mockGateway('{"intentType":"create_invoice","confidence":0.9}');
    const result = await classifyIntent(
      'Create an invoice for Acme for 450 dollars',
      chatContext,
      gateway,
    );
    expect(gateway.complete).toHaveBeenCalledTimes(1);
    expect(result.intentType).toBe('create_invoice');
  });

  it('negative control: without extendedIntents, none of the new short-circuits fire (byte-identical legacy behavior)', async () => {
    for (const transcript of [
      'What does Henderson owe me?',
      'Give me an account summary for Henderson',
      'Did I make money on the Miller job?',
      "What's on the shopping list?",
      'Show the price book',
    ]) {
      const gateway = mockGateway('{"intentType":"unknown","confidence":0.9}');
      const result = await classifyIntent(transcript, { tenantId: 't1' }, gateway);
      expect(
        gateway.complete,
        `"${transcript}" without extendedIntents should still call the LLM`,
      ).toHaveBeenCalledTimes(1);
      expect(result.intentType).toBe('unknown');
    }
  });

  it('matchLookupBalancePhrase / matchLookupAccountSummaryPhrase / matchLookupJobProfitPhrase unit-level: exact corpus utterances match, empty/unrelated text does not', async () => {
    const {
      matchLookupBalancePhrase,
      matchLookupAccountSummaryPhrase,
      matchLookupJobProfitPhrase,
    } = await import('../../../src/ai/orchestration/intent-classifier');

    expect(matchLookupBalancePhrase('What does Henderson owe me?')).toEqual({
      customerName: 'Henderson',
    });
    expect(matchLookupBalancePhrase('')).toBeNull();
    expect(matchLookupBalancePhrase('What does he owe for the Henderson job?')).toBeNull();

    expect(
      matchLookupAccountSummaryPhrase('Give me an account summary for Henderson'),
    ).toEqual({ customerName: 'Henderson' });
    expect(matchLookupAccountSummaryPhrase('')).toBeNull();
    expect(matchLookupAccountSummaryPhrase('Give me the Henderson invoice')).toBeNull();

    expect(matchLookupJobProfitPhrase('Did I make money on the Miller job?')).toEqual({
      jobReference: 'Miller',
    });
    expect(matchLookupJobProfitPhrase('')).toBeNull();
    expect(
      matchLookupJobProfitPhrase("What's my margin on the Johnson install?"),
    ).toBeNull();
  });
});

describe('A02 — draft_estimate routing determinism (2026-08-29 live sweep)', () => {
  const chatContext = { tenantId: 't1', extendedIntents: true };

  it('A02 — the exact sweep utterance routes to draft_estimate with customerName extracted, no LLM call', async () => {
    // Same shape production's classify_intent missed for this utterance
    // (a low-confidence 'unknown') — the deterministic match must not even
    // consult it.
    const gateway = mockGateway('{"intentType":"unknown","confidence":0.3}');
    const result = await classifyIntent(
      'Draft an estimate for qa-matrix-A-customer: water heater replacement for 2200 dollars, plus a permit fee for 150 dollars',
      chatContext,
      gateway,
    );
    expect(result.intentType).toBe('draft_estimate');
    expect(result.confidence).toBeGreaterThanOrEqual(CLASSIFIER_CONFIDENCE_THRESHOLD);
    expect(result.extractedEntities?.customerName).toBe('qa-matrix-A-customer');
    expect(gateway.complete).not.toHaveBeenCalled();
  });

  it('draft_estimate phrase variants also short-circuit: create/write/prepare/generate, "an"/"a" estimate', async () => {
    for (const transcript of [
      'Create an estimate for Bob Jones: new water heater for 1800 dollars',
      'Write an estimate for Bob Jones: new water heater for 1800 dollars',
      'Prepare an estimate for Bob Jones: new water heater for 1800 dollars',
      'Generate a estimate for Bob Jones: new water heater for 1800 dollars',
    ]) {
      const gateway = mockGateway('{"intentType":"unknown","confidence":0.2}');
      const result = await classifyIntent(transcript, chatContext, gateway);
      expect(result.intentType, `"${transcript}" should route to draft_estimate`).toBe(
        'draft_estimate',
      );
      expect(gateway.complete).not.toHaveBeenCalled();
    }
  });

  it('negative control: without extendedIntents, the short-circuit does not fire (byte-identical legacy behavior)', async () => {
    const gateway = mockGateway('{"intentType":"unknown","confidence":0.9}');
    const result = await classifyIntent(
      'Draft an estimate for qa-matrix-A-customer: water heater replacement for 2200 dollars',
      { tenantId: 't1' },
      gateway,
    );
    expect(gateway.complete).toHaveBeenCalledTimes(1);
    expect(result.intentType).toBe('unknown');
  });

  it('negative control: an estimate mentioned mid-sentence, without the "draft/create/… estimate for X:" imperative shape, stays LLM-routed', async () => {
    const gateway = mockGateway('{"intentType":"update_estimate","confidence":0.9}');
    const result = await classifyIntent(
      'Can you check on the estimate for Bob Jones?',
      chatContext,
      gateway,
    );
    expect(gateway.complete).toHaveBeenCalledTimes(1);
    expect(result.intentType).toBe('update_estimate');
  });

  it('negative control: no colon after the customer name stays LLM-routed', async () => {
    const gateway = mockGateway('{"intentType":"draft_estimate","confidence":0.9}');
    const result = await classifyIntent(
      'Draft an estimate for Bob Jones for a water heater replacement',
      chatContext,
      gateway,
    );
    expect(gateway.complete).toHaveBeenCalledTimes(1);
    expect(result.intentType).toBe('draft_estimate');
  });

  it('matchDraftEstimatePhrase unit-level: exact corpus utterance matches, empty/unrelated/no-colon text does not', async () => {
    const { matchDraftEstimatePhrase } = await import(
      '../../../src/ai/orchestration/intent-classifier'
    );
    expect(
      matchDraftEstimatePhrase(
        'Draft an estimate for qa-matrix-A-customer: water heater replacement for 2200 dollars, plus a permit fee for 150 dollars',
      ),
    ).toEqual({ customerName: 'qa-matrix-A-customer' });
    expect(matchDraftEstimatePhrase('')).toBeNull();
    expect(matchDraftEstimatePhrase('What estimates does Jane Doe have?')).toBeNull();
    expect(matchDraftEstimatePhrase('Draft an estimate for Bob Jones for a water heater')).toBeNull();
    expect(matchDraftEstimatePhrase('Can you check on the estimate for Bob Jones?')).toBeNull();
  });
});

describe('D01 — new-booking routing determinism (2026-08-30 live sweep)', () => {
  const inappContext = { tenantId: 't1' };

  it('the exact D01 opening utterance routes to create_appointment with NO LLM call', async () => {
    // Live evidence: this turn either took the sign-up override into
    // create_customer, or came back low-confidence, which left the whole
    // three-turn booking stuck in intent_capture ("I want to make sure I
    // got that right — can you say that again?").
    const gateway = mockGateway('{"intentType":"unknown","confidence":0.3}');
    const result = await classifyIntent(
      "I'd like to book a new customer for a diagnostic visit",
      inappContext,
      gateway,
    );
    expect(result.intentType).toBe('create_appointment');
    expect(result.confidence).toBeGreaterThanOrEqual(TAU_INT);
    expect(gateway.complete).not.toHaveBeenCalled();
  });

  it('fires WITHOUT extendedIntents — create_appointment is on every classifier profile', async () => {
    for (const context of [
      { tenantId: 't1' },
      { tenantId: 't1', extendedIntents: true },
      { tenantId: 't1', classifierProfile: 'caller' as const },
      { tenantId: 't1', classifierProfile: 'field_tech' as const },
    ]) {
      const gateway = mockGateway('{"intentType":"unknown","confidence":0.2}');
      const result = await classifyIntent('Book a diagnostic visit', context, gateway);
      expect(result.intentType).toBe('create_appointment');
      expect(gateway.complete).not.toHaveBeenCalled();
    }
  });

  it('booking phrase variants short-circuit: book/schedule/set up × new customer/visit/appointment', async () => {
    for (const transcript of [
      'Book a new customer',
      'set up a new customer appointment',
      'Schedule a new customer visit',
      "Let's set up a new customer for a maintenance visit",
      'I need to book a diagnostic inspection',
      'Can you schedule a maintenance visit?',
    ]) {
      const gateway = mockGateway('{"intentType":"unknown","confidence":0.2}');
      const result = await classifyIntent(transcript, inappContext, gateway);
      expect(result.intentType, `"${transcript}" should route to create_appointment`).toBe(
        'create_appointment',
      );
      expect(gateway.complete).not.toHaveBeenCalled();
    }
  });

  it('negative control: an utterance carrying real slots stays LLM-routed so entity extraction survives', async () => {
    // The whole point of anchoring the patterns: a booking that names a
    // customer or a date must keep the LLM's extractedEntities.
    for (const transcript of [
      'Schedule an appointment for Jordan Lee next Tuesday',
      'book Jordan Lee for Tuesday morning',
      'schedule a follow-up visit for the Miller job',
    ]) {
      const gateway = mockGateway(
        '{"intentType":"create_appointment","confidence":0.9,"extractedEntities":{"customerName":"Jordan Lee"}}',
      );
      const result = await classifyIntent(transcript, inappContext, gateway);
      expect(gateway.complete).toHaveBeenCalledTimes(1);
      expect(result.extractedEntities?.customerName).toBe('Jordan Lee');
    }
  });

  it('negative control: reschedule / cancel / lookup phrasings never match', async () => {
    for (const transcript of [
      'I need to reschedule my appointment',
      'Cancel the appointment for the Miller job',
      'Move my appointment to Thursday',
      'What appointments are scheduled today?',
    ]) {
      const gateway = mockGateway('{"intentType":"reschedule_appointment","confidence":0.9}');
      await classifyIntent(transcript, inappContext, gateway);
      expect(gateway.complete, `"${transcript}" must stay LLM-routed`).toHaveBeenCalledTimes(1);
    }
  });

  it('matchNewBookingPhrase unit-level: anchored booking openings only', async () => {
    const { matchNewBookingPhrase } = await import(
      '../../../src/ai/orchestration/intent-classifier'
    );
    expect(matchNewBookingPhrase("I'd like to book a new customer for a diagnostic visit")).toBe(
      true,
    );
    expect(matchNewBookingPhrase('Book a diagnostic visit')).toBe(true);
    expect(matchNewBookingPhrase('set up a new customer appointment')).toBe(true);
    expect(matchNewBookingPhrase('')).toBe(false);
    expect(matchNewBookingPhrase('Jordan Lee, 480-555-0199, next Tuesday morning works')).toBe(
      false,
    );
    expect(matchNewBookingPhrase("It's for a furnace diagnostic inspection at their home")).toBe(
      false,
    );
    expect(matchNewBookingPhrase('Schedule an appointment for Jordan Lee next Tuesday')).toBe(
      false,
    );
    expect(matchNewBookingPhrase('I need to reschedule my appointment')).toBe(false);
    // The qualifier is required — a bare, unqualified booking ask is one
    // the classifier already gets right and stays LLM-routed.
    expect(matchNewBookingPhrase('schedule an appointment')).toBe(false);
    expect(matchNewBookingPhrase('schedule a visit')).toBe(false);
  });

  it('the P18-001 sign-up override no longer hijacks a booking that mentions a new customer', async () => {
    const { isCreateCustomerSignupPhrasing } = await import(
      '../../../src/ai/orchestration/intent-classifier'
    );
    // The D01 shapes: an operator booking work FOR a new customer.
    expect(isCreateCustomerSignupPhrasing("I'd like to book a new customer for a diagnostic visit"))
      .toBe(false);
    expect(
      isCreateCustomerSignupPhrasing(
        'Book a new customer, Jordan Lee, for a diagnostic visit next Tuesday',
      ),
    ).toBe(false);
    expect(isCreateCustomerSignupPhrasing('set up a new customer appointment')).toBe(false);

    // …and the P18-001 rescue itself is untouched, including a caller who
    // announces themselves AND asks for an appointment in one breath.
    for (const phrasing of [
      "I'd like to sign up as a new customer",
      "I'm a new customer",
      'Can you set up an account for me?',
      'I want to become a customer',
      'first time calling, please add me',
      "I'm a new customer and I'd like to schedule an appointment",
      'Add a new customer, Jordan Lee, 480-555-0199',
    ]) {
      expect(isCreateCustomerSignupPhrasing(phrasing), `"${phrasing}"`).toBe(true);
    }
  });

  it('a richer booking that mentions a new customer reaches the LLM and KEEPS create_appointment', async () => {
    // Too rich for the anchored matcher (it names a customer), so it goes
    // through the LLM — and the sign-up override must no longer rewrite it.
    const gateway = mockGateway(
      '{"intentType":"create_appointment","confidence":0.9,"extractedEntities":{"customerName":"Jordan Lee"}}',
    );
    const result = await classifyIntent(
      'Book a new customer, Jordan Lee, for a diagnostic visit next Tuesday',
      inappContext,
      gateway,
    );
    expect(gateway.complete).toHaveBeenCalledTimes(1);
    expect(result.intentType).toBe('create_appointment');
    expect(result.extractedEntities?.customerName).toBe('Jordan Lee');
  });
});

describe('A06 — issue_invoice routing determinism (2026-08-30 live sweep, sweep-10)', () => {
  const chatContext = { tenantId: 't1' };

  it('the exact sweep-10 utterance routes to issue_invoice with jobReference extracted, no LLM call', async () => {
    // Live evidence: this exact utterance fell through to the generic-LLM
    // reply path with no proposal drafted — "I have not issued invoice
    // INV-0010. Please contact your billing department..." — a
    // hallucination-shaped deflection, not an honest refusal.
    const gateway = mockGateway('{"intentType":"unknown","confidence":0.3}');
    const result = await classifyIntent('Issue invoice INV-0010', chatContext, gateway);
    expect(result.intentType).toBe('issue_invoice');
    expect(result.confidence).toBeGreaterThanOrEqual(TAU_INT);
    expect(result.extractedEntities?.jobReference).toBe('INV-0010');
    expect(gateway.complete).not.toHaveBeenCalled();
  });

  it('fires WITHOUT extendedIntents — the live miss was on plain chat, which never sets that flag', async () => {
    for (const context of [
      { tenantId: 't1' },
      { tenantId: 't1', extendedIntents: true },
    ]) {
      const gateway = mockGateway('{"intentType":"unknown","confidence":0.2}');
      const result = await classifyIntent('Issue invoice INV-0042', context, gateway);
      expect(result.intentType).toBe('issue_invoice');
      expect(result.extractedEntities?.jobReference).toBe('INV-0042');
      expect(gateway.complete).not.toHaveBeenCalled();
    }
  });

  it('phrase variants also short-circuit: "the invoice", lowercase document number, trailing punctuation', async () => {
    for (const [transcript, expected] of [
      ['Issue the invoice INV-0010', 'INV-0010'],
      ['issue invoice inv-0010.', 'INV-0010'],
      ['Issue invoice INV-1234!', 'INV-1234'],
    ] as const) {
      const gateway = mockGateway('{"intentType":"unknown","confidence":0.2}');
      const result = await classifyIntent(transcript, chatContext, gateway);
      expect(result.intentType, `"${transcript}" should route to issue_invoice`).toBe(
        'issue_invoice',
      );
      expect(result.extractedEntities?.jobReference).toBe(expected);
      expect(gateway.complete).not.toHaveBeenCalled();
    }
  });

  it('negative control: no document number ("issue the invoice we just drafted") stays LLM-routed', async () => {
    // Not anchored to a document number, so Rung 2's conversation-context
    // resolution (IssueInvoiceTaskHandler) — not this matcher — is what
    // must answer it. Falling through to the LLM keeps that path intact.
    const gateway = mockGateway('{"intentType":"issue_invoice","confidence":0.9}');
    const result = await classifyIntent('Issue the invoice we just drafted', chatContext, gateway);
    expect(gateway.complete).toHaveBeenCalledTimes(1);
    expect(result.intentType).toBe('issue_invoice');
  });

  it('negative control: a customer-named reference stays LLM-routed so entity extraction survives', async () => {
    const gateway = mockGateway(
      '{"intentType":"issue_invoice","confidence":0.9,"extractedEntities":{"customerName":"Bob Jones"}}',
    );
    const result = await classifyIntent('Issue the Bob Jones invoice', chatContext, gateway);
    expect(gateway.complete).toHaveBeenCalledTimes(1);
    expect(result.extractedEntities?.customerName).toBe('Bob Jones');
  });

  it('negative control: mentions an invoice mid-sentence without the imperative shape stays LLM-routed', async () => {
    const gateway = mockGateway('{"intentType":"update_invoice","confidence":0.9}');
    const result = await classifyIntent(
      'Add a line item to invoice INV-0010',
      chatContext,
      gateway,
    );
    expect(gateway.complete).toHaveBeenCalledTimes(1);
    expect(result.intentType).toBe('update_invoice');
  });

  it('matchIssueInvoicePhrase unit-level: exact corpus utterance matches, empty/unrelated/no-number text does not', async () => {
    const { matchIssueInvoicePhrase } = await import(
      '../../../src/ai/orchestration/intent-classifier'
    );
    expect(matchIssueInvoicePhrase('Issue invoice INV-0010')).toEqual({
      jobReference: 'INV-0010',
    });
    expect(matchIssueInvoicePhrase('Issue the invoice INV-0010')).toEqual({
      jobReference: 'INV-0010',
    });
    expect(matchIssueInvoicePhrase('')).toBeNull();
    expect(matchIssueInvoicePhrase('Issue the invoice we just drafted')).toBeNull();
    expect(matchIssueInvoicePhrase('Issue the Bob Jones invoice')).toBeNull();
    expect(matchIssueInvoicePhrase('Add a line item to invoice INV-0010')).toBeNull();
    expect(matchIssueInvoicePhrase('What invoices does Bob Jones have?')).toBeNull();
  });
});

describe('A10 — update_job priority routing determinism (2026-08-31 live sweep)', () => {
  const chatContext = { tenantId: 't1' };

  it('the exact sweep utterance routes to update_job with jobReference extracted, no LLM call', async () => {
    // Live evidence: this exact utterance fell through to the generic-LLM
    // reply path with no proposal drafted — "I have NOT marked... please
    // contact your supervisor" — a hallucination-shaped deflection, not an
    // honest refusal. The identical utterance shape had passed on many
    // prior sweeps, so this is non-determinism in the LLM call, not a
    // taxonomy gap.
    const gateway = mockGateway('{"intentType":"unknown","confidence":0.3}');
    const result = await classifyIntent(
      'Mark the QA Sweep Furnace Inspection job as high priority',
      chatContext,
      gateway,
    );
    expect(result.intentType).toBe('update_job');
    expect(result.confidence).toBeGreaterThanOrEqual(TAU_INT);
    expect(result.extractedEntities?.jobReference).toBe('QA Sweep Furnace Inspection');
    expect(gateway.complete).not.toHaveBeenCalled();
  });

  it('fires WITHOUT extendedIntents — the live miss was on plain chat, which never sets that flag', async () => {
    for (const context of [
      { tenantId: 't1' },
      { tenantId: 't1', extendedIntents: true },
    ]) {
      const gateway = mockGateway('{"intentType":"unknown","confidence":0.2}');
      const result = await classifyIntent(
        'Mark the Henderson job as urgent priority',
        context,
        gateway,
      );
      expect(result.intentType).toBe('update_job');
      expect(result.extractedEntities?.jobReference).toBe('Henderson');
      expect(gateway.complete).not.toHaveBeenCalled();
    }
  });

  it('phrase variants also short-circuit: no "as", every priority value, trailing punctuation', async () => {
    for (const [transcript, expected] of [
      ['Mark the Henderson job high priority', 'Henderson'],
      ['mark the Garcia job as low priority.', 'Garcia'],
      ['Mark the water heater install job as normal priority!', 'water heater install'],
      ['Mark the Smith job as urgent priority', 'Smith'],
    ] as const) {
      const gateway = mockGateway('{"intentType":"unknown","confidence":0.2}');
      const result = await classifyIntent(transcript, chatContext, gateway);
      expect(result.intentType, `"${transcript}" should route to update_job`).toBe('update_job');
      expect(result.extractedEntities?.jobReference).toBe(expected);
      expect(gateway.complete).not.toHaveBeenCalled();
    }
  });

  it('negative control: status/title/description edits stay LLM-routed (not this matcher\'s shape)', async () => {
    const gateway = mockGateway('{"intentType":"update_job","confidence":0.9}');
    const result = await classifyIntent('Mark the Henderson job in progress', chatContext, gateway);
    expect(gateway.complete).toHaveBeenCalledTimes(1);
    expect(result.intentType).toBe('update_job');
  });

  it('negative control: a differently-phrased priority command stays LLM-routed', async () => {
    const gateway = mockGateway(
      '{"intentType":"update_job","confidence":0.9,"extractedEntities":{"jobReference":"Henderson"}}',
    );
    const result = await classifyIntent(
      "Set the Henderson job's priority to urgent",
      chatContext,
      gateway,
    );
    expect(gateway.complete).toHaveBeenCalledTimes(1);
    expect(result.extractedEntities?.jobReference).toBe('Henderson');
  });

  it('matchUpdateJobPriorityPhrase unit-level: exact corpus utterance matches, empty/unrelated/no-priority text does not', async () => {
    const { matchUpdateJobPriorityPhrase } = await import(
      '../../../src/ai/orchestration/intent-classifier'
    );
    expect(
      matchUpdateJobPriorityPhrase('Mark the QA Sweep Furnace Inspection job as high priority'),
    ).toEqual({ jobReference: 'QA Sweep Furnace Inspection' });
    expect(matchUpdateJobPriorityPhrase('Mark the Henderson job high priority')).toEqual({
      jobReference: 'Henderson',
    });
    expect(matchUpdateJobPriorityPhrase('')).toBeNull();
    expect(matchUpdateJobPriorityPhrase('Mark the Henderson job in progress')).toBeNull();
    expect(matchUpdateJobPriorityPhrase("Set the Henderson job's priority to urgent")).toBeNull();
    expect(matchUpdateJobPriorityPhrase('Rename the Henderson job')).toBeNull();
    expect(matchUpdateJobPriorityPhrase('Mark the invoice INV-0010 as paid')).toBeNull();
  });
});

describe('intent-classifier — lookup_job_profit (P22-005)', () => {
  const tenantId = 'tenant-1';

  it('parseClassifierJson accepts lookup_job_profit with a jobReference', () => {
    const out = parseClassifierJson(
      JSON.stringify({
        intentType: 'lookup_job_profit',
        confidence: 0.9,
        extractedEntities: { jobReference: 'the Miller job' },
      }),
    );
    expect(out?.intentType).toBe('lookup_job_profit');
    expect(out?.extractedEntities?.jobReference).toBe('the Miller job');
  });

  it('is recognized as a read-only lookup intent (routes to the skill family)', () => {
    expect(isLookupIntent('lookup_job_profit')).toBe(true);
  });

  it('routes 5+ distinct profit phrasings to lookup_job_profit', async () => {
    const phrasings = [
      'Did I make money on the Miller job?',
      "What's my margin on the Johnson install?",
      "How'd we do on the Smith water heater?",
      'Did the Davis job turn a profit?',
      'What did I clear on JOB-0042?',
    ];
    for (const transcript of phrasings) {
      const gateway = mockGateway(
        JSON.stringify({
          intentType: 'lookup_job_profit',
          confidence: 0.9,
          extractedEntities: { jobReference: transcript },
        }),
      );
      const result = await classifyIntent(transcript, { tenantId }, gateway);
      expect(result.intentType).toBe('lookup_job_profit');
      expect(result.confidence).toBeGreaterThanOrEqual(CLASSIFIER_CONFIDENCE_THRESHOLD);
    }
  });
});

describe('Story 3.4 — versioned intent taxonomy', () => {
  const tenantId = 'tenant-1';

  it('exposes a semver-shaped taxonomy version', () => {
    expect(INTENT_TAXONOMY_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('stamps the taxonomy version on a successful classification', async () => {
    const gateway = mockGateway(
      JSON.stringify({ intentType: 'create_invoice', confidence: 0.92 }),
    );
    const result = await classifyIntent('invoice Acme for $200', { tenantId }, gateway);
    expect(result.intentType).toBe('create_invoice');
    expect(result.taxonomyVersion).toBe(INTENT_TAXONOMY_VERSION);
  });

  it('stamps the version on the empty-transcript short-circuit (no gateway call)', async () => {
    const gateway = mockGateway('{}');
    const result = await classifyIntent('   ', { tenantId }, gateway);
    expect(result.intentType).toBe('unknown');
    expect(result.taxonomyVersion).toBe(INTENT_TAXONOMY_VERSION);
    expect((gateway.complete as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });

  it('stamps the version on the low-confidence → unknown path', async () => {
    const gateway = mockGateway(
      JSON.stringify({ intentType: 'create_invoice', confidence: 0.2 }),
    );
    const result = await classifyIntent('mumble mumble', { tenantId }, gateway);
    expect(result.intentType).toBe('unknown');
    expect(result.unknownReason).toBe('low_confidence');
    expect(result.taxonomyVersion).toBe(INTENT_TAXONOMY_VERSION);
  });
});

describe('Story 3.4 — "log inventory" maps to expense logging', () => {
  const tenantId = 'tenant-1';

  it('recognizes inventory-LOGGING phrasings but not stock QUERIES', () => {
    expect(isInventoryLoggingPhrasing('log inventory: 20 feet of copper pipe')).toBe(true);
    expect(isInventoryLoggingPhrasing('record stock intake from the supply run')).toBe(true);
    expect(isInventoryLoggingPhrasing('received new stock today')).toBe(true);
    expect(isInventoryLoggingPhrasing('add this to inventory')).toBe(true);
    // Queries must NOT be treated as logging.
    expect(isInventoryLoggingPhrasing('how much stock is left')).toBe(false);
    expect(isInventoryLoggingPhrasing('check inventory for the Smith job')).toBe(false);
    expect(isInventoryLoggingPhrasing("what's in stock")).toBe(false);
    expect(isInventoryLoggingPhrasing('create an invoice for Acme')).toBe(false);
  });

  it('maps an inventory-logging utterance to log_expense even when the LLM punts', async () => {
    const gateway = mockGateway(JSON.stringify({ intentType: 'unknown', confidence: 0.4 }));
    const result = await classifyIntent('log inventory: 20 feet of copper pipe', { tenantId }, gateway);
    expect(result.intentType).toBe('log_expense');
    expect(result.confidence).toBeGreaterThanOrEqual(CLASSIFIER_CONFIDENCE_THRESHOLD);
    expect(result.extractedEntities?.expenseCategory).toBe('materials');
    expect(result.taxonomyVersion).toBe(INTENT_TAXONOMY_VERSION);
  });

  it('preserves an LLM-extracted amount and existing category when mapping', async () => {
    const gateway = mockGateway(
      JSON.stringify({
        intentType: 'add_note',
        confidence: 0.7,
        extractedEntities: { amount: 5500, expenseCategory: 'tools' },
      }),
    );
    const result = await classifyIntent('record stock intake — a new drill, 55 dollars', { tenantId }, gateway);
    expect(result.intentType).toBe('log_expense');
    expect(result.extractedEntities?.amount).toBe(5500);
    // Pre-existing category is respected, not overwritten with 'materials'.
    expect(result.extractedEntities?.expenseCategory).toBe('tools');
  });

  it('does not override a stock QUERY', async () => {
    const gateway = mockGateway(JSON.stringify({ intentType: 'lookup_catalog', confidence: 0.9 }));
    const result = await classifyIntent('how much copper stock is left', { tenantId }, gateway);
    expect(result.intentType).toBe('lookup_catalog');
  });

  it('leaves a genuine log_expense classification untouched', async () => {
    const gateway = mockGateway(
      JSON.stringify({ intentType: 'log_expense', confidence: 0.95, extractedEntities: { amount: 4000 } }),
    );
    const result = await classifyIntent('add a 40 dollar fuel expense', { tenantId }, gateway);
    expect(result.intentType).toBe('log_expense');
    // Not remapped through the inventory override (which stamps an inventory reason).
    expect(result.reasoning ?? '').not.toMatch(/inventory/i);
    expect(result.extractedEntities?.amount).toBe(4000);
  });
});

// ─── Taxonomy 1.2.0 (agent wave, Track A) ──────────────────────────────────
//
// The three new proposal-driving intents parse with their flat entity fields
// (scheduleDescription / reviewReference / instructionText / scopeIntentHint)
// and the version stamp reflects the coordinated bump.
describe('taxonomy 1.2.0 — new intents + entities', () => {
  // B7 (feat: voice-transcript-and-agent-paths) bumped the taxonomy again to
  // 1.3.0 (update_job); B5.5 (Part F decision F-3) bumped it again to 1.4.0
  // (en_route); B1.18 bumped it again to 1.5.0 (update_brand_voice);
  // Tradesperson wave 1 (2026-08-07 plan) bumped it again to 1.6.0
  // (schedule_inspection / log_permit / log_warranty_claim), then Task 2 of
  // the same plan bumped it again to 1.7.0 (update_catalog_item — WS20's
  // existing proposal type/handler, voice on-ramp only), then Task 3 of the
  // same plan bumped it again to 1.8.0 (record_refund — a NEW money-class
  // proposal type for recording MANUAL refunds by voice), then Task 4 of the
  // same plan bumped it again to 1.9.0 (apply_credit — a NEW money-class
  // proposal type that reduces what a customer owes on an issued invoice),
  // then Task 5 of the same plan bumped it again to 1.10.0
  // (send_customer_message — a NEW comms-class proposal type for a
  // free-form outbound customer message), then Task 6 of the same plan
  // bumped it again to 1.11.0 (create_change_order — a NEW capture-class
  // proposal type that mints a new estimate pinned to an existing job),
  // then Task 7 of the same plan bumped it again to 1.12.0
  // (create_service_agreement — a NEW capture-class proposal type that
  // signs a customer up to a recurring maintenance plan/membership), then
  // Task 9 of the same plan bumped it again to 1.13.0 (add_material — a
  // NEW capture-class proposal type that adds a row to the voice-captured
  // shopping list; plus lookup_materials — a NEW read-only lookup-skill
  // family member), then Task 10 of the same plan bumped it again to
  // 1.14.0 (lookup_crew_schedule / lookup_timesheets / lookup_my_day —
  // three more read-only lookup-skill family members; no proposal types,
  // no migrations).
  // classifyIntent always stamps the CURRENT constant regardless of which
  // intent, so this pin tracks the live value.
  // Task 11 of the same plan bumped it again to 1.15.0 (log_mileage — an
  // ALIAS intent onto the EXISTING log_expense proposal type; no new
  // ProposalType, no migration).
  // Task 12 of the same plan bumped it again to 1.16.0 (add_catalog_item —
  // a NEW capture-class proposal type that lets an owner add a price-book
  // entry by voice; reuses catalogItemNewName/unitPriceCents/
  // catalogItemNewDescription, adds one new field, catalogItemUnit).
  // A follow-up (2026-08-09) bumped it again to 1.17.0: `lookup_materials`
  // advertises date-scoped phrasing again now that `neededByBefore` is a
  // real repo-layer filter (reuses the EXISTING dateTimeDescription slot —
  // no new extraction field, additive coverage extension only).
  // The review of that follow-up bumped it to 1.18.0, a NARROWING: the
  // advertised phrasing is cut back to what `resolveSpokenDay` actually
  // resolves correctly (a bare weekday, "tomorrow", "by <weekday>"), and
  // the "before Thursday" example is dropped because the skill's boundary
  // INCLUDES Thursday-due items. Prompt-text-only; no intent or slot
  // changes.
  it('taxonomy version reflects the latest coordinated bump (1.18.0)', () => {
    expect(INTENT_TAXONOMY_VERSION).toBe('1.18.0');
  });

  // Task 11 (2026-08-07 tradesperson plan) — log_mileage is a new intent
  // that must be classifiable at all before anything downstream can map or
  // draft it.
  it('log_mileage is a supported intent', () => {
    expect(SUPPORTED_INTENTS).toContain('log_mileage');
  });

  it('parses log_mileage with mileageMiles (possibly fractional) and jobReference', () => {
    const result = parseClassifierJson(
      JSON.stringify({
        intentType: 'log_mileage',
        confidence: 0.9,
        extractedEntities: { mileageMiles: 32.5, jobReference: 'the Patel job' },
      }),
    );
    expect(result?.intentType).toBe('log_mileage');
    expect(result?.extractedEntities?.mileageMiles).toBe(32.5);
    expect(result?.extractedEntities?.jobReference).toBe('the Patel job');
  });

  // A spoken 0/negative miles value must still reach the extracted entities
  // (never silently dropped here) so the task handler — which owns the
  // domain gate — can distinguish "no miles stated" from "an invalid miles
  // value was stated" and gate on `amountCents` with an accurate reason.
  it('a non-positive mileageMiles still passes the parse allowlist (the handler gates it, not the parser)', () => {
    const result = parseClassifierJson(
      JSON.stringify({
        intentType: 'log_mileage',
        confidence: 0.9,
        extractedEntities: { mileageMiles: 0 },
      }),
    );
    expect(result?.extractedEntities?.mileageMiles).toBe(0);
  });

  it('a non-numeric mileageMiles is dropped (flat number only)', () => {
    const result = parseClassifierJson(
      JSON.stringify({
        intentType: 'log_mileage',
        confidence: 0.9,
        extractedEntities: { mileageMiles: '32 miles' },
      }),
    );
    expect(result?.extractedEntities?.mileageMiles).toBeUndefined();
  });

  // Task 12 (2026-08-07 tradesperson plan) — add_catalog_item is a new
  // intent that must be classifiable at all before anything downstream
  // can map or draft it.
  it('add_catalog_item is a supported intent', () => {
    expect(SUPPORTED_INTENTS).toContain('add_catalog_item');
  });

  it('parses add_catalog_item with name, unitPriceCents, and unit', () => {
    const result = parseClassifierJson(
      JSON.stringify({
        intentType: 'add_catalog_item',
        confidence: 0.9,
        extractedEntities: {
          catalogItemNewName: 'Smart thermostat install',
          unitPriceCents: 38500,
          catalogItemUnit: 'each',
        },
      }),
    );
    expect(result?.intentType).toBe('add_catalog_item');
    expect(result?.extractedEntities?.catalogItemNewName).toBe('Smart thermostat install');
    expect(result?.extractedEntities?.unitPriceCents).toBe(38500);
    expect(result?.extractedEntities?.catalogItemUnit).toBe('each');
  });

  it('parses add_catalog_item with a spoken price of exactly 0 (flat number only, never dropped)', () => {
    const result = parseClassifierJson(
      JSON.stringify({
        intentType: 'add_catalog_item',
        confidence: 0.9,
        extractedEntities: { catalogItemNewName: 'Free estimate', unitPriceCents: 0 },
      }),
    );
    expect(result?.extractedEntities?.unitPriceCents).toBe(0);
  });

  it('drops an out-of-vocabulary catalogItemUnit and records the invalid-field entry', () => {
    const result = parseClassifierJson(
      JSON.stringify({
        intentType: 'add_catalog_item',
        confidence: 0.9,
        extractedEntities: {
          catalogItemNewName: 'Copper pipe',
          unitPriceCents: 500,
          catalogItemUnit: 'per widget',
        },
      }),
    );
    expect(result?.extractedEntities?.catalogItemUnit).toBeUndefined();
    expect(result?.invalidEnumFields).toContainEqual({ field: 'catalogItemUnit', value: 'per widget' });
  });

  it('parses create_invoice_schedule with the verbatim milestone sentence', () => {
    const result = parseClassifierJson(
      JSON.stringify({
        intentType: 'create_invoice_schedule',
        confidence: 0.9,
        extractedEntities: {
          jobReference: 'the Hendersons',
          scheduleDescription: '50% deposit, 50% on completion',
          amount: 400000,
        },
      }),
    );
    expect(result?.intentType).toBe('create_invoice_schedule');
    expect(result?.extractedEntities?.scheduleDescription).toBe('50% deposit, 50% on completion');
    expect(result?.extractedEntities?.jobReference).toBe('the Hendersons');
    expect(result?.extractedEntities?.amount).toBe(400000);
  });

  it('parses respond_to_review with the free-text review reference', () => {
    const result = parseClassifierJson(
      JSON.stringify({
        intentType: 'respond_to_review',
        confidence: 0.9,
        extractedEntities: { reviewReference: 'the 1-star from yesterday' },
      }),
    );
    expect(result?.intentType).toBe('respond_to_review');
    expect(result?.extractedEntities?.reviewReference).toBe('the 1-star from yesterday');
  });

  it('parses create_standing_instruction with instructionText + scopeIntentHint', () => {
    const result = parseClassifierJson(
      JSON.stringify({
        intentType: 'create_standing_instruction',
        confidence: 0.95,
        extractedEntities: {
          instructionText: 'from now on always add a $79 diagnostic fee to AC calls',
          scopeIntentHint: 'invoices',
          amount: 7900,
        },
      }),
    );
    expect(result?.intentType).toBe('create_standing_instruction');
    expect(result?.extractedEntities?.instructionText).toBe(
      'from now on always add a $79 diagnostic fee to AC calls',
    );
    expect(result?.extractedEntities?.scopeIntentHint).toBe('invoices');
  });

  it('non-string values for the new fields are dropped (flat strings only)', () => {
    const result = parseClassifierJson(
      JSON.stringify({
        intentType: 'create_invoice_schedule',
        confidence: 0.9,
        extractedEntities: {
          scheduleDescription: { milestones: [] }, // nested object → dropped
          reviewReference: 42,
          instructionText: null,
        },
      }),
    );
    expect(result?.extractedEntities?.scheduleDescription).toBeUndefined();
    expect(result?.extractedEntities?.reviewReference).toBeUndefined();
    expect(result?.extractedEntities?.instructionText).toBeUndefined();
  });

  it('classifyIntent stamps the current taxonomy version on a new-intent classification end-to-end', async () => {
    const gateway = mockGateway(
      JSON.stringify({
        intentType: 'respond_to_review',
        confidence: 0.9,
        extractedEntities: { reviewReference: 'that bad review' },
      }),
    );
    const result = await classifyIntent('Respond to that bad review', { tenantId: 't-1' }, gateway);
    expect(result.intentType).toBe('respond_to_review');
    expect(result.taxonomyVersion).toBe(INTENT_TAXONOMY_VERSION);
  });

  // B1.18 — update_brand_voice (taxonomy 1.5.0).
  it('parses update_brand_voice with the verbatim brandVoiceInstruction', () => {
    const result = parseClassifierJson(
      JSON.stringify({
        intentType: 'update_brand_voice',
        confidence: 0.91,
        extractedEntities: {
          brandVoiceInstruction:
            "friendly, plain-spoken, no slang, always sign off 'Thanks — Bob's HVAC'",
        },
      }),
    );
    expect(result?.intentType).toBe('update_brand_voice');
    expect(result?.extractedEntities?.brandVoiceInstruction).toBe(
      "friendly, plain-spoken, no slang, always sign off 'Thanks — Bob's HVAC'",
    );
  });

  it('a nested-object brandVoiceInstruction is dropped (flat string only)', () => {
    const result = parseClassifierJson(
      JSON.stringify({
        intentType: 'update_brand_voice',
        confidence: 0.9,
        extractedEntities: { brandVoiceInstruction: { register: 'friendly' } },
      }),
    );
    expect(result?.extractedEntities?.brandVoiceInstruction).toBeUndefined();
  });

  it('classifyIntent end-to-end for update_brand_voice stamps the current taxonomy version', async () => {
    const gateway = mockGateway(
      JSON.stringify({
        intentType: 'update_brand_voice',
        confidence: 0.91,
        extractedEntities: { brandVoiceInstruction: 'friendly, always sign off Thanks Bob' },
      }),
    );
    const result = await classifyIntent(
      "Set my brand voice: friendly, always sign off 'Thanks — Bob's HVAC'",
      { tenantId: 't-1' },
      gateway,
    );
    expect(result.intentType).toBe('update_brand_voice');
    expect(result.taxonomyVersion).toBe(INTENT_TAXONOMY_VERSION);
    expect(result.extractedEntities?.brandVoiceInstruction).toBe(
      'friendly, always sign off Thanks Bob',
    );
  });

  // Tradesperson wave 1, Task 2 (taxonomy 1.7.0) — update_catalog_item.
  // Fields are qualified (catalogItemNewName/catalogItemNewDescription, not
  // bare name/description) per the review fix: the template already has
  // `updatedName` (update_customer) distinguished only by prose, and a
  // weaker classifier emitting the wrong key would silently drop a rename.
  it('parses update_catalog_item with catalogItemReference, unitPriceCents, catalogItemNewName, and catalogItemNewDescription', () => {
    const result = parseClassifierJson(
      JSON.stringify({
        intentType: 'update_catalog_item',
        confidence: 0.9,
        extractedEntities: {
          catalogItemReference: 'AC tune-up',
          unitPriceCents: 8900,
          catalogItemNewName: 'AC seasonal service',
          catalogItemNewDescription: 'Full seasonal inspection and coil clean',
        },
      }),
    );
    expect(result?.intentType).toBe('update_catalog_item');
    expect(result?.extractedEntities?.catalogItemReference).toBe('AC tune-up');
    expect(result?.extractedEntities?.unitPriceCents).toBe(8900);
    expect(result?.extractedEntities?.catalogItemNewName).toBe('AC seasonal service');
    expect(result?.extractedEntities?.catalogItemNewDescription).toBe(
      'Full seasonal inspection and coil clean',
    );
  });

  it('classifyIntent end-to-end for update_catalog_item stamps the current taxonomy version', async () => {
    const gateway = mockGateway(
      JSON.stringify({
        intentType: 'update_catalog_item',
        confidence: 0.9,
        extractedEntities: { catalogItemReference: 'AC tune-up', unitPriceCents: 8900 },
      }),
    );
    const result = await classifyIntent(
      'Raise the AC tune-up price to 89 dollars',
      { tenantId: 't-1' },
      gateway,
    );
    expect(result.intentType).toBe('update_catalog_item');
    expect(result.taxonomyVersion).toBe(INTENT_TAXONOMY_VERSION);
    expect(result.extractedEntities?.catalogItemReference).toBe('AC tune-up');
  });

  // Tradesperson wave 1, Task 3 (taxonomy 1.8.0) — record_refund. Fields are
  // qualified (refundMethod/refundReason/refundCheckNumber, not bare
  // method/reason) per house precedent (catalogItemNewName,
  // expenseDescription, updatedName) — a weaker classifier emitting the
  // wrong key would silently drop the refund detail. The invoice reference
  // itself reuses `jobReference` (there is no separate `invoiceReference`
  // field anywhere in this taxonomy).
  it('parses record_refund with jobReference, amount, refundMethod, refundReason, and refundCheckNumber', () => {
    const result = parseClassifierJson(
      JSON.stringify({
        intentType: 'record_refund',
        confidence: 0.9,
        extractedEntities: {
          jobReference: 'INV-0042',
          amount: 7500,
          refundMethod: 'check',
          refundReason: 'recharge did not hold',
          refundCheckNumber: '2044',
        },
      }),
    );
    expect(result?.intentType).toBe('record_refund');
    expect(result?.extractedEntities?.jobReference).toBe('INV-0042');
    expect(result?.extractedEntities?.amount).toBe(7500);
    expect(result?.extractedEntities?.refundMethod).toBe('check');
    expect(result?.extractedEntities?.refundReason).toBe('recharge did not hold');
    expect(result?.extractedEntities?.refundCheckNumber).toBe('2044');
  });

  it('rejects an invalid refundMethod as an invalid enum field, not a silent guess', () => {
    const result = parseClassifierJson(
      JSON.stringify({
        intentType: 'record_refund',
        confidence: 0.9,
        extractedEntities: { amount: 7500, refundMethod: 'venmo' },
      }),
    );
    expect(result?.extractedEntities?.refundMethod).toBeUndefined();
    expect(result?.invalidEnumFields).toEqual(
      expect.arrayContaining([{ field: 'refundMethod', value: 'venmo' }]),
    );
  });

  it('classifyIntent end-to-end for record_refund stamps the current taxonomy version', async () => {
    const gateway = mockGateway(
      JSON.stringify({
        intentType: 'record_refund',
        confidence: 0.9,
        extractedEntities: { jobReference: 'INV-0042', amount: 10000, refundMethod: 'cash' },
      }),
    );
    const result = await classifyIntent(
      'Refund the Smiths 100 dollars on their invoice',
      { tenantId: 't-1' },
      gateway,
    );
    expect(result.intentType).toBe('record_refund');
    expect(result.taxonomyVersion).toBe(INTENT_TAXONOMY_VERSION);
    expect(result.extractedEntities?.jobReference).toBe('INV-0042');
  });

  // Tradesperson wave 1, Task 4 (taxonomy 1.9.0) — apply_credit. The credit
  // reason is qualified (creditReason, not bare `reason`) per house
  // precedent (refundReason, catalogItemNewName). The invoice reference
  // itself reuses `jobReference` — no separate `invoiceReference` field
  // exists anywhere in this taxonomy.
  it('parses apply_credit with jobReference, amount, and creditReason', () => {
    const result = parseClassifierJson(
      JSON.stringify({
        intentType: 'apply_credit',
        confidence: 0.9,
        extractedEntities: {
          jobReference: 'the Henderson invoice',
          amount: 5000,
          creditReason: 'repeat leak',
        },
      }),
    );
    expect(result?.intentType).toBe('apply_credit');
    expect(result?.extractedEntities?.jobReference).toBe('the Henderson invoice');
    expect(result?.extractedEntities?.amount).toBe(5000);
    expect(result?.extractedEntities?.creditReason).toBe('repeat leak');
  });

  it('classifyIntent end-to-end for apply_credit stamps the current taxonomy version', async () => {
    const gateway = mockGateway(
      JSON.stringify({
        intentType: 'apply_credit',
        confidence: 0.9,
        extractedEntities: { jobReference: 'the Henderson invoice', amount: 5000 },
      }),
    );
    const result = await classifyIntent(
      'Knock 50 dollars off the Henderson invoice',
      { tenantId: 't-1' },
      gateway,
    );
    expect(result.intentType).toBe('apply_credit');
    expect(result.taxonomyVersion).toBe(INTENT_TAXONOMY_VERSION);
    expect(result.extractedEntities?.jobReference).toBe('the Henderson invoice');
  });

  // Tradesperson wave 1, Task 5 (taxonomy 1.10.0) — send_customer_message.
  // customerMessageChannel is enum-validated like refundMethod
  // (invalid → invalidEnumFields); customerMessageBody is a flat string,
  // no separate structured-content field exists.
  it('parses send_customer_message with customerName, customerMessageBody, and customerMessageChannel', () => {
    const result = parseClassifierJson(
      JSON.stringify({
        intentType: 'send_customer_message',
        confidence: 0.9,
        extractedEntities: {
          customerName: 'Henderson',
          customerMessageBody: 'the part arrived, we can come Thursday morning',
          customerMessageChannel: 'sms',
        },
      }),
    );
    expect(result?.intentType).toBe('send_customer_message');
    expect(result?.extractedEntities?.customerName).toBe('Henderson');
    expect(result?.extractedEntities?.customerMessageBody).toBe(
      'the part arrived, we can come Thursday morning',
    );
    expect(result?.extractedEntities?.customerMessageChannel).toBe('sms');
  });

  it('defaults customerMessageChannel to undefined when unstated (SendCustomerMessageTaskHandler defaults it to sms downstream)', () => {
    const result = parseClassifierJson(
      JSON.stringify({
        intentType: 'send_customer_message',
        confidence: 0.9,
        extractedEntities: { customerName: 'Garcia', customerMessageBody: 'inspection passed' },
      }),
    );
    expect(result?.extractedEntities?.customerMessageChannel).toBeUndefined();
  });

  it('an invalid customerMessageChannel is dropped and recorded as an invalid enum field', () => {
    const result = parseClassifierJson(
      JSON.stringify({
        intentType: 'send_customer_message',
        confidence: 0.9,
        extractedEntities: {
          customerName: 'Garcia',
          customerMessageBody: 'inspection passed',
          customerMessageChannel: 'carrier_pigeon',
        },
      }),
    );
    expect(result?.extractedEntities?.customerMessageChannel).toBeUndefined();
    expect(result?.invalidEnumFields).toContainEqual({
      field: 'customerMessageChannel',
      value: 'carrier_pigeon',
    });
  });

  it('classifyIntent end-to-end for send_customer_message stamps the current taxonomy version', async () => {
    const gateway = mockGateway(
      JSON.stringify({
        intentType: 'send_customer_message',
        confidence: 0.9,
        extractedEntities: {
          customerName: 'Henderson',
          customerMessageBody: 'the part arrived',
        },
      }),
    );
    const result = await classifyIntent(
      'Text the Hendersons the part arrived',
      { tenantId: 't-1' },
      gateway,
    );
    expect(result.intentType).toBe('send_customer_message');
    expect(result.taxonomyVersion).toBe(INTENT_TAXONOMY_VERSION);
    expect(result.extractedEntities?.customerName).toBe('Henderson');
  });
});

// ─── Part A — ai_run_id threading (classify → classification) ─────────────────

describe('intent-classifier — ai_run_id surfacing', () => {
  function mockGatewayWithAiRun(jsonContent: string, aiRunId?: string): LLMGateway {
    return {
      complete: vi.fn(async () => ({
        content: jsonContent,
        model: 'mock-model',
        provider: 'mock',
        tokenUsage: { input: 100, output: 50, total: 150 },
        latencyMs: 42,
        ...(aiRunId ? { aiRunId } : {}),
      } satisfies LLMResponse)),
    } as unknown as LLMGateway;
  }

  it("surfaces the gateway's persisted ai_runs id onto the classification", async () => {
    const AI_RUN_ID = '22222222-2222-4222-8222-222222222222';
    const gateway = mockGatewayWithAiRun(
      JSON.stringify({
        intentType: 'create_invoice',
        confidence: 0.95,
        extractedEntities: { customerName: 'Acme' },
      }),
      AI_RUN_ID,
    );
    const result = await classifyIntent('Create an invoice for Acme', { tenantId: 't-1' }, gateway);
    expect(result.intentType).toBe('create_invoice');
    expect(result.aiRunId).toBe(AI_RUN_ID);
  });

  it('omits aiRunId when the gateway response carries none (null fallback)', async () => {
    const gateway = mockGatewayWithAiRun(
      JSON.stringify({ intentType: 'create_invoice', confidence: 0.95 }),
    );
    const result = await classifyIntent('Create an invoice for Acme', { tenantId: 't-1' }, gateway);
    expect(result.aiRunId).toBeUndefined();
  });

  it('passes the tenantId to the gateway so the ai_runs row persists under the real tenant', async () => {
    const gateway = mockGatewayWithAiRun(
      JSON.stringify({ intentType: 'create_invoice', confidence: 0.95 }),
      '33333333-3333-4333-8333-333333333333',
    );
    await classifyIntent('Create an invoice for Acme', { tenantId: 'tenant-real' }, gateway);
    const call = (gateway.complete as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
      tenantId?: string;
    };
    // Top-level tenantId is what LLMGateway reads to scope the ai_runs row;
    // without it the run persists under the 'system' fallback and fails the
    // tenants FK on Postgres (aiRunId would come back undefined → null link).
    expect(call.tenantId).toBe('tenant-real');
  });
});
