/**
 * #1416 — the phone port of #1406 D6 (`pinnedRefs`).
 *
 * "Invoice the QA Matrix job …" on an owner line plans TWO lookups: the
 * customer, then the job. When the customer name is ambiguous the phone asks
 * (#1118) — but after the caller's pick the phone folded the pick straight
 * into `entity_resolved`, so the job lookup planned after it never ran. The
 * approved draft_invoice then had no jobId and the executor opened a
 * placeholder job instead of invoicing the job the caller named.
 *
 * After the pick the phone now re-runs resolution with the picked id pinned
 * (the in-app adapter's approach): the job resolves onto the draft, a second
 * ambiguity is a second question, and a job that does not exist is said
 * honestly instead of silently drafting against a placeholder.
 *
 * Seam: createVoiceTurnProcessor().speechTurn (the shared phone turn engine
 * behind Gather and media streams) with a mocked gateway + EntityResolver
 * and in-memory repos.
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

const TENANT = 'tenant-1416';
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
  const session = store.create(TENANT, 'telephony', { callSid: 'CA-1416', ownerSession: true });
  session.machine.dispatch({
    type: 'incoming_call',
    callSid: 'CA-1416',
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
    processor.speechTurn({ session, speechResult, callSid: 'CA-1416', tenantId: TENANT });
  return { session, proposalRepo, turn };
}

function spoken(sideEffects: SideEffect[]): string[] {
  return sideEffects
    .filter((fx) => fx.type === 'tts_play')
    .map((fx) => String(fx.payload.text));
}

const INVOICE_UTTERANCE =
  'Create an invoice for the QA Matrix job for the completed furnace repair, 350 dollars total.';

describe('#1416 — phone: the lookups planned after a customer pick still run', () => {
  it('after the customer is picked, the spoken job reference is resolved onto the draft invoice', async () => {
    const { session, proposalRepo, turn } = makePhone(
      resolverByKind({
        customer: TWO_QA_MATRIX_CUSTOMERS,
        job: {
          kind: 'resolved',
          candidate: { id: JOB_FURNACE, kind: 'job', label: 'QA Matrix job', score: 0.95 },
        },
      }),
    );

    await turn(INVOICE_UTTERANCE);
    expect(session.machine.currentState).toBe('entity_resolution');

    await turn('QA Matrix North');
    expect(session.machine.currentState).toBe('intent_confirm');
    expect(session.machine.currentContext.extractedEntities?.customerId).toBe(CUST_NORTH);
    expect(session.machine.currentContext.extractedEntities?.jobId).toBe(JOB_FURNACE);

    await turn('yes');
    const [proposal] = await proposalRepo.findByTenant(TENANT);
    expect(proposal?.payload.customerId).toBe(CUST_NORTH);
    expect(proposal?.payload.jobId).toBe(JOB_FURNACE);
  });

  it('an ambiguous job after the pick is a SECOND question, then the job picked is the one drafted — never a guess', async () => {
    const { session, proposalRepo, turn } = makePhone(
      resolverByKind({
        customer: TWO_QA_MATRIX_CUSTOMERS,
        job: {
          kind: 'ambiguous',
          candidates: [
            { id: JOB_FURNACE, kind: 'job', label: 'QA Matrix furnace', score: 0.9 },
            { id: JOB_HEATER, kind: 'job', label: 'QA Matrix water heater', score: 0.88 },
          ],
        },
      }),
    );
    await turn(INVOICE_UTTERANCE);

    const second = await turn('QA Matrix North');
    expect(session.machine.currentState).toBe('entity_resolution');
    const ask = second.find((e) => e.type === 'tts_play' && e.payload.template === 'disambiguate');
    expect((ask?.payload.candidates as Array<{ id: string }>).map((c) => c.id).sort()).toEqual(
      [JOB_FURNACE, JOB_HEATER].sort(),
    );
    expect(spoken(second).join(' ')).not.toMatch(/Is that right\?/);

    await turn('QA Matrix water heater');
    expect(session.machine.currentState).toBe('intent_confirm');
    await turn('yes');
    const [proposal] = await proposalRepo.findByTenant(TENANT);
    expect(proposal?.payload.customerId).toBe(CUST_NORTH);
    expect(proposal?.payload.jobId).toBe(JOB_HEATER);
  });

  it('a job that does not exist is said honestly after the pick — no readback, nothing drafted against a placeholder', async () => {
    const { session, proposalRepo, turn } = makePhone(
      resolverByKind({ customer: TWO_QA_MATRIX_CUSTOMERS, job: { kind: 'not_found', reference: 'QA Matrix job' } }),
    );
    await turn(INVOICE_UTTERANCE);

    const after = await turn('QA Matrix North');
    expect(session.machine.currentState).not.toBe('intent_confirm');
    const lines = spoken(after).join(' ');
    expect(lines).toMatch(/wasn't able to find the record/i);
    expect(lines).not.toMatch(/Is that right\?/);
    expect(await proposalRepo.findByTenant(TENANT)).toHaveLength(0);
  });
});
