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
import { formatVerticalForCallerPrompt } from '../../../src/verticals/context-assembly';
import { createHvacPack } from '../../../src/verticals/packs/hvac';
import { createPlumbingPack } from '../../../src/verticals/packs/plumbing';

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

// ─── RV-071 — owner approval intents ─────────────────────────────────────────

import { OWNER_APPROVAL_PROMPT_SECTION, isVoiceApprovalIntent } from '../../../src/ai/orchestration/intent-classifier';

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
    expect(isVoiceApprovalIntent(undefined)).toBe(false);
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
    }
  });
});

// eslint-disable-next-line import/first
import {
  EXTENDED_INTENTS_PROMPT_SECTION,
  isLookupIntent,
  matchExtendedIntentPhrase,
} from '../../../src/ai/orchestration/intent-classifier';

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

  it('matchExtendedIntentPhrase matches only explicit complaint phrasings', () => {
    expect(matchExtendedIntentPhrase('I want to file a complaint about the install')).toBe('complaint');
    expect(matchExtendedIntentPhrase('I would like to complain')).toBe('complaint');
    // Fix #2: "I'd like to complain" must match (contraction with no whitespace after "I").
    expect(matchExtendedIntentPhrase("I'd like to complain about the service")).toBe('complaint');
    expect(matchExtendedIntentPhrase('I have a complaint')).toBe('complaint');
    // Vague unhappiness is NOT deterministically a complaint — the LLM /
    // escalation paths own it (e.g. the vague-complaint-escalated corpus
    // script must keep escalating, not minting records).
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
    // Ordinary commands never collapse into a lookup.
    expect(matchExtendedIntentPhrase('Create an invoice for Acme for 450 dollars')).toBeNull();
    expect(matchExtendedIntentPhrase('Schedule my day off next Tuesday')).toBeNull();
    expect(matchExtendedIntentPhrase('')).toBeNull();
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

  it('extendedIntents: true appends the section as a SEPARATE system message for non-matching transcripts', async () => {
    const gateway = mockGateway('{"intentType":"lookup_day_overview","confidence":0.85}');
    const result = await classifyIntent(
      'morning rundown please, schedule and approvals',
      { tenantId: 't1', extendedIntents: true },
      gateway,
    );
    expect(result.intentType).toBe('lookup_day_overview');
    const call = (gateway.complete as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const systemMessages = call.messages.filter((m: { role: string }) => m.role === 'system');
    expect(systemMessages.length).toBe(2);
    expect(systemMessages[1].content).toBe(EXTENDED_INTENTS_PROMPT_SECTION);
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
