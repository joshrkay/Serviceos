/**
 * #1118 — the media-streams transport (`createVoiceTurnProcessor.speechTurn`)
 * asks instead of guessing when a spoken customer reference matches more than
 * one record.
 *
 * Before the fix `speechTurn` ran the shared `resolveSchedulingEntities`, then
 * folded `resolution.refs` into `entity_resolved` whatever the status — an
 * `ambiguous` outcome was silently dropped and the call went straight to the
 * intent_confirm readback with no customer id. `entity_ambiguous` was
 * dispatched only by the in-app adapter.
 *
 * Handler-level (CLAUDE.md: voice/AI behaviour changes need handler tests with
 * a mocked gateway/repos). The Gather transport is proven at real Postgres in
 * test/integration/phone-entity-ambiguous.test.ts.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

import { createVoiceTurnProcessor } from '../../../src/ai/voice-turn';
import { VoiceSessionStore } from '../../../src/ai/agents/customer-calling/voice-session-store';
import { InAppVoiceAdapter } from '../../../src/ai/agents/customer-calling/inapp-adapter';
import { MAX_DISAMBIGUATION_ATTEMPTS } from '../../../src/ai/agents/customer-calling/entity-resolution';
import { InMemoryAuditRepository } from '../../../src/audit/audit';
import { InMemoryProposalRepository } from '../../../src/proposals/proposal';
import { InMemoryOnCallRepository } from '../../../src/oncall/rotation';
import {
  InMemoryLocationRepository,
  type ServiceLocation,
} from '../../../src/locations/location';
import type { LLMGateway, LLMRequest, LLMResponse } from '../../../src/ai/gateway/gateway';
import type { SideEffect } from '../../../src/ai/agents/customer-calling/types';
import type {
  EntityResolver,
  EntityResolverResult,
} from '../../../src/ai/resolution/entity-resolver';

const TENANT = 'tenant-1118';

/** Production shape: PgEntityResolver hands over phone-only hints. */
const AMBIGUOUS_BOBS: EntityResolverResult = {
  kind: 'ambiguous',
  candidates: [
    { id: 'bob-old', kind: 'customer', label: 'Bob Smith', hint: '555-0001', score: 0.91 },
    { id: 'bob-new', kind: 'customer', label: 'Bob Smith', hint: '555-0002', score: 0.9 },
  ],
};

const CREATE_JOB_CLASSIFIER = JSON.stringify({
  intentType: 'create_job',
  confidence: 0.94,
  extractedEntities: { customerName: 'Bob Smith', jobTitle: 'faucet repair' },
});
const CONFIRM_YES = JSON.stringify({ answer: 'yes', reasoning: 'affirmative' });

/**
 * The classifier call answers create_job; confirmIntent's yes/no answers yes.
 * Keyed on the call, not its order: the owner-line deterministic matcher may
 * classify without a model call at all.
 */
function phoneGateway(): LLMGateway {
  return {
    complete: vi.fn(async (req: LLMRequest) => ({
      content:
        (req.metadata as { skill?: string } | undefined)?.skill === 'confirm_intent'
          ? CONFIRM_YES
          : CREATE_JOB_CLASSIFIER,
      model: 'mock',
      provider: 'mock',
      tokenUsage: { input: 1, output: 1, total: 2 },
      latencyMs: 1,
    })),
  } as unknown as LLMGateway;
}

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

function stubResolver(result: EntityResolverResult): EntityResolver {
  return { resolve: vi.fn(async () => result) };
}

function bobLocation(customerId: string, street1: string): ServiceLocation {
  return {
    id: `loc-${customerId}`,
    tenantId: TENANT,
    customerId,
    street1,
    city: 'Phoenix',
    state: 'AZ',
    postalCode: '85001',
    country: 'US',
    isPrimary: true,
    addressType: 'service',
    isArchived: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

async function bobLocations(): Promise<InMemoryLocationRepository> {
  const repo = new InMemoryLocationRepository();
  await repo.create(bobLocation('bob-old', '104 QA Cedar Avenue'));
  await repo.create(bobLocation('bob-new', '105 QA Cedar Avenue'));
  return repo;
}

const stores: VoiceSessionStore[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) s.dispose();
});

async function makePhone(opts: {
  gateway: LLMGateway;
  resolver?: EntityResolver;
  withLocations?: boolean;
}) {
  const store = new VoiceSessionStore({ startInterval: false });
  stores.push(store);
  const auditRepo = new InMemoryAuditRepository();
  const proposalRepo = new InMemoryProposalRepository();
  const locationRepo = opts.withLocations === false ? undefined : await bobLocations();
  // An owner-line call (RV-070): create_job is an operator intent.
  const session = store.create(TENANT, 'telephony', { callSid: 'CA-1118', ownerSession: true });
  session.machine.dispatch({
    type: 'incoming_call',
    callSid: 'CA-1118',
    from: '+15125550100',
    to: '+15125550999',
    tenantId: TENANT,
  });
  session.machine.dispatch({ type: 'greeted_ok' });
  session.machine.dispatch({ type: 'caller_known', customerId: 'owner-cust' });
  const processor = createVoiceTurnProcessor({
    store,
    gateway: opts.gateway,
    businessName: 'Acme Plumbing',
    systemActorId: 'test-actor',
    auditRepo,
    proposalRepo,
    entityResolver: opts.resolver ?? stubResolver(AMBIGUOUS_BOBS),
    ...(locationRepo ? { locationRepo } : {}),
  });
  const turn = (speechResult: string) =>
    processor.speechTurn({ session, speechResult, callSid: 'CA-1118', tenantId: TENANT });
  return { processor, session, auditRepo, proposalRepo, turn };
}

function spoken(sideEffects: SideEffect[]): string[] {
  return sideEffects
    .filter((fx) => fx.type === 'tts_play')
    .map((fx) => String(fx.payload.text));
}

describe('#1118 — speechTurn (media streams) dispatches entity_ambiguous', () => {
  it('two candidates → the caller is ASKED (rendered question, not the readback), the FSM parks in entity_resolution, nothing is drafted', async () => {
    const { session, auditRepo, proposalRepo, turn } = await makePhone({
      gateway: phoneGateway(),
    });

    const fx = await turn('open a job for Bob Smith, faucet repair');

    expect(session.machine.currentState).toBe('entity_resolution');
    const lines = spoken(fx);
    // The TEXT is the rendered question (Gather's <Say> speaks payload.text
    // verbatim; media streams re-renders the same template losslessly).
    expect(lines.at(-1)).toContain('more than one record under that name');
    expect(lines.join(' ')).not.toMatch(/Is that right\?/);
    expect(lines).not.toContain('entity_disambiguate');

    const ask = fx.find((e) => e.type === 'tts_play' && e.payload.template === 'disambiguate');
    expect((ask?.payload.candidates as Array<{ id: string }>).map((c) => c.id).sort()).toEqual([
      'bob-new',
      'bob-old',
    ]);
    const audit = auditRepo
      .getAll()
      .find((e) => e.eventType === 'agent.calling.entity_resolution.entity_ambiguous');
    expect(audit?.metadata?.candidateCount).toBe(2);
    expect(await proposalRepo.findByTenant(TENANT)).toHaveLength(0);
  });

  it('parity: the phone parks EXACTLY the pending ambiguity the in-app adapter parks for the same resolver result', async () => {
    const phone = await makePhone({ gateway: phoneGateway() });
    await phone.turn('open a job for Bob Smith, faucet repair');

    const inAppStore = new VoiceSessionStore({ startInterval: false });
    stores.push(inAppStore);
    const inApp = new InAppVoiceAdapter({
      store: inAppStore,
      gateway: scriptedGateway([CREATE_JOB_CLASSIFIER]),
      proposalRepo: new InMemoryProposalRepository(),
      auditRepo: new InMemoryAuditRepository(),
      onCallRepo: new InMemoryOnCallRepository(new Map()),
      locationRepo: await bobLocations(),
      entityResolver: stubResolver(AMBIGUOUS_BOBS),
    });
    const { sessionId } = await inApp.startSession(TENANT, 'user-1118');
    const inAppTurn = await inApp.handleInput(sessionId, 'open a job for Bob Smith, faucet repair');
    expect(inAppTurn.state).toBe('entity_resolution');

    const inAppPending = inAppStore.get(sessionId)!.machine.currentContext.pendingEntityAmbiguity;
    const phonePending = phone.session.machine.currentContext.pendingEntityAmbiguity;
    expect(phonePending).toBeDefined();
    expect(phonePending).toEqual(inAppPending);
    // …and it carries the U3 address hint the follow-up is matched against.
    expect(phonePending!.candidates.map((c) => c.hint).sort()).toEqual([
      '555-0001 · 104 QA Cedar Avenue, Phoenix',
      '555-0002 · 105 QA Cedar Avenue, Phoenix',
    ]);
  });

  it('the follow-up "104 Cedar" resolves through resolveDisambiguationFollowUp → readback, and "yes" drafts the proposal for THAT customer', async () => {
    const { session, proposalRepo, turn } = await makePhone({ gateway: phoneGateway() });
    await turn('open a job for Bob Smith, faucet repair');

    const followUp = await turn('the one at 104 Cedar');
    expect(session.machine.currentState).toBe('intent_confirm');
    expect(session.machine.currentContext.extractedEntities?.customerId).toBe('bob-old');
    expect(session.machine.currentContext.pendingEntityAmbiguity).toBeUndefined();
    expect(spoken(followUp).at(-1)).toBe('Just to confirm — create job. Is that right?');

    await turn('yes');
    const proposals = await proposalRepo.findByTenant(TENANT);
    expect(proposals).toHaveLength(1);
    expect(JSON.stringify(proposals[0]!.payload)).toContain('bob-old');
    expect(JSON.stringify(proposals[0]!.payload)).not.toContain('bob-new');
  });

  it(`an unplaceable answer re-asks (retry), and after ${MAX_DISAMBIGUATION_ATTEMPTS} retries proceeds with the partial refs — never a guessed id`, async () => {
    const { session, auditRepo, turn } = await makePhone({
      gateway: phoneGateway(),
    });
    await turn('open a job for Bob Smith, faucet repair');

    for (let attempt = 1; attempt <= MAX_DISAMBIGUATION_ATTEMPTS; attempt += 1) {
      const retry = await turn('the blue house');
      expect(session.machine.currentState).toBe('entity_resolution');
      expect(spoken(retry).at(-1)).toContain('more than one record under that name');
      expect(session.machine.currentContext.pendingEntityAmbiguity?.attemptCount).toBe(attempt);
    }
    const retryAudits = auditRepo
      .getAll()
      .filter((e) => e.eventType === 'agent.calling.entity_resolution.entity_ambiguous');
    expect(retryAudits.map((e) => e.metadata?.retryAttempt)).toEqual([undefined, 1, 2]);

    await turn('the blue house');
    expect(session.machine.currentState).toBe('intent_confirm');
    expect(session.machine.currentContext.extractedEntities?.customerId).toBeUndefined();
  });

  it('a single confident match still resolves straight to the readback (no question)', async () => {
    const { session, turn } = await makePhone({
      gateway: phoneGateway(),
      resolver: stubResolver({
        kind: 'resolved',
        candidate: { id: 'bob-only', kind: 'customer', label: 'Bob Smith', score: 0.97 },
      }),
    });
    const fx = await turn('open a job for Bob Smith, faucet repair');
    expect(session.machine.currentState).toBe('intent_confirm');
    expect(session.machine.currentContext.extractedEntities?.customerId).toBe('bob-only');
    expect(spoken(fx).at(-1)).toBe('Just to confirm — create job. Is that right?');
  });

  it('with no locationRepo wired the question is still asked (phone-only hints) — degraded, never dropped', async () => {
    const { session, turn } = await makePhone({
      gateway: phoneGateway(),
      withLocations: false,
    });
    await turn('open a job for Bob Smith, faucet repair');
    expect(session.machine.currentState).toBe('entity_resolution');
    expect(
      session.machine.currentContext.pendingEntityAmbiguity?.candidates.map((c) => c.hint).sort(),
    ).toEqual(['555-0001', '555-0002']);
  });
});
