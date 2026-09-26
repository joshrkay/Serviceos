/**
 * #1272 — the closing line must not claim completion for a draft that cannot
 * be approved.
 *
 * VOX-05 (dev, 2026-09-19): "Draft an estimate for the QA Matrix job with one
 * diagnostic labor line for $150." → confirmed → a draft_estimate proposal
 * with NO lineItems (`missingFields: ["lineItems"]`, approve 400s) — and the
 * operator heard "Great, I've got that taken care of. You'll receive a
 * confirmation shortly." Nothing was taken care of, and no confirmation was
 * coming: the card is unapprovable until someone fills the gap.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { InAppVoiceAdapter } from '../../../../src/ai/agents/customer-calling/inapp-adapter';
import { VoiceSessionStore } from '../../../../src/ai/agents/customer-calling/voice-session-store';
import { InMemoryProposalRepository, missingFieldsFor } from '../../../../src/proposals/proposal';
import { InMemoryAuditRepository } from '../../../../src/audit/audit';
import { InMemoryOnCallRepository } from '../../../../src/oncall/rotation';
import type { LLMGateway, LLMResponse } from '../../../../src/ai/gateway/gateway';

const TENANT = 'tenant-closing';
const USER = 'user-closing';
const GENERIC_CLOSING_LINE =
  "Great, I've got that taken care of. You'll receive a confirmation shortly. Is there anything else I can help you with?";

function classifierJson(intentType: string, extractedEntities: Record<string, unknown> = {}): string {
  return JSON.stringify({ intentType, confidence: 0.95, reasoning: 'test', extractedEntities });
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

describe('InAppVoiceAdapter — closing copy is conditional on an approvable draft (#1272)', () => {
  let store: VoiceSessionStore;
  let proposalRepo: InMemoryProposalRepository;

  beforeEach(() => {
    store = new VoiceSessionStore({ startInterval: false });
    proposalRepo = new InMemoryProposalRepository();
  });
  afterEach(() => store.dispose());

  function buildAdapter(responses: string[]): InAppVoiceAdapter {
    return new InAppVoiceAdapter({
      store,
      gateway: scriptedGateway(responses),
      proposalRepo,
      auditRepo: new InMemoryAuditRepository(),
      onCallRepo: new InMemoryOnCallRepository(),
    });
  }

  it('VOX-05: an estimate drafted with missingFields does not promise a confirmation', async () => {
    const adapter = buildAdapter([
      classifierJson('draft_estimate', {
        customerName: 'QA Matrix',
        amount: 15000,
        jobTitle: 'diagnostic labor',
      }),
      classifierJson('confirm'),
    ]);
    const { sessionId } = await adapter.startSession(TENANT, USER);

    await adapter.handleInput(
      sessionId,
      'Draft an estimate for the QA Matrix job with one diagnostic labor line for $150.',
    );
    const closing = await adapter.handleInput(sessionId, 'Yes');

    const proposals = await proposalRepo.findByTenant(TENANT);
    expect(proposals).toHaveLength(1);
    // Precondition: this draft really is unapprovable.
    expect(missingFieldsFor(proposals[0]!)).toContain('lineItems');

    expect(closing.ttsText).toBeDefined();
    expect(closing.ttsText).not.toBe(GENERIC_CLOSING_LINE);
    expect(closing.ttsText).not.toMatch(/taken care of/i);
    expect(closing.ttsText).not.toMatch(/confirmation/i);
    // It says what IS true: a draft exists and still needs details.
    expect(closing.ttsText).toMatch(/draft/i);
    expect(closing.ttsText).toMatch(/details/i);
  });

  it('a complete, approvable draft keeps the existing closing line', async () => {
    const adapter = buildAdapter([
      classifierJson('create_customer', { displayName: 'Jane Smith', phone: '+15125550100' }),
      classifierJson('confirm'),
    ]);
    const { sessionId } = await adapter.startSession(TENANT, USER);

    await adapter.handleInput(sessionId, 'Add a new customer Jane Smith, 512-555-0100');
    const closing = await adapter.handleInput(sessionId, 'Yes');

    const proposals = await proposalRepo.findByTenant(TENANT);
    expect(proposals).toHaveLength(1);
    expect(missingFieldsFor(proposals[0]!)).toEqual([]);
    expect(closing.ttsText).toBe(GENERIC_CLOSING_LINE);
  });
});
