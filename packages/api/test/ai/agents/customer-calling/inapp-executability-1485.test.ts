/**
 * #1485 — the in-app voice surface runs the SAME executability check the chat
 * route and a human tap run (proposals/approval-reference-checks.ts), and asks
 * for the missing piece instead of closing with "taken care of". Also: on the
 * FIRST turn, a resolved customer plus a named job that does not exist is said
 * honestly for an estimate/invoice — never a readback that would auto-open a
 * placeholder job (#1416 did this only after a pick).
 *
 * Seam: InAppVoiceAdapter (startSession / handleInput) with a scripted gateway
 * + EntityResolver fake, in-memory repos — the #1416/#1476/#1492 harness.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { InAppVoiceAdapter } from '../../../../src/ai/agents/customer-calling/inapp-adapter';
import { VoiceSessionStore } from '../../../../src/ai/agents/customer-calling/voice-session-store';
import { InMemoryProposalRepository } from '../../../../src/proposals/proposal';
import { InMemoryAuditRepository } from '../../../../src/audit/audit';
import { InMemoryOnCallRepository } from '../../../../src/oncall/rotation';
import type { LLMGateway, LLMResponse } from '../../../../src/ai/gateway/gateway';
import type {
  EntityResolver,
  EntityResolverResult,
} from '../../../../src/ai/resolution/entity-resolver';

const TENANT = 'tenant-1485-inapp';
const OPERATOR = 'user-operator-1485';
const CUST = '0b6b1f6e-1111-4c1a-9d8e-000000001485';

const ESTIMATE_FOR_NAMED_JOB = JSON.stringify({
  intentType: 'draft_estimate',
  confidence: 0.9,
  extractedEntities: {
    customerName: 'Dana Whitfield',
    jobReference: 'attic fan job',
    lineItemDescriptions: ['attic fan replacement'],
  },
});

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

const DANA: EntityResolverResult = {
  kind: 'resolved',
  candidate: { id: CUST, kind: 'customer', label: 'Dana Whitfield', score: 0.97 },
};

describe('InAppVoiceAdapter — executability before the close (#1485)', () => {
  let store: VoiceSessionStore;
  let proposalRepo: InMemoryProposalRepository;

  beforeEach(() => {
    store = new VoiceSessionStore({ startInterval: false });
    proposalRepo = new InMemoryProposalRepository();
  });
  afterEach(() => store.dispose());

  it('first turn: a resolved customer + a named job that does not exist is said honestly — nothing drafted', async () => {
    const adapter = new InAppVoiceAdapter({
      store,
      gateway: scriptedGateway([ESTIMATE_FOR_NAMED_JOB]),
      proposalRepo,
      auditRepo: new InMemoryAuditRepository(),
      onCallRepo: new InMemoryOnCallRepository(new Map()),
      entityResolver: resolverByKind({ customer: DANA, job: { kind: 'not_found', reference: 'attic fan job' } }),
    });
    const { sessionId } = await adapter.startSession(TENANT, OPERATOR);
    const turn1 = await adapter.handleInput(sessionId, 'Draft an estimate for Dana Whitfield on the attic fan job.');

    expect(turn1.state).not.toBe('intent_confirm');
    expect(turn1.ttsText).toMatch(/couldn't find a matching job for attic fan job/i);
    expect(await proposalRepo.findByTenant(TENANT)).toHaveLength(0);
  });
});
