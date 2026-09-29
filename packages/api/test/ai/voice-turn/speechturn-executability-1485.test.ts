/**
 * #1485 — the phone turn engine (createVoiceTurnProcessor().speechTurn, the
 * shared engine behind Gather and media streams):
 *
 *  - on the FIRST turn, a customer that resolves plus a job the caller NAMED
 *    that matches nothing is said honestly for an invoice/estimate — never a
 *    readback whose draft would auto-open a placeholder job (#1416 made that
 *    honest only after a disambiguation pick);
 *  - before a drafted proposal is queued it runs the SAME executability check
 *    a tap runs (executabilityGaps) and asks for the missing piece instead of
 *    closing with "taken care of".
 *
 * Seam: speechTurn with a mocked gateway + EntityResolver and in-memory repos
 * (the #1416 speechturn-pinned-refs harness).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

import { createVoiceTurnProcessor } from '../../../src/ai/voice-turn';
import { VoiceSessionStore } from '../../../src/ai/agents/customer-calling/voice-session-store';
import { InMemoryAuditRepository } from '../../../src/audit/audit';
import { InMemoryProposalRepository } from '../../../src/proposals/proposal';
import type { LLMGateway, LLMRequest } from '../../../src/ai/gateway/gateway';
import type { SideEffect } from '../../../src/ai/agents/customer-calling/types';
import type {
  EntityResolver,
  EntityResolverResult,
} from '../../../src/ai/resolution/entity-resolver';

const TENANT = 'tenant-1485';
const CUST_NORTH = '0b6b1f6e-1111-4c1a-9d8e-000000001416';
const CUST_SOUTH = '0b6b1f6e-1111-4c1a-9d8e-000000002416';
const JOB_FURNACE = '0b6b1f6e-2222-4c1a-9d8e-000000001416';
const JOB_HEATER = '0b6b1f6e-2222-4c1a-9d8e-000000002416';

const INVOICE_CLASSIFIER = JSON.stringify({
  intentType: 'create_invoice',
  confidence: 0.93,
  extractedEntities: {
    customerName: 'QA Matrix',
    jobReference: 'QA Matrix job',
    amount: 35000,
    lineItemDescriptions: ['completed furnace repair'],
  },
});
const CONFIRM_YES = JSON.stringify({ answer: 'yes', reasoning: 'affirmative' });

function phoneGateway(): LLMGateway {
  return {
    complete: vi.fn(async (req: LLMRequest) => ({
      content:
        (req.metadata as { skill?: string } | undefined)?.skill === 'confirm_intent'
          ? CONFIRM_YES
          : INVOICE_CLASSIFIER,
      model: 'mock',
      provider: 'mock',
      tokenUsage: { input: 1, output: 1, total: 2 },
      latencyMs: 1,
    })),
  } as unknown as LLMGateway;
}

const TWO_QA_MATRIX_CUSTOMERS: EntityResolverResult = {
  kind: 'ambiguous',
  candidates: [
    { id: CUST_NORTH, kind: 'customer', label: 'QA Matrix North', score: 0.9 },
    { id: CUST_SOUTH, kind: 'customer', label: 'QA Matrix South', score: 0.89 },
  ],
};

function resolverByKind(byKind: Record<string, EntityResolverResult>): EntityResolver {
  return {
    resolve: vi.fn(async (input) => byKind[input.kind] ?? { kind: 'not_found' }),
  } as EntityResolver;
}

const stores: VoiceSessionStore[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) s.dispose();
});

function makePhone(resolver: EntityResolver) {
  const store = new VoiceSessionStore({ startInterval: false });
  stores.push(store);
  const auditRepo = new InMemoryAuditRepository();
  const proposalRepo = new InMemoryProposalRepository();
  const session = store.create(TENANT, 'telephony', { callSid: 'CA-1485', ownerSession: true });
  session.machine.dispatch({
    type: 'incoming_call',
    callSid: 'CA-1485',
    from: '+15125550100',
    to: '+15125550999',
    tenantId: TENANT,
  });
  session.machine.dispatch({ type: 'greeted_ok' });
  session.machine.dispatch({ type: 'caller_known', customerId: 'owner-cust' });
  const processor = createVoiceTurnProcessor({
    store,
    gateway: phoneGateway(),
    businessName: 'Acme Plumbing',
    systemActorId: 'test-actor',
    auditRepo,
    proposalRepo,
    entityResolver: resolver,
  });
  const turn = (speechResult: string) =>
    processor.speechTurn({ session, speechResult, callSid: 'CA-1485', tenantId: TENANT });
  return { session, proposalRepo, turn };
}

function spoken(sideEffects: SideEffect[]): string[] {
  return sideEffects
    .filter((fx) => fx.type === 'tts_play')
    .map((fx) => String(fx.payload.text));
}

const INVOICE_UTTERANCE =
  'Create an invoice for the QA Matrix job for the completed furnace repair, 350 dollars total.';

describe('#1485 — phone: a named job that matches nothing on the first turn', () => {
  it('a resolved customer + a named job that does not exist is said honestly — no readback, nothing drafted', async () => {
    const { session, proposalRepo, turn } = makePhone(
      resolverByKind({
        customer: {
          kind: 'resolved',
          candidate: { id: CUST_NORTH, kind: 'customer', label: 'QA Matrix North', score: 0.97 },
        },
        job: { kind: 'not_found', reference: 'QA Matrix job' },
      }),
    );

    const first = await turn(INVOICE_UTTERANCE);
    expect(session.machine.currentState).not.toBe('intent_confirm');
    const lines = spoken(first).join(' ');
    expect(lines).toMatch(/wasn't able to find the record/i);
    expect(lines).not.toMatch(/Is that right\?/);
    expect(await proposalRepo.findByTenant(TENANT)).toHaveLength(0);
  });
});
