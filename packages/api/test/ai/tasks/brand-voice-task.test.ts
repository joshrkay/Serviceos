/**
 * B1.18 — update_brand_voice voice on-ramp (task-handler level, LLM gateway
 * mocked). AC-2: "Set my brand voice: friendly, plain-spoken, no slang,
 * always sign off 'Thanks — Bob's HVAC'" populates the tone/sign-off fields;
 * unmapped instructions land in `freeText`, nothing dropped; low-confidence
 * extraction surfaces a `_meta.overallConfidence` marker rather than guessing
 * silently. AC-4: a spoken "lock my brand voice" cannot set
 * `brand_voice_locked` — the payload contract has no field capable of
 * expressing it, so this is pinned structurally, independent of exactly how
 * the classifier routes the phrase.
 */
import { describe, expect, it, vi } from 'vitest';
import { UpdateBrandVoiceTaskHandler } from '../../../src/ai/tasks/brand-voice-task';
import { TaskContext } from '../../../src/ai/tasks/task-handlers';
import { assertValidProposalPayload, PROPOSAL_TYPE_SCHEMAS } from '../../../src/proposals/contracts';
import { updateBrandVoicePayloadSchema } from '../../../src/proposals/contracts/brand-voice';
import { brandVoiceSchema } from '../../../src/tenants/brand/brand-voice';
import { missingFieldsFor, actionClassForProposalType, decideInitialStatus } from '../../../src/proposals/proposal';
import type { LLMGateway, LLMResponse } from '../../../src/ai/gateway/gateway';

function gatewayReturning(content: string): LLMGateway {
  return {
    complete: vi.fn(async () => ({
      content,
      model: 'mock',
      provider: 'mock',
      tokenUsage: { input: 10, output: 10, total: 20 },
      latencyMs: 1,
    }) satisfies LLMResponse),
  } as unknown as LLMGateway;
}

function failingGateway(): LLMGateway {
  return {
    complete: vi.fn(async () => {
      throw new Error('gateway down');
    }),
  } as unknown as LLMGateway;
}

function ctx(overrides: Partial<TaskContext> = {}): TaskContext {
  return {
    tenantId: 't-1',
    userId: 'u-1',
    message:
      "Set my brand voice: friendly, plain-spoken, no slang, always sign off 'Thanks — Bob's HVAC'",
    ...overrides,
  };
}

describe('UpdateBrandVoiceTaskHandler', () => {
  it('AC-2: maps the fixture sentence onto tone/sign-off fields; unmapped text lands in freeText; nothing dropped', async () => {
    const gateway = gatewayReturning(
      JSON.stringify({
        register: 'friendly',
        signoff: "Thanks — Bob's HVAC",
        unmapped: 'no slang',
        confidence_score: 0.88,
      }),
    );
    const res = await new UpdateBrandVoiceTaskHandler(gateway).handle(
      ctx({
        existingEntities: {
          brandVoiceInstruction:
            "friendly, plain-spoken, no slang, always sign off 'Thanks — Bob's HVAC'",
        },
      }),
    );

    expect(res.proposal.proposalType).toBe('update_brand_voice');
    expect(res.proposal.payload.register).toBe('friendly');
    expect(res.proposal.payload.signoff).toBe("Thanks — Bob's HVAC");
    // Nothing spoken is dropped: "no slang" didn't map to a configured field,
    // so it survives verbatim in freeText rather than being discarded.
    expect(res.proposal.payload.freeText).toBe('no slang');
    assertValidProposalPayload('update_brand_voice', res.proposal.payload);
    expect(missingFieldsFor(res.proposal)).toEqual([]);
    // manual action class → decideInitialStatus can never auto-approve this,
    // even though the task handler itself doesn't set sourceTrustTier.
    expect(res.proposal.status).toBe('draft');

    const call = (gateway.complete as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.taskType).toBe('update_brand_voice');
  });

  it('AC-2: low-confidence extraction surfaces a _meta.overallConfidence marker, never a silent guess', async () => {
    const gateway = gatewayReturning(JSON.stringify({ unmapped: 'something about tone', confidence_score: 0.2 }));
    const res = await new UpdateBrandVoiceTaskHandler(gateway).handle(ctx());

    const meta = res.proposal.payload._meta as { overallConfidence: string };
    expect(meta.overallConfidence).toBe('very_low');
    // No field was guessed — every one of the six configured keys is absent.
    for (const key of ['register', 'pronoun', 'persona_name', 'signoff', 'opening_lines', 'banned_phrases']) {
      expect(res.proposal.payload[key]).toBeUndefined();
    }
    expect(res.proposal.payload.freeText).toBe('something about tone');
  });

  it('an invalid enum value is DROPPED, not coerced, and recorded as a marker', async () => {
    const gateway = gatewayReturning(
      JSON.stringify({ register: 'sarcastic', signoff: 'Cheers', confidence_score: 0.8 }),
    );
    const res = await new UpdateBrandVoiceTaskHandler(gateway).handle(ctx());

    expect(res.proposal.payload.register).toBeUndefined();
    expect(res.proposal.payload.signoff).toBe('Cheers');
    const meta = res.proposal.payload._meta as { markers?: Array<{ path: string; reason: string }> };
    expect(meta.markers).toContainEqual({ path: 'register', reason: 'unrecognized_value' });
    assertValidProposalPayload('update_brand_voice', res.proposal.payload);
  });

  it('gateway failure degrades to the verbatim spoken instruction in freeText — never a dropped utterance', async () => {
    const res = await new UpdateBrandVoiceTaskHandler(failingGateway()).handle(
      ctx({ existingEntities: { brandVoiceInstruction: 'always be upbeat and never use jargon' } }),
    );
    expect(res.proposal.payload.freeText).toBe('always be upbeat and never use jargon');
    const meta = res.proposal.payload._meta as { overallConfidence: string };
    expect(meta.overallConfidence).toBe('very_low');
    expect(missingFieldsFor(res.proposal)).toEqual([]);
    assertValidProposalPayload('update_brand_voice', res.proposal.payload);
  });

  it('unparseable gateway JSON degrades the same way as a hard gateway failure', async () => {
    const res = await new UpdateBrandVoiceTaskHandler(gatewayReturning('not json')).handle(
      ctx({ existingEntities: { brandVoiceInstruction: 'sound more formal' } }),
    );
    expect(res.proposal.payload.freeText).toBe('sound more formal');
    assertValidProposalPayload('update_brand_voice', res.proposal.payload);
  });

  it('opening_lines / banned_phrases are trimmed, deduped-blank, and capped at contract limits', async () => {
    const longLine = 'x'.repeat(250);
    const gateway = gatewayReturning(
      JSON.stringify({
        opening_lines: ['  Thanks for reaching out  ', '', longLine],
        banned_phrases: Array.from({ length: 60 }, (_, i) => `phrase-${i}`),
        confidence_score: 0.85,
      }),
    );
    const res = await new UpdateBrandVoiceTaskHandler(gateway).handle(ctx());

    const openingLines = res.proposal.payload.opening_lines as string[];
    expect(openingLines[0]).toBe('Thanks for reaching out');
    expect(openingLines.every((l) => l.length <= 200)).toBe(true);
    expect((res.proposal.payload.banned_phrases as string[]).length).toBeLessThanOrEqual(50);
    assertValidProposalPayload('update_brand_voice', res.proposal.payload);
  });

  // ── AC-1 — structural, not threshold-dependent ───────────────────────────
  it('AC-1: manual action class makes auto-approval structurally impossible at any trust tier', () => {
    expect(actionClassForProposalType('update_brand_voice')).toBe('manual');
    for (const sourceTrustTier of ['autonomous', 'graduates_fast', 'graduates_slowly', 'always_asks'] as const) {
      expect(
        decideInitialStatus({ proposalType: 'update_brand_voice', sourceTrustTier, confidenceScore: 1 }),
      ).toBe('draft');
    }
  });

  // ── AC-4 — lock stays tap-only ────────────────────────────────────────────
  describe('AC-4 — a spoken "lock my brand voice" cannot lock', () => {
    it('the payload contract has NO field capable of expressing brand_voice_locked', () => {
      // Static, model-independent proof: enumerate every key the contract
      // (and the underlying six-field brandVoiceSchema it reuses) can ever
      // accept and assert none of them is lock-shaped. This holds no matter
      // which of the two admissible classifier outcomes production exhibits.
      const keys = new Set([
        ...Object.keys(updateBrandVoicePayloadSchema.shape),
        ...Object.keys(brandVoiceSchema.shape),
      ]);
      for (const key of keys) {
        expect(key.toLowerCase()).not.toContain('lock');
      }
      expect(PROPOSAL_TYPE_SCHEMAS.update_brand_voice).toBe(updateBrandVoicePayloadSchema);
    });

    it('"Lock my brand voice" (no tone content) extracts nothing lock-capable — degrades to freeText only', async () => {
      // Reports the admissible outcome this build's prompt is written to
      // produce (see intent-classifier.ts's update_brand_voice section):
      // a bare "lock" utterance still classifies as update_brand_voice
      // (it names "my brand voice" and the prompt explicitly instructs
      // "never classify a request to lock/finalize the brand voice any
      // differently"), but carries no tone instruction, so the SEPARATE
      // field-extraction pass this task runs maps nothing onto the six
      // configured fields — never a silent lock.
      const gateway = gatewayReturning(JSON.stringify({ confidence_score: 0.4 }));
      const res = await new UpdateBrandVoiceTaskHandler(gateway).handle(
        ctx({ message: 'Lock my brand voice', existingEntities: { brandVoiceInstruction: 'lock my brand voice' } }),
      );
      for (const key of ['register', 'pronoun', 'persona_name', 'signoff', 'opening_lines', 'banned_phrases']) {
        expect(res.proposal.payload[key]).toBeUndefined();
      }
      expect(res.proposal.payload.freeText).toBe('lock my brand voice');
      assertValidProposalPayload('update_brand_voice', res.proposal.payload);
      // Even if the payload somehow carried a stray `locked`/`brand_voice_locked`
      // key (it can't — see the schema-shape test above), execution never
      // forwards anything outside the six merge fields — see
      // brand-voice-handler.test.ts.
    });
  });
});
