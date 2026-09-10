/**
 * The in-app half of the `voice_clarification` fall-through.
 *
 * `intentToProposalType` (proposals/voice-intent-map.ts) DEFAULTS to
 * `voice_clarification` for any intent it does not map. When such a request
 * DOES reach proposal creation, the payload must be the canonical
 * clarification shape — the raw `{intent, entities, sessionId}` envelope is
 * REJECTED by `voiceClarificationPayloadSchema` (which requires `transcript`
 * + `reason`) and lands in the operator's queue as a malformed card. The
 * phone path degraded these correctly; in-app now does too, via the same
 * shared `buildVoiceClarificationPayload`.
 *
 * WHAT CHANGED (2026-09, in-app 50-case sweep, cluster "search")
 * -------------------------------------------------------------
 * `lookup_*` used to be the example of that fall-through: the in-app
 * short-circuit required BOTH an `ownerSession` and a wired
 * `ownerLookupResolver`, so with either absent a lookup walked the FSM —
 * intent_confirm → confirmed → create_proposal — and the operator's "yes"
 * minted a card nobody could action.
 *
 * Lookups no longer reach proposal creation on ANY surface: every
 * `lookup_*` at confidence >= TAU_INT is answered out-of-FSM through the
 * shared dispatch (`ai/voice-turn/inapp-lookup-surface.ts`), and a
 * deployment with no lookups bundle speaks an honest unavailable line rather
 * than minting a card. So the lookup case below pins the ABSENCE of a
 * proposal, and the canonical-payload contract is pinned where the in-app
 * degrade is still reachable: the `respond_to_review` capability gate (A46),
 * which builds its clarification from the same shared module.
 */
import { describe, it, expect, vi } from 'vitest';
import { InAppVoiceAdapter } from '../../src/ai/agents/customer-calling/inapp-adapter';
import { VoiceSessionStore } from '../../src/ai/agents/customer-calling/voice-session-store';
import { InMemoryProposalRepository, type Proposal } from '../../src/proposals/proposal';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { InMemoryOnCallRepository } from '../../src/oncall/rotation';
import { validateProposalPayload } from '../../src/proposals/contracts';
import { LOOKUP_UNAVAILABLE_LINE } from '../../src/workers/voice-lookup-answer';
import type { LLMGateway, LLMResponse } from '../../src/ai/gateway/gateway';
import { assertVoiceProposalPayloadValid } from './helpers/voice-proposal-contract';

function scriptedGateway(response: string): LLMGateway {
  return {
    complete: vi.fn(async () => ({
      content: response,
      model: 'mock',
      provider: 'mock',
      tokenUsage: { input: 1, output: 1, total: 2 },
      latencyMs: 1,
    } satisfies LLMResponse)),
  } as unknown as LLMGateway;
}

/** Drive an in-app session to proposal creation, returning what it minted. */
async function mintViaInApp(
  intentType: string,
  entities: Record<string, unknown>,
  utterance = 'how much is drain cleaning',
) {
  const store = new VoiceSessionStore({ startInterval: false });
  const proposalRepo = new InMemoryProposalRepository();
  const auditRepo = new InMemoryAuditRepository();
  const minted: Proposal[] = [];
  const originalCreate = proposalRepo.create.bind(proposalRepo);
  proposalRepo.create = async (proposal: Proposal) => {
    minted.push(proposal);
    return originalCreate(proposal);
  };

  const adapter = new InAppVoiceAdapter({
    store,
    gateway: scriptedGateway(
      JSON.stringify({ intentType, confidence: 0.95, extractedEntities: entities }),
    ),
    proposalRepo,
    auditRepo,
    onCallRepo: new InMemoryOnCallRepository(),
    // NO `lookups` bundle and NO respondToReviewTaskHandler — the two
    // "capability not wired here" conditions each case below exercises.
  });

  const { sessionId } = await adapter.startSession('tenant-x', 'user-x');
  const first = await adapter.handleInput(sessionId, utterance);
  const second =
    first.state === 'intent_confirm' ? await adapter.handleInput(sessionId, 'yes') : undefined;
  store.dispose();
  return { minted, auditRepo, first, second };
}

describe('in-app adapter — a lookup never reaches proposal creation at all', () => {
  it('lookup_catalog is answered out-of-FSM: no card, malformed or otherwise', async () => {
    const { minted, first } = await mintViaInApp('lookup_catalog', {
      catalogQuery: 'drain cleaning',
    });

    // THE regression this file was opened for: this used to mint a
    // clarification card (and before that, a malformed one).
    expect(minted).toHaveLength(0);
    // The turn is answered honestly instead — no bundle is wired here, so
    // the operator is told the lookup is unavailable rather than being
    // handed a card that claims work nobody can action.
    expect(first.ttsText).toBe(LOOKUP_UNAVAILABLE_LINE);
    // And the FSM never advanced, so the next utterance is a fresh request.
    expect(first.state).toBe('intent_capture');
  });

  it('records no contract-failure degrade for a lookup — nothing was built to fail', async () => {
    const { auditRepo } = await mintViaInApp('lookup_catalog', { catalogQuery: 'drain cleaning' });
    const events = await auditRepo.findRecentByTenant('tenant-x', { limit: 200 });
    expect(events.find((e) => e.eventType === 'voice.payload_contract_failed')).toBeUndefined();
  });
});

describe('in-app adapter — a gated capability degrades to a CONTRACT-VALID clarification', () => {
  it('respond_to_review with no drafting handler persists the canonical shape', async () => {
    const { minted } = await mintViaInApp(
      'respond_to_review',
      { reviewReference: 'the one-star Google review' },
      'reply to that one-star Google review',
    );

    expect(minted).toHaveLength(1);
    const proposal = minted[0]!;
    expect(proposal.proposalType).toBe('voice_clarification');

    // THE regression class: a raw {intent, entities, sessionId} envelope
    // fails validateProposalPayload outright and cannot be actioned.
    const validation = validateProposalPayload(proposal.proposalType, proposal.payload);
    expect(validation.errors ?? []).toEqual([]);
    expect(validation.valid).toBe(true);
    assertVoiceProposalPayloadValid(proposal);

    // The canonical shape: the schema's two required keys, plus the
    // operator's context for what was actually asked.
    expect(typeof proposal.payload.transcript).toBe('string');
    expect(proposal.payload.reason).toBe('missing_entities');
    expect(proposal.payload.suggestedIntents).toEqual(['respond_to_review']);
    // The raw envelope keys are gone — that shape is what the executor chokes on.
    expect(proposal.payload.intent).toBeUndefined();
    expect(proposal.payload.entities).toBeUndefined();
  });

  it('does NOT degrade a real proposal type — the operator keeps an editable draft', async () => {
    // draft_estimate with an unresolved customer still fails its contract
    // in-app (a known, separately-tracked gap). It must stay a draft_estimate
    // the operator can complete, NOT collapse into a clarification.
    const { minted } = await mintViaInApp('draft_estimate', { customerName: 'Jane Smith' });
    expect(minted).toHaveLength(1);
    expect(minted[0]!.proposalType).toBe('draft_estimate');
    expect(minted[0]!.payload.entities).toBeDefined();
  });
});
