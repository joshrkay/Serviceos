/**
 * #1601 step 2 — characterisation at the `speechTurn` seam BEFORE
 * `isBlockedCallerId` moves to `ai/voice-turn/shared/`: a withheld caller-ID
 * on the one-turn P18-001 `create_customer` flow is treated as NO phone: the
 * handler answers `needs_callback`, so the caller is asked for a callback
 * number and no card is minted (a literal "anonymous" never becomes a
 * customer's phone). A real caller-ID is carried onto the card. Pinned here so
 * the move is provably identical at the public seam.
 *
 * Harness: the `speechturn-absorbs-gather-delta` fake transport on the
 * gather-declared surface (the only surface whose cell runs this branch).
 */
import { describe, it, expect, vi } from 'vitest';

import { createVoiceTurnProcessor } from '../../../src/ai/voice-turn';
import { VoiceSessionStore } from '../../../src/ai/agents/customer-calling/voice-session-store';
import { InMemoryAuditRepository } from '../../../src/audit/audit';
import type { LLMGateway, LLMResponse } from '../../../src/ai/gateway/gateway';
import { TTS_COPY } from '../../../src/ai/agents/customer-calling/tts-copy';
import type { SideEffect } from '../../../src/ai/agents/customer-calling/types';

const TENANT = 'tenant-1601-blocked';

function gatewayAlways(content: string): LLMGateway {
  return {
    complete: vi.fn(async () => ({
      content,
      model: 'stub',
      provider: 'stub',
      tokenUsage: { input: 1, output: 1, total: 2 },
      latencyMs: 1,
    }) as unknown as LLMResponse),
  } as unknown as LLMGateway;
}

function createCustomerTurn(callerId: string) {
  const store = new VoiceSessionStore({ startInterval: false });
  const proposalRepo = {
    create: vi.fn(async (p: Record<string, unknown>) => p),
    findByTenant: vi.fn(async () => []),
  };
  const processor = createVoiceTurnProcessor({
    store,
    gateway: gatewayAlways(
      JSON.stringify({
        intentType: 'create_customer',
        confidence: 0.96,
        reasoning: 'test',
        extractedEntities: { displayName: 'Maria Alvarez' },
      }),
    ),
    businessName: 'Acme Plumbing',
    systemActorId: 'test-actor',
    auditRepo: new InMemoryAuditRepository(),
    proposalRepo,
    coverageSurface: 'gather',
    callerPhoneResolver: () => callerId,
  } as never);
  const callSid = 'CA-1601-blocked';
  const session = store.create(TENANT, 'telephony', { callSid });
  session.machine.dispatch({
    type: 'incoming_call',
    tenantId: TENANT,
    callSid,
    from: callerId,
    to: '+15125550000',
  });
  session.machine.dispatch({ type: 'greeted_ok' });
  // Same shape as the absorbs-gather-delta harness: the FSM is in
  // intent_capture, and the P18-001 branch keys off `session.customerId`
  // (caller-ID match) — left unset for the unknown caller.
  session.machine.dispatch({
    type: 'caller_known',
    customerId: '22222222-2222-4222-8222-222222222222',
  });
  return {
    proposalRepo,
    turn: () =>
      processor.speechTurn({
        session,
        speechResult: 'new customer, Maria Alvarez',
        callSid,
        tenantId: TENANT,
      }),
  };
}

const spoken = (fx: SideEffect[]) =>
  fx
    .filter((f) => f.type === 'tts_play')
    .map((f) => String((f.payload as { text?: string }).text ?? ''));

describe('#1601 — speechTurn: a withheld caller-ID on the one-turn create_customer flow', () => {
  it('"anonymous" caller-ID: no card is minted; the caller is asked for a callback number', async () => {
    const h = createCustomerTurn('anonymous');
    const fx = await h.turn();

    expect(h.proposalRepo.create).not.toHaveBeenCalled();
    expect(spoken(fx)).toContain(TTS_COPY.signup_ask_callback.en);
    expect(JSON.stringify(fx)).not.toContain('anonymous');
  });

  it('a real caller-ID is carried onto the card as the callback phone', async () => {
    const h = createCustomerTurn('+15125550199');
    await h.turn();

    expect(h.proposalRepo.create).toHaveBeenCalledTimes(1);
    const stored = h.proposalRepo.create.mock.calls[0]![0] as {
      proposalType?: string;
      payload?: Record<string, unknown>;
    };
    expect(stored.proposalType).toBe('create_customer');
    expect(stored.payload?.phone).toBe('+15125550199');
  });
});
