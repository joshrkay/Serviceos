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
 *
 * PR review (2026-07): also pins the approve-to-fail gate — a draft carrying
 * none of the six persisted brand-voice fields must be stamped
 * `missingFields` (never approvable), because UpdateBrandVoiceExecutionHandler
 * refuses exactly that payload. The gate cases are cross-checked against the
 * REAL execution handler so the two halves can't drift.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  BRAND_VOICE_GATE_FIELD,
  FREE_TEXT_GATE_FIELD,
  UpdateBrandVoiceTaskHandler,
} from '../../../src/ai/tasks/brand-voice-task';
import { TaskContext } from '../../../src/ai/tasks/task-handlers';
import { assertValidProposalPayload, PROPOSAL_TYPE_SCHEMAS } from '../../../src/proposals/contracts';
import { updateBrandVoicePayloadSchema } from '../../../src/proposals/contracts/brand-voice';
import { BRAND_VOICE_FIELDS, brandVoiceSchema } from '../../../src/tenants/brand/brand-voice';
import { InMemoryBrandVoiceRepository } from '../../../src/tenants/brand/in-memory-brand-voice-repository';
import { InMemoryAuditRepository } from '../../../src/audit/audit';
import { UpdateBrandVoiceExecutionHandler } from '../../../src/proposals/execution/brand-voice-handler';
import {
  createProposal,
  InMemoryProposalRepository,
  missingFieldsFor,
  actionClassForProposalType,
  decideInitialStatus,
} from '../../../src/proposals/proposal';
import { editProposal } from '../../../src/proposals/actions';
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
  it('AC-2: maps the fixture sentence onto tone/sign-off fields; unmapped text lands in freeText; nothing dropped; MIXED payload is gated', async () => {
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
    // MIXED payload (a mapped field AND unmapped content in the same
    // utterance) is NOT approvable: without this gate, execution would apply
    // only register/signoff and silently drop "no slang" while reporting
    // success. See FREE_TEXT_GATE_FIELD.
    expect(missingFieldsFor(res.proposal)).toEqual([FREE_TEXT_GATE_FIELD]);
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
    // …and it is GATED: no persisted field was extracted, so execution could
    // only ever fail — see the approve-to-fail block below.
    expect(missingFieldsFor(res.proposal)).toEqual([BRAND_VOICE_GATE_FIELD]);
    assertValidProposalPayload('update_brand_voice', res.proposal.payload);
  });

  it('unparseable gateway JSON degrades the same way as a hard gateway failure', async () => {
    const res = await new UpdateBrandVoiceTaskHandler(gatewayReturning('not json')).handle(
      ctx({ existingEntities: { brandVoiceInstruction: 'sound more formal' } }),
    );
    expect(res.proposal.payload.freeText).toBe('sound more formal');
    expect(missingFieldsFor(res.proposal)).toEqual([BRAND_VOICE_GATE_FIELD]);
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
      // …and, crucially, it is NOT approvable: a lock utterance must land as a
      // gated card, never as a card an operator can tap Approve on. See the
      // approve-to-fail block below for the execution-side pairing.
      expect(missingFieldsFor(res.proposal)).toEqual([BRAND_VOICE_GATE_FIELD]);
      // Even if the payload somehow carried a stray `locked`/`brand_voice_locked`
      // key (it can't — see the schema-shape test above), execution never
      // forwards anything outside the six merge fields — see
      // brand-voice-handler.test.ts.
    });
  });

  // ── PR review (2026-07) — no approvable-but-doomed proposal ───────────────
  //
  // The defect: a payload carrying only `freeText` + `_meta` left
  // `missingFields` EMPTY, so approveProposal let it through, and
  // UpdateBrandVoiceExecutionHandler — which strips `freeText`/`_meta` via
  // brandVoiceSchema and refuses an empty patch — then failed 100% of the
  // time. These tests pin BOTH halves of the pairing: the drafted proposal is
  // gated, AND the very same payload really is refused by the production
  // execution handler (so the gate is not merely decorative).
  describe('approve-to-fail gate — no persisted brand-voice field means NOT approvable', () => {
    async function executionRefuses(payload: Record<string, unknown>): Promise<string> {
      const handler = new UpdateBrandVoiceExecutionHandler(
        new InMemoryBrandVoiceRepository(),
        new InMemoryAuditRepository(),
      );
      const result = await handler.execute(
        {
          ...createProposal({
            tenantId: 't-1',
            proposalType: 'update_brand_voice',
            payload,
            summary: 'Update brand voice',
            createdBy: 'u-1',
          }),
          status: 'approved',
        },
        { tenantId: 't-1', executedBy: 'u-1' },
      );
      expect(result.success).toBe(false);
      return result.error ?? '';
    }

    const cases: Array<{ name: string; gateway: () => LLMGateway; spoken: string }> = [
      {
        name: 'extraction failure (gateway throws)',
        gateway: failingGateway,
        spoken: 'always be upbeat and never use jargon',
      },
      {
        name: 'unparseable JSON',
        gateway: () => gatewayReturning('not json at all {{{'),
        spoken: 'sound more formal',
      },
      {
        name: 'freeText-only (model mapped nothing onto the six fields)',
        gateway: () => gatewayReturning(JSON.stringify({ unmapped: 'keep replies under two sentences', confidence_score: 0.7 })),
        spoken: 'keep replies under two sentences',
      },
      {
        name: '"Lock my brand voice" — tap-only by design, never executable by voice',
        gateway: () => gatewayReturning(JSON.stringify({ confidence_score: 0.4 })),
        spoken: 'lock my brand voice',
      },
    ];

    for (const { name, gateway, spoken } of cases) {
      it(`${name}: gated (missingFields non-empty), and the same payload is refused at execution`, async () => {
        const res = await new UpdateBrandVoiceTaskHandler(gateway()).handle(
          ctx({ message: spoken, existingEntities: { brandVoiceInstruction: spoken } }),
        );

        // No persisted field was extracted…
        for (const key of BRAND_VOICE_FIELDS) {
          expect(res.proposal.payload[key]).toBeUndefined();
        }
        // …so the proposal is gated and can never be approved.
        expect(missingFieldsFor(res.proposal)).toEqual([BRAND_VOICE_GATE_FIELD]);
        expect(res.proposal.status).toBe('draft');
        // Nothing spoken is dropped despite the gate (AC-2 still holds).
        expect(res.proposal.payload.freeText).toBeTruthy();
        assertValidProposalPayload('update_brand_voice', res.proposal.payload);

        // The gate is real, not decorative: had it been approved, execution
        // would have failed deterministically.
        expect(await executionRefuses(res.proposal.payload as Record<string, unknown>)).toMatch(
          /no brand-voice fields/,
        );
      });
    }

    it('AC-4: the gate never becomes a lock affordance — the gated key is one of the six persisted fields, and no payload key is lock-shaped', async () => {
      const res = await new UpdateBrandVoiceTaskHandler(
        gatewayReturning(JSON.stringify({ confidence_score: 0.4 })),
      ).handle(ctx({ message: 'Lock my brand voice', existingEntities: { brandVoiceInstruction: 'lock my brand voice' } }));

      // The gate asks for a real brand-voice field, never a lock field.
      expect(BRAND_VOICE_FIELDS).toContain(BRAND_VOICE_GATE_FIELD);
      for (const key of Object.keys(res.proposal.payload)) {
        expect(key.toLowerCase()).not.toContain('lock');
      }
      for (const key of missingFieldsFor(res.proposal)) {
        expect(key.toLowerCase()).not.toContain('lock');
      }
    });

    it('positive control: a real extracted field ALONE (register/tone, nothing unmapped) stays approvable — missingFields empty and execution succeeds', async () => {
      const res = await new UpdateBrandVoiceTaskHandler(
        gatewayReturning(JSON.stringify({ register: 'friendly', confidence_score: 0.9 })),
      ).handle(ctx());

      expect(res.proposal.payload.register).toBe('friendly');
      expect(res.proposal.payload.freeText).toBeUndefined();
      expect(missingFieldsFor(res.proposal)).toEqual([]);
      assertValidProposalPayload('update_brand_voice', res.proposal.payload);

      const handler = new UpdateBrandVoiceExecutionHandler(
        new InMemoryBrandVoiceRepository(),
        new InMemoryAuditRepository(),
      );
      const result = await handler.execute(
        { ...res.proposal, status: 'approved' },
        { tenantId: 't-1', executedBy: 'u-1' },
      );
      expect(result.success).toBe(true);
    });

    it('positive control: a non-register field alone (signoff) is also ungated and executes', async () => {
      const res = await new UpdateBrandVoiceTaskHandler(
        gatewayReturning(JSON.stringify({ signoff: "Thanks — Bob's HVAC", confidence_score: 0.9 })),
      ).handle(ctx());

      expect(missingFieldsFor(res.proposal)).toEqual([]);
      const handler = new UpdateBrandVoiceExecutionHandler(
        new InMemoryBrandVoiceRepository(),
        new InMemoryAuditRepository(),
      );
      const result = await handler.execute(
        { ...res.proposal, status: 'approved' },
        { tenantId: 't-1', executedBy: 'u-1' },
      );
      expect(result.success).toBe(true);
    });
  });

  // ── PR review (2026-07) — approved-then-silently-partial ─────────────────
  //
  // "Be friendly, and never quote prices by text" mapped `register` AND
  // flagged `unmapped: 'never quote prices by text'`. Before this gate,
  // `mappedAnything` alone (register persisted) made the proposal
  // approvable with an EMPTY missingFields, so approveProposal let it
  // through; UpdateBrandVoiceExecutionHandler's strip-mode parse
  // (brandVoiceSchema.safeParse) then silently dropped `freeText`, applied
  // only `register`, and reported SUCCESS. Nothing surfaced the loss — worse
  // than approved-then-failed, because here the card lies that everything
  // the owner said was honored. These tests pin the fix and its unblock path.
  describe('mixed-payload gate — a mapped field AND unmapped content together is NOT silently approvable', () => {
    function mixedGateway(): LLMGateway {
      return gatewayReturning(
        JSON.stringify({
          register: 'friendly',
          unmapped: 'never quote prices by text',
          confidence_score: 0.85,
        }),
      );
    }

    it('"be friendly, and never quote prices by text": register maps, the pricing prohibition is flagged unmapped, and the proposal is gated (not approvable)', async () => {
      const res = await new UpdateBrandVoiceTaskHandler(mixedGateway()).handle(
        ctx({
          message: 'be friendly, and never quote prices by text',
          existingEntities: { brandVoiceInstruction: 'be friendly, and never quote prices by text' },
        }),
      );

      expect(res.proposal.payload.register).toBe('friendly');
      // AC-2 still holds at the payload level: nothing spoken is discarded
      // from the DRAFT itself.
      expect(res.proposal.payload.freeText).toBe('never quote prices by text');
      // …but unlike before the fix, it is gated: an operator must resolve
      // the unmapped constraint before this can ever be approved.
      expect(missingFieldsFor(res.proposal)).toEqual([FREE_TEXT_GATE_FIELD]);
      expect(res.proposal.status).toBe('draft');
      assertValidProposalPayload('update_brand_voice', res.proposal.payload);
    });

    it('the gate is real, not decorative: bypassing it (as approveProposal used to allow) applies register and silently drops the pricing prohibition on execution — this is exactly the hazard the gate exists to prevent', async () => {
      const res = await new UpdateBrandVoiceTaskHandler(mixedGateway()).handle(ctx());
      expect(missingFieldsFor(res.proposal)).toEqual([FREE_TEXT_GATE_FIELD]);

      const repo = new InMemoryBrandVoiceRepository();
      const handler = new UpdateBrandVoiceExecutionHandler(repo, new InMemoryAuditRepository());
      // Simulating what execution would do if the (pre-fix) empty gate had
      // let this through — proves the payload really does silently lose the
      // pricing instruction, not merely that a gate field is set somewhere.
      const result = await handler.execute(
        { ...res.proposal, status: 'approved' },
        { tenantId: 't-1', executedBy: 'u-1' },
      );
      expect(result.success).toBe(true);
      const state = await repo.getState('t-1');
      expect(state.config.register).toBe('friendly');
      // The pricing prohibition has no home anywhere in the persisted state.
      expect(JSON.stringify(state.config)).not.toMatch(/price/i);
    });

    it('gate has a real unblock path: editProposal + clearSatisfiedMissingFields lift it ONLY when the exact `freeText` key is edited to a non-empty value; an unrelated edit does not clear it', async () => {
      const res = await new UpdateBrandVoiceTaskHandler(mixedGateway()).handle(ctx());
      expect(missingFieldsFor(res.proposal)).toEqual([FREE_TEXT_GATE_FIELD]);

      const proposalRepo = new InMemoryProposalRepository();
      await proposalRepo.create(res.proposal);

      // Editing an unrelated key must NOT clear the gate — clear-on-fill
      // only lifts the entry for the EXACT key edited (missing-fields.ts).
      const afterUnrelatedEdit = await editProposal(
        proposalRepo,
        't-1',
        res.proposal.id,
        'u-owner',
        'owner',
        { persona_name: 'Bob' },
      );
      expect(missingFieldsFor(afterUnrelatedEdit.proposal)).toEqual([FREE_TEXT_GATE_FIELD]);

      // Editing `freeText` itself — the operator has now seen the pricing
      // instruction and handled it (e.g. added a banned_phrases entry
      // separately, or is explicitly acknowledging it) — clears the gate.
      // `freeText` is a real flat key of `updateBrandVoicePayloadSchema`, so
      // editProposal's Zod re-validation of the merged payload accepts it.
      const afterFreeTextEdit = await editProposal(
        proposalRepo,
        't-1',
        res.proposal.id,
        'u-owner',
        'owner',
        { freeText: 'never quote prices by text — handled: added to banned_phrases' },
      );
      expect(missingFieldsFor(afterFreeTextEdit.proposal)).toEqual([]);
      assertValidProposalPayload('update_brand_voice', afterFreeTextEdit.proposal.payload);
    });
  });
});
