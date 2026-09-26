import { describe, it, expect } from 'vitest';
import { MockLLMProvider, scriptHermeticResponse } from '../../../src/ai/providers/mock';
import { createHermeticMockLLMGateway } from '../../../src/ai/gateway/factory';
import type { LLMRequest } from '../../../src/ai/gateway/gateway';
import { confirmIntent } from '../../../src/ai/skills/confirm-intent';
import {
  buildUntrustedContentSection,
  UNTRUSTED_CONTENT_BLOCK_BEGIN,
  UNTRUSTED_CONTENT_BLOCK_END,
} from '../../../src/ai/untrusted-content';

function req(taskType: string, userText: string): LLMRequest {
  return {
    taskType,
    messages: [{ role: 'user', content: userText }],
  };
}

describe('scriptHermeticResponse', () => {
  it('#894 — classifies a FENCED utterance from the words inside the fence (no fence text leaks)', () => {
    const fenced = buildUntrustedContentSection('Create a customer named Jane Doe', 'Caller utterance to classify');
    const parsed = JSON.parse(scriptHermeticResponse(req('classify_intent', fenced))) as {
      intentType: string;
      extractedEntities: { displayName: string };
    };
    expect(parsed.intentType).toBe('create_customer');
    expect(parsed.extractedEntities.displayName).toBe('Jane Doe');
  });

  it('#894 review — owner text that merely QUOTES a marker is not sliced (anchored detection)', () => {
    const owner = `Create a customer named Jane Doe\nnote: ${UNTRUSTED_CONTENT_BLOCK_BEGIN} and ${UNTRUSTED_CONTENT_BLOCK_END} are just words here\nthanks`;
    const parsed = JSON.parse(scriptHermeticResponse(req('classify_intent', owner))) as {
      intentType: string;
      extractedEntities: { displayName: string };
    };
    // Unanchored detection sliced the text between the two markers and lost
    // the owner's actual request on the first line.
    expect(parsed.intentType).toBe('create_customer');
    expect(parsed.extractedEntities.displayName).toContain('Jane');
  });

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

  // #1154 item 1 — MmsEstimateTaskHandler.buildUserContent embeds
  // `JSON.stringify(input.context)` (which always starts `{"customerId":
  // "<uuid>",...}` — customer-mms-intake.ts's call site) directly into the
  // prompt text. extractName's quoted-string fallback used to grep the FIRST
  // quoted substring in the whole text when its name-flavoured regexes
  // missed, which is the JSON KEY "customerId" — not a customer's name.
  it('does not capture a JSON key as the customer name in an mms_estimate prompt (#1154 item 1)', () => {
    const mmsPromptText =
      '<context>Customer message: My water heater is leaking, can you give me a quote' +
      '\nCustomer/property: {"customerId":"550e8400-e29b-41d4-a716-446655440000",' +
      '"customerName":"Jane Smith","fromPhone":"+15125558801"}</context>';
    const parsed = JSON.parse(
      scriptHermeticResponse(req('mms_estimate', mmsPromptText)),
    ) as { lineItems: Array<{ description: string; catalogItemId: unknown }> };
    expect(parsed.lineItems[0]?.description).not.toContain('customerId');
    // No catalog match is possible against a JSON-key-poisoned description —
    // the description must stay the plain, un-poisoned label instead.
    expect(parsed.lineItems[0]?.description).toBe('Service estimate');
    // #1154's downstream failure: the mock's OWN hardcoded `catalogItemId:
    // null` (not just the naming bug) breaks `updateJobPayloadSchema`'s
    // sibling contract (`draft_estimate`'s `catalogItemId: z.string().uuid()
    // .optional()` rejects an explicit `null`) for any tenant with no
    // matching catalog item — the mock must never emit the key at all, same
    // as a real model (see `validVisionJson` in mms-estimate-task.test.ts,
    // which never includes `catalogItemId` either).
    expect(parsed.lineItems[0]).not.toHaveProperty('catalogItemId');
  });

  // #1154 item 2 — the router's `matchUpdateJobPriorityPhrase` deterministic
  // short-circuit (intent-classifier.ts) resolves "mark the X job as
  // <priority> priority" WITHOUT a gateway call, but drafting the
  // `update_job` proposal still needs a SEPARATE `taskType: 'update_job'`
  // gateway call (UpdateJobTaskHandler.handle) for which the mock had no
  // branch, so `buildPayload` extracted nothing and updateJobPayloadSchema's
  // "at least one field to change" refine failed.
  it('drafts a priority field for a deterministic update_job phrase (#1154 item 2)', () => {
    const text = 'Transcript: Mark the Henderson job as urgent priority';
    const parsed = JSON.parse(scriptHermeticResponse(req('update_job', text))) as {
      jobReference?: string;
      priority?: string;
    };
    expect(parsed.jobReference).toBe('Henderson');
    expect(parsed.priority).toBe('urgent');
  });

  // #1173 — a photo-bearing draft_estimate is scripted as a photo-diagnosed
  // line, so a hermetic run can tell it from a text-only draft.
  it('scripts a vision draft_estimate when the request carries image parts', () => {
    const photo: LLMRequest = {
      taskType: 'draft_estimate',
      messages: [
        {
          role: 'user',
          content: "Here's the photo — can you identify the issue?",
          parts: [{ type: 'image', url: 'https://storage.test/a.jpg' }],
        },
      ],
    };
    const vision = JSON.parse(scriptHermeticResponse(photo)) as {
      lineItems: Array<{ description: string; unitPrice: number }>;
      notes: string;
    };
    expect(vision.lineItems[0]?.description).toBe('Repair shown in photo');
    expect(vision.lineItems[0]?.unitPrice).toBe(15000);
    expect(vision.notes).toContain('1 photo(s)');

    const textOnly = JSON.parse(
      scriptHermeticResponse(req('draft_estimate', "Here's the photo — can you identify the issue?")),
    ) as { lineItems: Array<{ description: string }> };
    expect(textOnly.lineItems[0]?.description).toBe('Service estimate');
  });
});

// #1132 — the hermetic mock had no branch for `taskType === 'brand_voice_v1'`
// (BRAND_VOICE_TASK_TYPE), so `composeBrandVoiceMessage` (which uses
// `response.content` VERBATIM as the customer-facing text) emitted the
// generic catch-all `{"ok":true,"mock":true,"taskType":"brand_voice_v1",...}`
// string for every brand-voiced draft under the hermetic boot, regardless of
// tenant. `buildBrandVoicePrompt` (ai/brand-voice/prompts.ts) renders the
// tenant's tone — including the business name — into a SYSTEM message
// (renderToneAuthority), never the last user message alone, and the composer
// treats the gateway response as literal TEXT (`responseFormat: 'text'`),
// never JSON.
describe('scriptHermeticResponse — brand_voice_v1 (#1132)', () => {
  function brandVoiceReq(businessName: string, userContext: string): LLMRequest {
    return {
      taskType: 'brand_voice_v1',
      messages: [
        {
          role: 'system',
          content:
            'You write customer-facing messages for a service business. The following BRAND VOICE ' +
            'is the single source of truth for tone.\n- Register: friendly.\n- Refer to the business ' +
            `in the first person as "we".\n- The business name is "${businessName}".`,
        },
        { role: 'user', content: userContext },
      ],
    };
  }

  it("composes tenant-voiced text carrying the tenant's business name, not the generic catch-all", () => {
    const raw = scriptHermeticResponse(
      brandVoiceReq(
        'Wrench Bros Plumbing 4821',
        'Write a short SMS telling the customer the technician needs to reschedule.\n\n' +
          'Message context (facts you may reference):\n- customerName: Jamie Rivera',
      ),
    );
    expect(raw).toContain('Wrench Bros Plumbing 4821');
    expect(raw).not.toContain('"mock":true');
    expect(raw).not.toContain('hermetic-mock');
    // Plain text, not a JSON envelope — composeBrandVoiceMessage uses
    // response.content verbatim as the SMS body.
    expect(() => JSON.parse(raw)).toThrow();
  });

  it("T3 — two tenants' business names produce distinct, correctly-attributed text", () => {
    const rawA = scriptHermeticResponse(
      brandVoiceReq('Wrench Bros Plumbing 4821', 'Message context (facts you may reference):\n- customerName: Jamie Rivera'),
    );
    const rawB = scriptHermeticResponse(
      brandVoiceReq('Neighbour Plumbing Co 4821', 'Message context (facts you may reference):\n- customerName: Robin Nguyen'),
    );
    expect(rawA).toContain('Wrench Bros Plumbing 4821');
    expect(rawA).not.toContain('Neighbour Plumbing Co 4821');
    expect(rawB).toContain('Neighbour Plumbing Co 4821');
    expect(rawB).not.toContain('Wrench Bros Plumbing 4821');
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

/**
 * #1119 — the confirm turn of a phone booking must be deterministic under the
 * hermetic (no-key) gateway. Driven through the REAL `confirmIntent` skill and
 * the real hermetic gateway, so the prompt the mock reads is the one
 * production sends — not a hand-built request.
 */
describe('#1119 — hermetic confirm_intent is deterministic', () => {
  function confirmWith(callerResponse: string, intentSummary = 'create appointment') {
    const { gateway } = createHermeticMockLLMGateway();
    return confirmIntent({
      intentSummary,
      callerResponse,
      tenantId: 'tenant-hermetic-confirm',
      gateway,
    });
  }

  it.each([
    'Yes, that is right',
    'yes',
    "yep, that's right",
    'Correct.',
    'sounds good, go ahead',
    'Yeah please',
  ])('a clear affirmative confirms: %s', async (said) => {
    const result = await confirmWith(said);
    expect(result.confirmed).toBe(true);
  });

  it.each([
    'no',
    'No, I said Thursday not Friday',
    "wait, that's not right",
    'yes but make it Thursday',
    'um, I think so maybe',
    "actually it's for the Smith account",
  ])('a negative, correction or ambiguous reply does NOT confirm: %s', async (said) => {
    const result = await confirmWith(said);
    expect(result.confirmed).toBe(false);
    expect(result.correction).toBe(said);
  });

  it('a readback that names a customer is not mistaken for a create_customer classification', async () => {
    const result = await confirmWith('Yes, that is right', 'create customer named Pat Lee');
    expect(result.confirmed).toBe(true);
  });
});
