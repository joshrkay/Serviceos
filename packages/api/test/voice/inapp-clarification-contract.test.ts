/**
 * The in-app half of the `voice_clarification` fall-through.
 *
 * `intentToProposalType` (proposals/voice-intent-map.ts) DEFAULTS to
 * `voice_clarification` for any intent it does not map — and `lookup_*`
 * intents are deliberately unmapped (P11-001: they are read-only and answered
 * by the lookup-skill family, not by a proposal). On the phone path a lookup
 * intent short-circuits before ever reaching proposal creation. In-app it does
 * not: the short-circuit requires BOTH `ownerSession` and a wired
 * `ownerLookupResolver`, so with either absent the intent walks the normal
 * FSM route — intent_confirm → confirmed → create_proposal — carrying
 * `intent: 'lookup_catalog'`.
 *
 * That produced a `voice_clarification` whose payload was the raw
 * `{intent, entities, sessionId}` envelope, which
 * `voiceClarificationPayloadSchema` REJECTS (it requires `transcript` +
 * `reason`). Result: a malformed card in the operator's queue.
 *
 * The phone path already degraded these to a canonical clarification; this
 * suite pins that in-app now does too, via the same shared
 * `buildVoiceClarificationPayload`.
 */
import { describe, it, expect, vi } from 'vitest';
import { InAppVoiceAdapter } from '../../src/ai/agents/customer-calling/inapp-adapter';
import { VoiceSessionStore } from '../../src/ai/agents/customer-calling/voice-session-store';
import { InMemoryProposalRepository, type Proposal } from '../../src/proposals/proposal';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { InMemoryOnCallRepository } from '../../src/oncall/rotation';
import { validateProposalPayload } from '../../src/proposals/contracts';
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
async function mintViaInApp(intentType: string, entities: Record<string, unknown>) {
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
    // NO ownerLookupResolver — the condition under which a lookup intent
    // reaches proposal creation at all.
  });

  const { sessionId } = await adapter.startSession('tenant-x', 'user-x');
  const first = await adapter.handleInput(sessionId, 'how much is drain cleaning');
  if (first.state === 'intent_confirm') await adapter.handleInput(sessionId, 'yes');
  store.dispose();
  return { minted, auditRepo };
}

describe('in-app adapter — unmapped intents degrade to a CONTRACT-VALID clarification', () => {
  it('lookup_catalog persists a canonical voice_clarification, not the raw envelope', async () => {
    const { minted } = await mintViaInApp('lookup_catalog', { catalogQuery: 'drain cleaning' });

    expect(minted).toHaveLength(1);
    const proposal = minted[0]!;
    expect(proposal.proposalType).toBe('voice_clarification');

    // THE regression: this used to be {intent, entities, sessionId} and fail
    // validateProposalPayload outright.
    const validation = validateProposalPayload(proposal.proposalType, proposal.payload);
    expect(validation.errors ?? []).toEqual([]);
    expect(validation.valid).toBe(true);
    assertVoiceProposalPayloadValid(proposal);

    // The canonical shape: the schema's two required keys, plus the operator's
    // context for what was actually asked.
    expect(typeof proposal.payload.transcript).toBe('string');
    expect(proposal.payload.reason).toBe('unknown_intent');
    expect(proposal.payload.suggestedIntents).toEqual(['lookup_catalog']);
    // The raw envelope keys are gone — that shape is what the executor chokes on.
    expect(proposal.payload.intent).toBeUndefined();
    expect(proposal.payload.entities).toBeUndefined();
  });

  it('records the degrade in the audit trail so it is diagnosable', async () => {
    const { auditRepo } = await mintViaInApp('lookup_catalog', { catalogQuery: 'drain cleaning' });
    const events = await auditRepo.findRecentByTenant('tenant-x', { limit: 200 });
    const contractFailure = events.find((e) => e.eventType === 'voice.payload_contract_failed');
    expect(contractFailure).toBeDefined();
    expect(contractFailure?.metadata?.outcome).toBe('degraded_to_clarification');
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
