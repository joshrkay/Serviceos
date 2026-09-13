/**
 * Sweep rows C03 / C05 / C07 — the three telephony-only dialogue behaviors
 * the in-app voice surface had no equivalent of.
 *
 * THE BUG THESE PIN. Live evidence, sweep 2026-08-29 (results file
 * `sweep-2026-08-29T23-20-24-666Z.json`): "Approve it", "Change the amount to
 * 300" and "Can we talk in Spanish?" each classified correctly, then fell
 * through `intentToProposalType`'s default to a `voice_clarification` card,
 * and the FSM's closing state answered:
 *
 *   "Great, I've got that taken care of. You'll receive a confirmation
 *    shortly. Is there anything else I can help you with?"
 *
 * Nothing was approved, no amount changed, no language switched. All three
 * rows scored DEGRADED because a `proposalId` was present on a turn whose
 * expected outcome was a refusal / clarification.
 *
 * The tests below reproduce the LIVE sequence exactly — the sweep sends the
 * utterance and then auto-sends a follow-up "Yes, that's correct." (see
 * `run-sweep.mjs`), and it was that second turn that minted the card and
 * spoke the closing line. A test that sent only the first turn would have
 * passed against the broken code.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { InAppVoiceAdapter } from '../../../../src/ai/agents/customer-calling/inapp-adapter';
import { VoiceSessionStore } from '../../../../src/ai/agents/customer-calling/voice-session-store';
import { InMemoryProposalRepository } from '../../../../src/proposals/proposal';
import { InMemoryAuditRepository } from '../../../../src/audit/audit';
import { InMemoryOnCallRepository } from '../../../../src/oncall/rotation';
import { CONFIRM_NOTHING_PENDING_LINE } from '../../../../src/ai/agents/customer-calling/transitions';
import {
  LANGUAGE_SWITCH_ACK,
  LANGUAGE_SWITCH_CAP_LINE,
  LANGUAGE_UNSUPPORTED_LINE,
  VOICE_APPROVAL_REFUSAL,
} from '../../../../src/ai/agents/customer-calling/tts-copy';
import type { LLMGateway, LLMResponse } from '../../../../src/ai/gateway/gateway';

const TENANT = 'tenant-x';
const USER = 'user-x';

/**
 * The exact sentence the closing state spoke on all three broken rows. Any
 * appearance of it on these turns is the regression.
 */
const GENERIC_CLOSING_LINE =
  "Great, I've got that taken care of. You'll receive a confirmation shortly. Is there anything else I can help you with?";

/** The sweep's auto-sent second turn. */
const SWEEP_FOLLOW_UP = "Yes, that's correct.";

function classifierJson(
  intentType: string,
  confidence = 0.95,
  extractedEntities: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    intentType,
    confidence,
    reasoning: 'handler-level test classifier',
    extractedEntities,
  });
}

/** Returns each scripted classifier reply in order, repeating the last. */
function scriptedGateway(responses: string[]): LLMGateway {
  let i = 0;
  return {
    complete: vi.fn(async () => {
      const content = responses[Math.min(i++, responses.length - 1)];
      return {
        content,
        model: 'mock',
        provider: 'mock',
        tokenUsage: { input: 1, output: 1, total: 2 },
        latencyMs: 1,
      } satisfies LLMResponse;
    }),
  } as unknown as LLMGateway;
}

describe('InAppVoiceAdapter — telephony-parity dialogue acts (sweep C03/C05/C07)', () => {
  let store: VoiceSessionStore;
  let proposalRepo: InMemoryProposalRepository;
  let auditRepo: InMemoryAuditRepository;
  let onCallRepo: InMemoryOnCallRepository;

  beforeEach(() => {
    store = new VoiceSessionStore({ startInterval: false });
    proposalRepo = new InMemoryProposalRepository();
    auditRepo = new InMemoryAuditRepository();
    onCallRepo = new InMemoryOnCallRepository();
  });

  afterEach(() => {
    store.dispose();
  });

  function buildAdapter(
    responses: string[],
    extra: Partial<ConstructorParameters<typeof InAppVoiceAdapter>[0]> = {},
  ): InAppVoiceAdapter {
    return new InAppVoiceAdapter({
      store,
      gateway: scriptedGateway(responses),
      proposalRepo,
      auditRepo,
      onCallRepo,
      ...extra,
    });
  }

  // ── C03 approve_proposal / C05 edit_proposal ───────────────────────────
  //
  // RV-071 / RV-225 + D-025: voice approval is scoped to a
  // transport-identified owner LINE. In-app is an authenticated app already
  // showing a tap-to-approve card, so the honest answer points at the card.

  describe.each([
    { row: 'C03', utterance: 'Approve it', intent: 'approve_proposal' },
    { row: 'C05', utterance: 'Change the amount to 300', intent: 'edit_proposal' },
  ])('$row $intent — refuses by voice and points at the card', ({ utterance, intent }) => {
    it('refuses on the first turn without minting a proposal', async () => {
      const adapter = buildAdapter([classifierJson(intent)]);
      const { sessionId, state } = await adapter.startSession(TENANT, USER);
      expect(state).toBe('intent_capture');

      const result = await adapter.handleInput(sessionId, utterance);

      expect(result.ttsText).toBe(VOICE_APPROVAL_REFUSAL);
      expect(result.proposalIds).toEqual([]);
      expect(await proposalRepo.findByTenant(TENANT)).toHaveLength(0);
      // The turn is an ADAPTER act: the FSM never advances, so the operator
      // can simply say what they want next.
      expect(result.state).toBe('intent_capture');
      expect(result.ended).toBe(false);
    });

    it('records the denied attempt as agent.calling.voice_approval_denied / inapp_surface', async () => {
      const adapter = buildAdapter([classifierJson(intent)]);
      const { sessionId } = await adapter.startSession(TENANT, USER);

      await adapter.handleInput(sessionId, utterance);

      const denial = auditRepo
        .getAll()
        .find((e) => e.eventType === 'agent.calling.voice_approval_denied');
      expect(denial).toBeDefined();
      expect(denial!.entityType).toBe('voice_session');
      expect(denial!.entityId).toBe(sessionId);
      // `inapp_surface`, NOT `not_owner_session`: the refusal is about the
      // surface, not about who is speaking. An in-app owner is refused too.
      expect(denial!.metadata).toMatchObject({ reason: 'inapp_surface', intentType: intent });
    });

    it('refuses an OWNER session too — the gate is the surface, not the role', async () => {
      const adapter = buildAdapter([classifierJson(intent)]);
      // role 'owner' sets ownerSession:true, the same flag the telephony
      // path treats as authorisation to approve. In-app still refuses.
      const { sessionId } = await adapter.startSession(TENANT, USER, undefined, 'owner');

      const result = await adapter.handleInput(sessionId, utterance);

      expect(result.ttsText).toBe(VOICE_APPROVAL_REFUSAL);
      expect(result.proposalIds).toEqual([]);
      const denial = auditRepo
        .getAll()
        .find((e) => e.eventType === 'agent.calling.voice_approval_denied');
      expect(denial!.metadata).toMatchObject({ reason: 'inapp_surface' });
    });

    it('never reaches the closing line — including on the sweep follow-up turn', async () => {
      // Turn 1 classifies the approve/edit ask; turn 2 is the sweep's
      // auto-sent "Yes, that's correct.", which is what previously minted
      // the voice_clarification card and spoke the closing line.
      const adapter = buildAdapter([classifierJson(intent), classifierJson('confirm')]);
      const { sessionId } = await adapter.startSession(TENANT, USER);

      const first = await adapter.handleInput(sessionId, utterance);
      const second = await adapter.handleInput(sessionId, SWEEP_FOLLOW_UP);

      expect(first.ttsText).toBe(VOICE_APPROVAL_REFUSAL);
      // A bare "yes" with nothing pending gets the FSM's honest re-prompt,
      // never a card and never a completion claim.
      expect(second.ttsText).toBe(CONFIRM_NOTHING_PENDING_LINE);
      for (const turn of [first, second]) {
        expect(turn.ttsText).not.toBe(GENERIC_CLOSING_LINE);
        expect(turn.ttsText).not.toMatch(/taken care of/i);
        expect(turn.proposalIds).toEqual([]);
      }
      expect(await proposalRepo.findByTenant(TENANT)).toHaveLength(0);
    });
  });

  // ── C07 language_switch ────────────────────────────────────────────────
  //
  // This one WORKS rather than refusing: the in-app session renders every
  // spoken line through renderTtsText(..., session.language), so honoring an
  // explicit switch is the same capability the sticky detector already
  // provides — reachable by asking.

  describe('C07 language_switch — actually switches the session language', () => {
    it('flips session.language to es and acknowledges in Spanish', async () => {
      const adapter = buildAdapter([classifierJson('language_switch')]);
      const { sessionId } = await adapter.startSession(TENANT, USER);
      expect(store.peek(sessionId)?.language).toBeUndefined();

      const result = await adapter.handleInput(sessionId, 'Can we talk in Spanish?');

      expect(store.peek(sessionId)?.language).toBe('es');
      expect(result.ttsText).toBe(LANGUAGE_SWITCH_ACK.es);
      // A conversational act, not work: no card, and the FSM stays put.
      expect(result.proposalIds).toEqual([]);
      expect(await proposalRepo.findByTenant(TENANT)).toHaveLength(0);
      expect(result.state).toBe('intent_capture');
      expect(result.ttsText).not.toBe(GENERIC_CLOSING_LINE);
    });

    it('emits a language_switched quality event with the switch count', async () => {
      const adapter = buildAdapter([classifierJson('language_switch')]);
      const { sessionId } = await adapter.startSession(TENANT, USER);
      const events: Array<Record<string, unknown>> = [];
      store.peek(sessionId)!.events.on('voice-event', (e) => events.push(e));

      await adapter.handleInput(sessionId, 'Can we talk in Spanish?');

      expect(events).toContainEqual(
        expect.objectContaining({
          type: 'language_switched',
          from: 'en',
          to: 'es',
          trigger: 'classified_intent',
          switchCount: 1,
        }),
      );
    });

    it('switches BACK to English — the sticky detector alone is one-way', async () => {
      const adapter = buildAdapter([
        classifierJson('language_switch'),
        classifierJson('language_switch'),
      ]);
      const { sessionId } = await adapter.startSession(TENANT, USER);

      await adapter.handleInput(sessionId, 'Can we talk in Spanish?');
      expect(store.peek(sessionId)?.language).toBe('es');

      const back = await adapter.handleInput(sessionId, 'English please');

      expect(store.peek(sessionId)?.language).toBe('en');
      expect(back.ttsText).toBe(LANGUAGE_SWITCH_ACK.en);
      expect(store.peek(sessionId)?.languageSwitchCount).toBe(2);
    });

    it('refuses honestly when the tenant has not opted into the language', async () => {
      const adapter = buildAdapter([classifierJson('language_switch')], {
        supportedLanguagesResolver: async () => ['en'],
      });
      const { sessionId } = await adapter.startSession(TENANT, USER);

      const result = await adapter.handleInput(sessionId, 'Can we talk in Spanish?');

      // Says it cannot, and does NOT pretend it switched.
      expect(result.ttsText).toBe(LANGUAGE_UNSUPPORTED_LINE.en);
      expect(store.peek(sessionId)?.language).toBe('en');
      expect(result.proposalIds).toEqual([]);
    });

    it('holds the line once the per-session flap cap is spent', async () => {
      const adapter = buildAdapter([classifierJson('language_switch')]);
      const { sessionId } = await adapter.startSession(TENANT, USER);
      store.peek(sessionId)!.languageSwitchCount = 2; // MAX_LANGUAGE_SWITCHES_PER_CALL

      const result = await adapter.handleInput(sessionId, 'Can we talk in Spanish?');

      expect(result.ttsText).toBe(LANGUAGE_SWITCH_CAP_LINE.en);
      expect(store.peek(sessionId)?.language).toBe('en');
      expect(store.peek(sessionId)?.languageSwitchCount).toBe(2);
    });

    it('acknowledges without spending the budget when already in that language', async () => {
      const adapter = buildAdapter([classifierJson('language_switch')]);
      const { sessionId } = await adapter.startSession(TENANT, USER);
      // 'hablo español' trips the sticky detector first (accented char), so
      // the session is ALREADY es by the time the switch act runs.
      const result = await adapter.handleInput(sessionId, 'hablo español');

      expect(store.peek(sessionId)?.language).toBe('es');
      expect(result.ttsText).toBe(LANGUAGE_SWITCH_ACK.es);
      expect(store.peek(sessionId)?.languageSwitchCount ?? 0).toBe(0);
    });

    it('never reaches the closing line — including on the sweep follow-up turn', async () => {
      const adapter = buildAdapter([
        classifierJson('language_switch'),
        classifierJson('confirm'),
      ]);
      const { sessionId } = await adapter.startSession(TENANT, USER);

      const first = await adapter.handleInput(sessionId, 'Can we talk in Spanish?');
      const second = await adapter.handleInput(sessionId, SWEEP_FOLLOW_UP);

      expect(first.ttsText).toBe(LANGUAGE_SWITCH_ACK.es);
      for (const turn of [first, second]) {
        expect(turn.ttsText).not.toBe(GENERIC_CLOSING_LINE);
        expect(turn.ttsText).not.toMatch(/taken care of/i);
        expect(turn.proposalIds).toEqual([]);
      }
      expect(await proposalRepo.findByTenant(TENANT)).toHaveLength(0);
    });
  });

  // ── Guards on the change itself ────────────────────────────────────────

  describe('scope of the interception', () => {
    it('leaves ordinary mutation intents on the FSM path', async () => {
      // Negative control: the adapter-act branch must not swallow real work.
      const adapter = buildAdapter([
        classifierJson('create_appointment', 0.95, { customerName: 'Alice' }),
      ]);
      const { sessionId } = await adapter.startSession(TENANT, USER);

      const result = await adapter.handleInput(sessionId, 'Book Alice for Thursday at two');

      // The FSM advanced (readback / resolution), rather than being
      // short-circuited by an adapter act.
      expect(result.state).not.toBe('intent_capture');
      expect(result.ttsText).toBeTruthy();
    });

    it('leaves a below-threshold approve to the FSM reprompt, minting nothing', async () => {
      // Under TAU_INT (0.75) we do not claim to know what was asked — so no
      // refusal copy, and still no card.
      const adapter = buildAdapter([classifierJson('approve_proposal', 0.4)]);
      const { sessionId } = await adapter.startSession(TENANT, USER);

      const result = await adapter.handleInput(sessionId, 'Approve it');

      expect(result.ttsText).not.toBe(VOICE_APPROVAL_REFUSAL);
      expect(result.ttsText).not.toMatch(/taken care of/i);
      expect(result.proposalIds).toEqual([]);
      expect(
        auditRepo.getAll().find((e) => e.eventType === 'agent.calling.voice_approval_denied'),
      ).toBeUndefined();
    });
  });
});
