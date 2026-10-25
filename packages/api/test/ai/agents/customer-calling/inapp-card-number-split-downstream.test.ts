/**
 * PRIV-3 follow-up — in-app: the turn that completes a card number the
 * operator split across turns reads on as the marker.
 *
 * `InAppVoiceAdapter._handleInputLocked` appends through
 * `VoiceSessionStore.appendTranscript`, which rewrites the transcript when a
 * turn completes a card split across turns, but the turn then went on with
 * its own text: the completing "1111" went to the classifier (the provider
 * payload, ai_runs, the trace export) and the FSM, and the FSM context's
 * `lastUtterance` kept the first turn's fragment, which the yes put in the
 * drafted note's body. Real LLMGateway, stubbed provider.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { InAppVoiceAdapter } from '../../../../src/ai/agents/customer-calling/inapp-adapter';
import { VoiceSessionStore } from '../../../../src/ai/agents/customer-calling/voice-session-store';
import { InMemoryProposalRepository } from '../../../../src/proposals/proposal';
import { InMemoryAuditRepository } from '../../../../src/audit/audit';
import { InMemoryOnCallRepository } from '../../../../src/oncall/rotation';
import {
  LLMGateway,
  type LLMProvider,
  type LLMRequest,
  type LLMResponse,
} from '../../../../src/ai/gateway/gateway';
import type { EntityResolver } from '../../../../src/ai/resolution/entity-resolver';

const TENANT = 'tenant-pan-inapp';
const OPERATOR = 'user-operator-pan';
const CUSTOMER_ID = '5b1e3c1e-8d7a-4f0e-9a39-1c2d3e4f5a6b';
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/**
 * True when `text` holds a group of the card's digits: its first part
 * ("4111 1111 ...") or a later "1111" on its own. Ids are set aside first (a
 * random uuid holds "1111" often enough to fail a suite), and a digit, not a
 * word boundary, bounds the "1111": in JSON a newline before it is "\\n1111".
 */
function holdsCardFragment(text: string): boolean {
  return /4111\D{0,3}1111|(?<!\d)1111(?!\d)/.test(text.replace(UUID, '<id>'));
}

function lastUserText(req: LLMRequest): string {
  const users = (req.messages ?? []).filter((m) => m.role === 'user');
  return String(users[users.length - 1]?.content ?? '');
}

/** `noteBody`: what the classifier takes as the note's body (the readback renders it). */
function stubProvider(noteBody?: string) {
  const requests: LLMRequest[] = [];
  const provider: LLMProvider = {
    name: 'stub',
    isAvailable: async () => true,
    complete: async (req: LLMRequest): Promise<LLMResponse> => {
      requests.push(req);
      const said = lastUserText(req);
      const reply = /add a note/i.test(said)
        ? {
            intentType: 'add_note',
            confidence: 0.95,
            reasoning: 'note',
            extractedEntities: { customerName: 'Priya Patel', noteTargetKind: 'customer', ...(noteBody ? { noteBody } : {}) },
          }
        : /\byes\b/i.test(said)
          ? { intentType: 'confirm', confidence: 0.95, reasoning: 'yes', extractedEntities: {} }
          : { intentType: 'unknown', confidence: 0.2, reasoning: 'unclear', extractedEntities: {} };
      return {
        content: JSON.stringify(reply),
        model: 'gpt-4o-mini',
        provider: 'openai',
        tokenUsage: { input: 1, output: 1, total: 2 },
        latencyMs: 1,
      };
    },
  };
  return { requests, gateway: new LLMGateway({ defaultProvider: 'stub' }, new Map([['stub', provider]])) };
}

const resolvesPatel: EntityResolver = {
  resolve: async () => ({
    kind: 'resolved' as const,
    candidate: { id: CUSTOMER_ID, kind: 'customer' as const, label: 'Priya Patel', score: 0.97 },
  }),
};

const stores: VoiceSessionStore[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) s.dispose();
});

async function inAppCall(noteBody?: string) {
  const store = new VoiceSessionStore({ startInterval: false });
  stores.push(store);
  const proposalRepo = new InMemoryProposalRepository();
  const auditRepo = new InMemoryAuditRepository();
  const { requests, gateway } = stubProvider(noteBody);
  const adapter = new InAppVoiceAdapter({
    store,
    gateway,
    proposalRepo,
    auditRepo,
    onCallRepo: new InMemoryOnCallRepository(new Map()),
    entityResolver: resolvesPatel,
  });
  const { sessionId } = await adapter.startSession(TENANT, OPERATOR);
  return { adapter, sessionId, session: store.get(sessionId)!, requests, proposalRepo, auditRepo };
}

describe('PRIV-3 — in-app: the turn that completes a split card reads on as the marker', () => {
  it("handleInput: the completing turn's provider request, the FSM context and the drafted note carry the marker", async () => {
    const h = await inAppCall();
    await h.adapter.handleInput(h.sessionId, 'the card on file is 4111 1111 1111');
    const sentBefore = h.requests.length;
    await h.adapter.handleInput(h.sessionId, '1111, add a note for Priya Patel with it');
    const completing = h.requests.slice(sentBefore);
    expect(completing.length).toBeGreaterThan(0);
    for (const req of completing) {
      expect(lastUserText(req)).toContain('[card number], add a note');
      expect(holdsCardFragment(JSON.stringify(req.messages))).toBe(false);
    }
    expect(h.session.machine.currentContext.lastUtterance).toBe('[card number], add a note for Priya Patel with it');
    expect(holdsCardFragment(JSON.stringify(h.session.machine.currentContext))).toBe(false);

    await h.adapter.handleInput(h.sessionId, 'yes');
    const proposals = await h.proposalRepo.findByTenant(TENANT);
    expect(proposals).toHaveLength(1);
    expect(proposals[0].proposalType).toBe('add_note');
    expect((proposals[0].payload as { body?: string }).body).toBe('[card number], add a note for Priya Patel with it');
    expect(holdsCardFragment(JSON.stringify(proposals))).toBe(false);
    expect(holdsCardFragment(JSON.stringify(h.session.transcript))).toBe(false);
  });

  // The readback renders the body the classifier took from the first turn,
  // card digits and all: once the next turn completes the card, the agent's
  // line and the line kept to answer a repeated turn are rewritten too.
  it("handleInput: the agent's readback of the card's first part is rewritten when the next turn completes it", async () => {
    const h = await inAppCall('her card on file is 4111 1111 1111');
    await h.adapter.handleInput(h.sessionId, 'Add a note for Priya Patel, her card on file is 4111 1111 1111');
    expect(h.session.machine.currentState).toBe('intent_confirm');
    const readback = h.session.transcript.length - 1;
    expect(h.session.transcript[readback]).toMatch(/^agent: .*4111 1111 1111/);

    await h.adapter.handleInput(h.sessionId, '1111, yes');
    expect(h.session.transcript[readback]).toMatch(/^agent: .*\[card number\]/);
    expect(holdsCardFragment(JSON.stringify(h.session.transcript))).toBe(false);
    expect(holdsCardFragment(JSON.stringify(h.session.lastOperatorTurn ?? null))).toBe(false);
    expect(holdsCardFragment(JSON.stringify(h.session.machine.currentContext))).toBe(false);
    expect(holdsCardFragment(JSON.stringify(await h.proposalRepo.findByTenant(TENANT)))).toBe(false);
  });

  it('handleInput: a card completed at the readback leaves no fragment in the correction audit or the FSM context', async () => {
    const h = await inAppCall();
    await h.adapter.handleInput(h.sessionId, 'Add a note for Priya Patel, her card on file is 4111 1111 1111');
    expect(h.session.machine.currentState).toBe('intent_confirm');
    expect(h.session.machine.currentContext.lastUtterance).toContain('4111 1111 1111');

    const turn = await h.adapter.handleInput(h.sessionId, '1111');
    // The readback's "no" path: the correction is audited with the words it
    // was read as.
    expect(JSON.stringify(turn.sideEffects)).toContain('[card number]');
    expect(holdsCardFragment(JSON.stringify(turn.sideEffects))).toBe(false);
    expect(h.session.machine.currentContext.lastUtterance).toBe(
      'Add a note for Priya Patel, her card on file is [card number]',
    );
    expect(holdsCardFragment(JSON.stringify(h.session.machine.currentContext))).toBe(false);
    // The audit row the correction wrote (the first turn's own rows were
    // written before anything could tell its digits were part of a card).
    const corrections = h.auditRepo.getAll().filter((e) => e.eventType.endsWith('.correction'));
    expect(corrections).toHaveLength(1);
    expect(holdsCardFragment(JSON.stringify(corrections))).toBe(false);
    expect(holdsCardFragment(JSON.stringify(h.session.transcript))).toBe(false);
  });
});
