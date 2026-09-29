/**
 * #1476 — an in-app voice draft whose only anchor (customer / job) did not
 * resolve must never become an approvable proposal read out as "taken care
 * of". QA 2026-09-28 (VOX-05c): "Draft an estimate for the Zanzibar Quixote
 * job…" resolved `not_found`, the readback still asked "is that right?", the
 * "yes" minted a ready_for_review draft_estimate with no customerId/jobId,
 * and approving it failed at execution ("Estimate draft has neither a
 * customerId nor a jobId").
 *
 * Seam: InAppVoiceAdapter (startSession / handleInput) with a scripted
 * gateway + EntityResolver, in-memory repos — the same seam as
 * inapp-pick-follow-up-1416.test.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { InAppVoiceAdapter } from '../../../../src/ai/agents/customer-calling/inapp-adapter';
import { VoiceSessionStore } from '../../../../src/ai/agents/customer-calling/voice-session-store';
import { InMemoryProposalRepository } from '../../../../src/proposals/proposal';
import { InMemoryAuditRepository } from '../../../../src/audit/audit';
import { InMemoryOnCallRepository } from '../../../../src/oncall/rotation';
import { approveProposal } from '../../../../src/proposals/actions';
import type { LLMGateway, LLMResponse } from '../../../../src/ai/gateway/gateway';
import type {
  EntityResolver,
  EntityResolverResult,
} from '../../../../src/ai/resolution/entity-resolver';

const TENANT = 'tenant-1476-inapp';
const OPERATOR = 'user-operator-1476';

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

function resolverByKind(byKind: Record<string, EntityResolverResult>): EntityResolver {
  return {
    resolve: vi.fn(async (input) => byKind[input.kind] ?? { kind: 'not_found' }),
  } as EntityResolver;
}

// The classifier output captured live for VOX-05c (evidence
// 9-VOX-05c-nonexistent-job-manual-probe.json): the spoken "Zanzibar Quixote
// job" landed as a customerName.
const ESTIMATE_FOR_UNKNOWN = JSON.stringify({
  intentType: 'draft_estimate',
  confidence: 0.9,
  extractedEntities: {
    customerName: 'Zanzibar Quixote',
    amount: 15000,
    lineItemDescriptions: ['diagnostic labor'],
  },
});

describe('InAppVoiceAdapter — unresolved anchor on a draft (#1476)', () => {
  let store: VoiceSessionStore;
  let proposalRepo: InMemoryProposalRepository;

  beforeEach(() => {
    store = new VoiceSessionStore({ startInterval: false });
    proposalRepo = new InMemoryProposalRepository();
  });
  afterEach(() => store.dispose());

  function makeAdapter(classifier: string, entityResolver: EntityResolver): InAppVoiceAdapter {
    return new InAppVoiceAdapter({
      store,
      gateway: scriptedGateway([classifier]),
      proposalRepo,
      auditRepo: new InMemoryAuditRepository(),
      onCallRepo: new InMemoryOnCallRepository(new Map()),
      entityResolver,
    });
  }

  it('an estimate for a customer that does not exist asks which customer — no readback, nothing drafted, never "taken care of"', async () => {
    const adapter = makeAdapter(
      ESTIMATE_FOR_UNKNOWN,
      resolverByKind({ customer: { kind: 'not_found', reference: 'Zanzibar Quixote' } }),
    );
    const { sessionId } = await adapter.startSession(TENANT, OPERATOR);

    const turn1 = await adapter.handleInput(
      sessionId,
      'Draft an estimate for the Zanzibar Quixote job with one diagnostic labor line for $150.',
    );
    expect(turn1.state).toBe('intent_capture');
    expect(turn1.ttsText).toMatch(/couldn't find a matching customer for Zanzibar Quixote/i);

    const turn2 = await adapter.handleInput(sessionId, "Yes, that's correct.");
    expect(turn2.ttsText ?? '').not.toMatch(/taken care of/i);
    expect(await proposalRepo.findByTenant(TENANT)).toHaveLength(0);
  });

  it('an estimate that names nobody is drafted gated — approval refuses it and the close is not "taken care of"', async () => {
    const adapter = makeAdapter(
      JSON.stringify({
        intentType: 'draft_estimate',
        confidence: 0.9,
        extractedEntities: { amount: 15000, lineItemDescriptions: ['diagnostic labor'] },
      }),
      resolverByKind({}),
    );
    const { sessionId } = await adapter.startSession(TENANT, OPERATOR);
    await adapter.handleInput(sessionId, 'Draft an estimate with one diagnostic labor line for $150.');
    const close = await adapter.handleInput(sessionId, 'yes');

    expect(close.ttsText ?? '').not.toMatch(/taken care of/i);
    const [proposal] = await proposalRepo.findByTenant(TENANT);
    expect(proposal?.proposalType).toBe('draft_estimate');
    await expect(
      approveProposal(proposalRepo, TENANT, proposal!.id, OPERATOR, 'owner'),
    ).rejects.toMatchObject({ details: { missingFields: ['customerId'] } });
  });
});
