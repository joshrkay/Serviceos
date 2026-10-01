/**
 * #1540 §6 (owner decision 2026-10-01) — on the PHONE leg the payload
 * builder is handed the tenant zone (settings) and the processor's clock, so
 * an owner's spoken expense is drafted with `spentAt` = the tenant-local
 * today, the way `LogExpenseTaskHandler` drafts it on the memo leg, instead
 * of being gated for the operator to fill.
 *
 * Seam: createVoiceTurnProcessor().speechTurn with a scripted gateway
 * (classifier + confirm_intent) and in-memory repos.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

import { createVoiceTurnProcessor } from '../../../src/ai/voice-turn';
import { VoiceSessionStore } from '../../../src/ai/agents/customer-calling/voice-session-store';
import { InMemoryAuditRepository } from '../../../src/audit/audit';
import { InMemoryProposalRepository, missingFieldsFor } from '../../../src/proposals/proposal';
import { InMemoryCustomerRepository, createCustomer } from '../../../src/customers/customer';
import { InMemorySettingsRepository, type TenantSettings } from '../../../src/settings/settings';
import type { LLMGateway, LLMRequest } from '../../../src/ai/gateway/gateway';

const TENANT = 'tenant-1540-ctx';
const CALL_SID = 'CA-1540-ctx';
const CALLER_ID = '+15125550140';

function scriptedGateway(classifier: string): LLMGateway {
  return {
    complete: vi.fn(async (req: LLMRequest) => {
      const isConfirm = (req.metadata as { skill?: string } | undefined)?.skill === 'confirm_intent';
      const saidYes = JSON.stringify(req.messages ?? '').includes('Yes, go ahead');
      return {
        content: isConfirm
          ? JSON.stringify({ answer: saidYes ? 'yes' : 'no', reasoning: 'scripted' })
          : classifier,
        model: 'mock',
        provider: 'mock',
        tokenUsage: { input: 1, output: 1, total: 2 },
        latencyMs: 1,
      };
    }),
  } as unknown as LLMGateway;
}

const stores: VoiceSessionStore[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) s.dispose();
});

describe('#1540 §6 — phone owner line: log_expense is drafted with the tenant-local spentAt', () => {
  it('05:00Z on May 1 is still April 30 for a Los Angeles tenant', async () => {
    const store = new VoiceSessionStore({ startInterval: false });
    stores.push(store);
    const proposalRepo = new InMemoryProposalRepository();
    const customerRepo = new InMemoryCustomerRepository();
    const settingsRepo = new InMemorySettingsRepository();
    await settingsRepo.create({ tenantId: TENANT, timezone: 'America/Los_Angeles' } as unknown as TenantSettings);
    const owner = await createCustomer(
      { tenantId: TENANT, firstName: 'Sam', lastName: 'Owner', primaryPhone: CALLER_ID, createdBy: 'test' },
      customerRepo,
    );
    const session = store.create(TENANT, 'telephony', { callSid: CALL_SID, ownerSession: true });
    session.machine.dispatch({ type: 'incoming_call', callSid: CALL_SID, from: CALLER_ID, to: '+15125550999', tenantId: TENANT });
    session.machine.dispatch({ type: 'greeted_ok' });
    session.machine.dispatch({ type: 'caller_known', customerId: owner.id });
    session.customerId = owner.id;
    session.callerPhone = CALLER_ID;
    session.actorUserId = 'owner-user-1540';

    const processor = createVoiceTurnProcessor({
      store,
      gateway: scriptedGateway(
        JSON.stringify({
          intentType: 'log_expense',
          confidence: 0.95,
          extractedEntities: { amountCents: 6000, category: 'fuel', description: 'Fuel for the van' },
        }),
      ),
      businessName: 'Acme Plumbing',
      systemActorId: 'test-actor',
      auditRepo: new InMemoryAuditRepository(),
      proposalRepo,
      customerRepo,
      settingsRepo,
      now: () => new Date('2026-05-01T05:00:00.000Z'),
    });
    const turn = (speechResult: string) =>
      processor.speechTurn({ session, speechResult, callSid: CALL_SID, tenantId: TENANT });

    await turn('Log sixty dollars of fuel for the van.');
    await turn('Yes, go ahead.');

    const [proposal] = await proposalRepo.findByTenant(TENANT);
    expect(proposal?.proposalType).toBe('log_expense');
    expect(proposal?.payload.spentAt).toBe('2026-04-30T07:00:00.000Z');
    expect(proposal ? missingFieldsFor(proposal) : []).not.toContain('spentAt');
  });
});
