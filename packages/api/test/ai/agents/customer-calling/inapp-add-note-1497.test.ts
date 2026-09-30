/**
 * #1497 (2) — an in-app voice note must be approvable and must execute.
 *
 * LLM QA 2026-09-29 (V5): "Add a note for <customer> that …" was persisted with
 * the classifier's `noteBody` / `noteTargetKind` keys instead of the add_note
 * contract's `body` / `targetKind`, so approve refused it ("unfilled required
 * fields: targetKind, body") — a voice note could never be saved. Chat notes
 * (AddNoteTaskHandler) always used the right keys.
 *
 * Seam: InAppVoiceAdapter (startSession / handleInput) with a scripted gateway
 * and a resolver → approveProposal → the add_note execution handler → the note
 * repository's public read.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { InAppVoiceAdapter } from '../../../../src/ai/agents/customer-calling/inapp-adapter';
import { VoiceSessionStore } from '../../../../src/ai/agents/customer-calling/voice-session-store';
import { InMemoryProposalRepository } from '../../../../src/proposals/proposal';
import { InMemoryAuditRepository } from '../../../../src/audit/audit';
import { InMemoryOnCallRepository } from '../../../../src/oncall/rotation';
import { InMemoryNoteRepository } from '../../../../src/notes/note';
import { approveProposal } from '../../../../src/proposals/actions';
import { AddNoteExecutionHandler } from '../../../../src/proposals/execution/voice-extended-handlers';
import type { LLMGateway, LLMResponse } from '../../../../src/ai/gateway/gateway';
import type { EntityResolver } from '../../../../src/ai/resolution/entity-resolver';

const TENANT = 'tenant-1497-note';
const OPERATOR = 'user-operator-1497';
const CUSTOMER_ID = '5b1e3c1e-8d7a-4f0e-9a39-1c2d3e4f5a6b';

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

const resolvesPatel: EntityResolver = {
  resolve: vi.fn(async () => ({
    kind: 'resolved' as const,
    candidate: { id: CUSTOMER_ID, kind: 'customer' as const, label: 'Priya Patel', score: 0.97 },
  })),
};

describe('InAppVoiceAdapter — a voice note is approvable and executes (#1497)', () => {
  let store: VoiceSessionStore;
  let proposalRepo: InMemoryProposalRepository;
  let auditRepo: InMemoryAuditRepository;

  beforeEach(() => {
    store = new VoiceSessionStore({ startInterval: false });
    proposalRepo = new InMemoryProposalRepository();
    auditRepo = new InMemoryAuditRepository();
  });
  afterEach(() => store.dispose());

  it('"Add a note for Priya Patel that the gate code is 4412" → approve → the note is saved on the customer', async () => {
    const adapter = new InAppVoiceAdapter({
      store,
      gateway: scriptedGateway([
        JSON.stringify({
          intentType: 'add_note',
          confidence: 0.95,
          reasoning: 'note',
          extractedEntities: {
            customerName: 'Priya Patel',
            noteTargetKind: 'customer',
            noteBody: 'The gate code is 4412',
          },
        }),
        JSON.stringify({ intentType: 'confirm', confidence: 0.95, reasoning: 'yes', extractedEntities: {} }),
      ]),
      proposalRepo,
      auditRepo,
      onCallRepo: new InMemoryOnCallRepository(new Map()),
      entityResolver: resolvesPatel,
    });
    const { sessionId } = await adapter.startSession(TENANT, OPERATOR);
    await adapter.handleInput(sessionId, 'Add a note for Priya Patel that the gate code is 4412');
    await adapter.handleInput(sessionId, 'yes');

    const [drafted] = await proposalRepo.findByTenant(TENANT);
    expect(drafted?.proposalType).toBe('add_note');

    const approved = await approveProposal(proposalRepo, TENANT, drafted!.id, OPERATOR, 'owner');

    const noteRepo = new InMemoryNoteRepository();
    const result = await new AddNoteExecutionHandler(noteRepo, auditRepo).execute(approved, {
      tenantId: TENANT,
      executedBy: OPERATOR,
    });
    expect(result.success).toBe(true);

    const notes = await noteRepo.findByEntity(TENANT, 'customer', CUSTOMER_ID);
    expect(notes.map((n) => n.content)).toEqual(['The gate code is 4412']);
  });
  it('a note whose target did not resolve is held at approval on targetId — never approve-then-fail', async () => {
    const adapter = new InAppVoiceAdapter({
      store,
      gateway: scriptedGateway([
        JSON.stringify({
          intentType: 'add_note',
          confidence: 0.95,
          reasoning: 'note',
          extractedEntities: { jobReference: 'the Zanzibar job', noteTargetKind: 'job', noteBody: 'Bring a ladder' },
        }),
        JSON.stringify({ intentType: 'confirm', confidence: 0.95, reasoning: 'yes', extractedEntities: {} }),
      ]),
      proposalRepo,
      auditRepo,
      onCallRepo: new InMemoryOnCallRepository(new Map()),
    });
    const { sessionId } = await adapter.startSession(TENANT, OPERATOR);
    await adapter.handleInput(sessionId, 'Add a note on the Zanzibar job to bring a ladder');
    await adapter.handleInput(sessionId, 'yes');

    const [drafted] = await proposalRepo.findByTenant(TENANT);
    expect(drafted?.proposalType).toBe('add_note');
    await expect(
      approveProposal(proposalRepo, TENANT, drafted!.id, OPERATOR, 'owner'),
    ).rejects.toMatchObject({ details: { missingFields: ['targetId'] } });
  });
});
