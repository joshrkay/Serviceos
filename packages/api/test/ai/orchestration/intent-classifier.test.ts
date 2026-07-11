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

  it('quoted intents in EXTENDED_INTENTS_PROMPT_SECTION match EXTENDED_INTENT_TYPES', () => {
    const fromPrompt = intentNamesFromPrompt(EXTENDED_INTENTS_PROMPT_SECTION);
    const fromSet = new Set(EXTENDED_INTENT_TYPES);
    for (const name of fromPrompt) {
      expect(fromSet.has(name as never), `"${name}" in prompt but not in EXTENDED_INTENT_TYPES`).toBe(true);
    }
    for (const name of fromSet) {
      expect(fromPrompt.has(name), `"${name}" in EXTENDED_INTENT_TYPES but not quoted in prompt`).toBe(true);
    }
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
  it('bumped the taxonomy version to 1.2.0', () => {
    expect(INTENT_TAXONOMY_VERSION).toBe('1.2.0');
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

  it('classifyIntent stamps 1.2.0 on a new-intent classification end-to-end', async () => {
    const gateway = mockGateway(
      JSON.stringify({
        intentType: 'respond_to_review',
        confidence: 0.9,
        extractedEntities: { reviewReference: 'that bad review' },
      }),
    );
    const result = await classifyIntent('Respond to that bad review', { tenantId: 't-1' }, gateway);
    expect(result.intentType).toBe('respond_to_review');
    expect(result.taxonomyVersion).toBe('1.2.0');
  });
});
