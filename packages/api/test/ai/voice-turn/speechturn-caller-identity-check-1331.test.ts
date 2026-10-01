/**
 * #1331 owner decision (2026-10-01) — a mumbled / low-confidence caller name.
 *
 * The caller is identified by caller ID (one account on this number). When
 * they ALSO say who they are and that name does not confidently match the
 * account (below τ_ent, the resolver's "resolved" bar), the agent asks ONE
 * yes/no identity check — "is this Maria Rodriguez?" — before acting on the
 * account:
 *   - yes → the request they made is handled, on that account;
 *   - no  → the account is unbound for this call (nothing is read from or
 *           drafted on it) and the agent asks who it is speaking with.
 * A confident name match, or no name at all, keeps today's flow.
 *
 * Seam: createVoiceTurnProcessor().speechTurn with a scripted gateway and
 * in-memory repos.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

import { createVoiceTurnProcessor } from '../../../src/ai/voice-turn';
import { VoiceSessionStore } from '../../../src/ai/agents/customer-calling/voice-session-store';
import { InMemoryAuditRepository } from '../../../src/audit/audit';
import { InMemoryProposalRepository } from '../../../src/proposals/proposal';
import { InMemoryCustomerRepository, createCustomer } from '../../../src/customers/customer';
import type { LLMGateway, LLMRequest } from '../../../src/ai/gateway/gateway';
import type { SideEffect } from '../../../src/ai/agents/customer-calling/types';
import {
  UNIDENTIFIED_CALLER_LINE,
  type PhoneLookupDeps,
} from '../../../src/ai/voice-turn/phone-lookup-surface';

const TENANT = 'tenant-1331-identity';
const CALL_SID = 'CA-1331-identity';
const CALLER_ID = '+15555550805';

const LOOKUP_APPOINTMENTS = JSON.stringify({
  intentType: 'lookup_appointments',
  confidence: 0.92,
  extractedEntities: {},
});

const LOOKUP_BALANCE = JSON.stringify({
  intentType: 'lookup_balance',
  confidence: 0.92,
  extractedEntities: {},
});

function scriptedGateway(classifier: string): LLMGateway & { complete: ReturnType<typeof vi.fn> } {
  return {
    complete: vi.fn(async (req: LLMRequest) => {
      const isConfirm = (req.metadata as { skill?: string } | undefined)?.skill === 'confirm_intent';
      return {
        content: isConfirm ? JSON.stringify({ answer: 'yes', reasoning: 'scripted' }) : classifier,
        model: 'mock',
        provider: 'mock',
        tokenUsage: { input: 1, output: 1, total: 2 },
        latencyMs: 1,
      };
    }),
  } as unknown as LLMGateway & { complete: ReturnType<typeof vi.fn> };
}

function spoken(effects: SideEffect[]): string {
  return effects
    .filter((fx) => fx.type === 'tts_play')
    .map((fx) => String(fx.payload.text))
    .join(' ');
}

/** Every caller line the gateway was asked to classify. */
function classifiedUtterances(gateway: { complete: ReturnType<typeof vi.fn> }): string {
  return gateway.complete.mock.calls
    .flatMap((c) => (c[0] as LLMRequest).messages ?? [])
    .filter((m) => m.role === 'user')
    .map((m) => String(m.content))
    .join('\n');
}

const stores: VoiceSessionStore[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) s.dispose();
});

async function knownCallerCall(classifier = LOOKUP_APPOINTMENTS) {
  const store = new VoiceSessionStore({ startInterval: false });
  stores.push(store);
  const customerRepo = new InMemoryCustomerRepository();
  const proposalRepo = new InMemoryProposalRepository();
  const maria = await createCustomer(
    { tenantId: TENANT, firstName: 'Maria', lastName: 'Rodriguez', primaryPhone: CALLER_ID, createdBy: 'seed' },
    customerRepo,
  );
  const session = store.create(TENANT, 'telephony', { callSid: CALL_SID });
  session.machine.dispatch({ type: 'incoming_call', callSid: CALL_SID, from: CALLER_ID, to: '+15125550999', tenantId: TENANT });
  session.machine.dispatch({ type: 'greeted_ok' });
  session.machine.dispatch({ type: 'caller_known', customerId: maria.id });
  session.customerId = maria.id;
  session.callerPhone = CALLER_ID;
  const gateway = scriptedGateway(classifier);
  const processor = createVoiceTurnProcessor({
    store,
    gateway,
    businessName: 'Test HVAC Co',
    systemActorId: 'test-actor',
    auditRepo: new InMemoryAuditRepository(),
    proposalRepo,
    customerRepo,
    // The phone lookup surface is wired (no repos needed: an unidentified
    // caller is refused before any read).
    lookups: {} as PhoneLookupDeps,
  });
  const turn = async (speechResult: string) =>
    spoken(await processor.speechTurn({ session, speechResult, callSid: CALL_SID, tenantId: TENANT }));
  return { session, gateway, turn, maria, proposalRepo };
}

describe('#1331 — a low-confidence caller name gets one yes/no identity check', () => {
  it('a mumbled name asks "is this Maria Rodriguez?" before acting on the account', async () => {
    const call = await knownCallerCall();

    const reply = await call.turn('Hi this is Mmmmaria Roddrrgez calling about my appointment');

    expect(reply).toMatch(/is this Maria Rodriguez\?/i);
    expect(call.gateway.complete).not.toHaveBeenCalled();
  });

  it('"yes" handles the request the caller made, on the account', async () => {
    const call = await knownCallerCall();
    await call.turn('Hi this is Mmmmaria Roddrrgez calling about my appointment');

    const reply = await call.turn('Yes.');

    expect(reply).not.toMatch(/is this Maria Rodriguez\?/i);
    expect(call.gateway.complete).toHaveBeenCalled();
    expect(classifiedUtterances(call.gateway)).toContain('calling about my appointment');
    expect(call.session.customerId).toBe(call.maria.id);
  });

  it('"no" unbinds the account for the call and asks who it is speaking with', async () => {
    const call = await knownCallerCall(LOOKUP_BALANCE);
    await call.turn('Hi this is Mmmmaria Roddrrgez calling about my balance');

    const reply = await call.turn("No, that's not me.");

    expect(reply).toMatch(/who am I speaking with/i);
    // Nothing is read from the account any more: an own-account question
    // now gets the unidentified-caller answer, never Maria's records.
    const next = await call.turn("What's my balance?");
    expect(next).toContain(UNIDENTIFIED_CALLER_LINE);
    expect(next).not.toMatch(/\$/);
  });

  it('an answer that is neither yes nor no re-asks once, then counts as "no" (never acts on the account unconfirmed)', async () => {
    const call = await knownCallerCall(LOOKUP_BALANCE);
    await call.turn('Hi this is Mmmmaria Roddrrgez calling about my balance');

    const reask = await call.turn('Sorry, what?');
    expect(reask).toMatch(/is this Maria Rodriguez\?/i);

    const second = await call.turn('Hmm, I am not sure.');
    expect(second).toMatch(/who am I speaking with/i);
    expect(call.gateway.complete).not.toHaveBeenCalled();
  });
});

describe('#1331 — no identity check when the name matches or no name is given', () => {
  it.each([
    'Hi, this is Maria Rodriguez calling about my appointment',
    'Hi, this is Maria. When is my appointment?',
    'When is my next appointment?',
    'This is urgent, when is my appointment?',
  ])('"%s" goes straight to the request', async (utterance) => {
    const call = await knownCallerCall();

    const reply = await call.turn(utterance);

    expect(reply).not.toMatch(/is this Maria Rodriguez\?/i);
    expect(call.gateway.complete).toHaveBeenCalled();
  });
});
