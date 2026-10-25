/**
 * PRIV-3 follow-up — a card number split across caller turns, past the
 * transcript.
 *
 * `VoiceSessionStore.appendTranscript` rewrites the transcript and the stored
 * rows when a caller turn completes a card number the caller split across
 * turns ("add a note for Dana Reyes, the card on file is 4111 1111 1111",
 * then "1111"). Each part alone is under 13 digits, so the per-turn scrub
 * passes it, and the turn then went on with the text it had BEFORE the
 * append: the completing "1111" went to confirm_intent / classify_intent
 * (the provider payload, ai_runs, the trace export), the FSM events, the
 * safety scan and the task handlers, and the FSM context's `lastUtterance`
 * kept the earlier fragment, which the yes then put in the drafted
 * proposal (an add_note's body is the spoken request).
 *
 * Driven through each transport's entry point with the REAL LLMGateway (only
 * the provider is stubbed, so what reaches the provider is what the gateway
 * dispatches): Gather (`handleGather`), Media Streams (the shipped
 * `speechTurn` dep, `processCallerUtterance`, and the stream adapter's own
 * post-turn reads) and in-app (`InAppVoiceAdapter.handleInput`).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TwilioGatherAdapter } from '../../src/telephony/twilio-adapter';
import { VoiceSessionStore } from '../../src/ai/agents/customer-calling/voice-session-store';
import { LLMGateway, type LLMProvider, type LLMRequest, type LLMResponse } from '../../src/ai/gateway/gateway';
import { InMemoryProposalRepository } from '../../src/proposals/proposal';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { InMemoryCustomerRepository, createCustomer } from '../../src/customers/customer';
import { InMemoryCallTranscriptTurnRepository } from '../../src/voice/call-transcript-turn';

const TENANT = 'tenant-pan-downstream';
const CALLER_ID = '+15125550100';

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

const ADD_NOTE = JSON.stringify({
  intentType: 'add_note',
  confidence: 0.95,
  extractedEntities: { customerName: 'Dana Reyes', noteTargetKind: 'customer' },
});
/** The classifier takes the note's body from the request, card digits and all: the readback renders it. */
const ADD_NOTE_WITH_BODY = JSON.stringify({
  intentType: 'add_note',
  confidence: 0.95,
  extractedEntities: {
    customerName: 'Dana Reyes',
    noteTargetKind: 'customer',
    noteBody: 'the card on file is 4111 1111 1111',
  },
});
const UNCLEAR = JSON.stringify({ intentType: 'unknown', confidence: 0.2, extractedEntities: {} });

/** The caller's words in a request, as the stub provider saw them. */
function lastUserText(req: LLMRequest): string {
  const users = (req.messages ?? []).filter((m) => m.role === 'user');
  return String(users[users.length - 1]?.content ?? '');
}

/**
 * The provider: confirm_intent answers yes only to "Yes, that's right"; the
 * classifier drafts a note when asked to add one.
 */
function stubProvider(addNote = ADD_NOTE) {
  const requests: LLMRequest[] = [];
  const provider: LLMProvider = {
    name: 'stub',
    isAvailable: async () => true,
    complete: async (req: LLMRequest): Promise<LLMResponse> => {
      requests.push(req);
      const isConfirm = (req.metadata as { skill?: string } | undefined)?.skill === 'confirm_intent';
      const said = lastUserText(req);
      return {
        content: isConfirm
          ? JSON.stringify({ answer: /Yes, that's right/.test(said) ? 'yes' : 'no', reasoning: 'scripted' })
          : /add a note/i.test(said)
            ? addNote
            : UNCLEAR,
        model: 'gpt-4o-mini',
        provider: 'openai',
        tokenUsage: { input: 1, output: 1, total: 2 },
        latencyMs: 1,
      };
    },
  };
  return { requests, gateway: new LLMGateway({ defaultProvider: 'stub' }, new Map([['stub', provider]])) };
}

const stores: VoiceSessionStore[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) s.dispose();
});

async function ownerPhoneCall(
  callSid: string,
  opts: { addNote?: string; turnRepo?: InMemoryCallTranscriptTurnRepository } = {},
) {
  const { requests, gateway } = stubProvider(opts.addNote);
  const recordTurn = vi.fn(async () => undefined);
  const redactCardNumberTurns = vi.fn(async (input: { turns: unknown[] }) => input.turns.length);
  const store = new VoiceSessionStore({
    startInterval: false,
    callTranscriptTurnRepo: opts.turnRepo ?? ({ recordTurn, redactCardNumberTurns } as never),
  });
  stores.push(store);
  const proposalRepo = new InMemoryProposalRepository();
  const customerRepo = new InMemoryCustomerRepository();
  const customer = await createCustomer(
    { tenantId: TENANT, firstName: 'Dana', lastName: 'Reyes', primaryPhone: '+14805550199', createdBy: 'test' },
    customerRepo,
  );
  const session = store.create(TENANT, 'telephony', { callSid, ownerSession: true });
  session.machine.dispatch({ type: 'incoming_call', callSid, from: CALLER_ID, to: '+15125550999', tenantId: TENANT });
  session.machine.dispatch({ type: 'greeted_ok' });
  session.machine.dispatch({ type: 'caller_known', customerId: customer.id });
  session.customerId = customer.id;
  session.callerPhone = CALLER_ID;
  session.actorUserId = `owner:${TENANT}`;
  const adapter = new TwilioGatherAdapter({
    store,
    gateway,
    businessName: 'Acme Plumbing',
    publicBaseUrl: 'https://example.com',
    auditRepo: new InMemoryAuditRepository(),
    proposalRepo,
    customerRepo,
  });
  return { session, adapter, requests, proposalRepo, recordTurn };
}

/**
 * The call both phone transports are driven through: a note is asked for
 * with the card's first twelve digits in it, and the answer to the readback
 * reads the last four before the yes ("1111. Yes, that's right."): that turn
 * completes the card and drafts the note.
 */
async function expectSplitCardNeverLeavesTheTurn(
  h: Awaited<ReturnType<typeof ownerPhoneCall>>,
  say: (speech: string) => Promise<unknown>,
): Promise<void> {
  const { session, requests, proposalRepo } = h;
  await say('add a note for Dana Reyes, the card on file is 4111 1111 1111');
  expect(session.machine.currentState).toBe('intent_confirm');
  // Before the card is complete, the fragment is all anyone can see.
  expect(session.machine.currentContext.lastUtterance).toContain('4111 1111 1111');

  const sentBefore = requests.length;
  await say("1111. Yes, that's right.");
  await session.cardRedactionWrites;
  // The completing turn read on as the marker: the confirm_intent request it
  // made carries it, not the last four.
  const completing = requests.slice(sentBefore);
  expect(completing.length).toBeGreaterThan(0);
  for (const req of completing) {
    expect(lastUserText(req)).toContain("[card number]. Yes, that's right.");
    expect(holdsCardFragment(JSON.stringify(req.messages))).toBe(false);
  }
  // The request the FSM parked from the first turn is the rewritten one,
  // and so is the note the yes drafted from it.
  expect(session.machine.currentContext.lastUtterance).toBe(
    'add a note for Dana Reyes, the card on file is [card number]',
  );
  expect(holdsCardFragment(JSON.stringify(session.machine.currentContext))).toBe(false);
  const proposals = await proposalRepo.findByTenant(TENANT);
  expect(proposals).toHaveLength(1);
  expect(proposals[0].proposalType).toBe('add_note');
  expect((proposals[0].payload as { body?: string }).body).toBe(
    'add a note for Dana Reyes, the card on file is [card number]',
  );
  expect(holdsCardFragment(JSON.stringify(proposals))).toBe(false);
  expect(holdsCardFragment(JSON.stringify(session.transcript))).toBe(false);
}

/**
 * The readback renders the body the classifier took from the first turn ("…
 * the card on file is 4111 1111 1111. Is that right?"), so once the next turn
 * completes the card the agent's line holds its first twelve digits too: in
 * the transcript every later prompt (summary, escalation, history) is built
 * from, and in its stored row. Both are rewritten with the caller's turns.
 */
async function expectReadbackRewritten(
  h: Awaited<ReturnType<typeof ownerPhoneCall>>,
  turnRepo: InMemoryCallTranscriptTurnRepository,
  callSid: string,
  say: (speech: string) => Promise<unknown>,
): Promise<void> {
  const { session, proposalRepo } = h;
  await say('add a note for Dana Reyes, the card on file is 4111 1111 1111');
  expect(session.machine.currentState).toBe('intent_confirm');
  const readback = session.transcript.length - 1;
  expect(session.transcript[readback]).toMatch(/^agent: .*the card on file is 4111 1111 1111/);

  await say("1111. Yes, that's right.");
  await session.cardRedactionWrites;
  expect(session.transcript[readback]).toMatch(/^agent: .*the card on file is \[card number\]/);
  expect(holdsCardFragment(JSON.stringify(session.transcript))).toBe(false);
  const rows = await turnRepo.listByCallSid(TENANT, callSid);
  expect(rows.map((r) => `${r.speaker}: ${r.text}`)).toEqual(session.transcript);
  expect(holdsCardFragment(JSON.stringify(rows.map((r) => r.text)))).toBe(false);
  expect(holdsCardFragment(JSON.stringify(session.machine.currentContext))).toBe(false);
  const proposals = await proposalRepo.findByTenant(TENANT);
  expect(proposals).toHaveLength(1);
  expect(holdsCardFragment(JSON.stringify(proposals))).toBe(false);
}

describe("PRIV-3 — the agent's readback of a part of a split card is rewritten with it", () => {
  it('Gather (handleGather): the transcript and the stored rows, the readback included', async () => {
    const callSid = 'CA-pan-readback-gather';
    const turnRepo = new InMemoryCallTranscriptTurnRepository();
    const h = await ownerPhoneCall(callSid, { addNote: ADD_NOTE_WITH_BODY, turnRepo });
    await expectReadbackRewritten(h, turnRepo, callSid, (speechResult) =>
      h.adapter.handleGather({ sessionId: h.session.id, callSid, speechResult, confidence: 0.95, tenantId: TENANT }),
    );
  });

  it('Media Streams (processCallerUtterance): the transcript and the stored rows, the readback included', async () => {
    const callSid = 'CA-pan-readback-ms';
    const turnRepo = new InMemoryCallTranscriptTurnRepository();
    const h = await ownerPhoneCall(callSid, { addNote: ADD_NOTE_WITH_BODY, turnRepo });
    await expectReadbackRewritten(h, turnRepo, callSid, (speechResult) =>
      h.adapter.processCallerUtterance({ sessionId: h.session.id, callSid, speechResult, tenantId: TENANT }),
    );
  });
});

describe('PRIV-3 — the turn that completes a split card reads on as the marker', () => {
  it('Gather (handleGather): provider requests, the FSM context and the drafted note carry the marker', async () => {
    const h = await ownerPhoneCall('CA-pan-down-gather');
    await expectSplitCardNeverLeavesTheTurn(h, (speechResult) =>
      h.adapter.handleGather({
        sessionId: h.session.id,
        callSid: 'CA-pan-down-gather',
        speechResult,
        confidence: 0.95,
        tenantId: TENANT,
      }),
    );
  });

  it('Media Streams (processCallerUtterance): provider requests, the FSM context and the drafted note carry the marker', async () => {
    const h = await ownerPhoneCall('CA-pan-down-ms');
    await expectSplitCardNeverLeavesTheTurn(h, (speechResult) =>
      h.adapter.processCallerUtterance({
        sessionId: h.session.id,
        callSid: 'CA-pan-down-ms',
        speechResult,
        tenantId: TENANT,
      }),
    );
  });

  it('Media Streams (processCallerUtterance): the host is told the text the turn was read as', async () => {
    const h = await ownerPhoneCall('CA-pan-down-ms-text');
    const read: string[] = [];
    for (const speechResult of ['add a note for Dana Reyes, the card on file is 4111 1111 1111', '1111']) {
      await h.adapter.processCallerUtterance({
        sessionId: h.session.id,
        callSid: 'CA-pan-down-ms-text',
        speechResult,
        tenantId: TENANT,
        onCallerText: (text: string) => read.push(text),
      });
    }
    expect(read).toEqual(['add a note for Dana Reyes, the card on file is 4111 1111 1111', '[card number]']);
  });
});

