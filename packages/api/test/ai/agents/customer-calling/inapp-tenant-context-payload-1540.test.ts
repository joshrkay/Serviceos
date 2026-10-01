/**
 * #1540 §6 — the IN-APP voice leg hands the shared payload builder the same
 * tenant context as the phone leg: an operator's spoken expense is drafted
 * with `spentAt` = the tenant-local today (LogExpenseTaskHandler's rule).
 *
 * Seam: InAppVoiceAdapter (startSession / handleInput) with a scripted
 * gateway and in-memory repos. The adapter has no clock seam, so the wall
 * clock is pinned (Date only).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { InAppVoiceAdapter } from '../../../../src/ai/agents/customer-calling/inapp-adapter';
import { VoiceSessionStore } from '../../../../src/ai/agents/customer-calling/voice-session-store';
import { InMemoryProposalRepository } from '../../../../src/proposals/proposal';
import { InMemoryAuditRepository } from '../../../../src/audit/audit';
import { InMemoryOnCallRepository } from '../../../../src/oncall/rotation';
import { InMemorySettingsRepository, type TenantSettings } from '../../../../src/settings/settings';
import type { LLMGateway, LLMResponse } from '../../../../src/ai/gateway/gateway';

const TENANT = 'tenant-1540-inapp';
const OPERATOR = 'user-operator-1540';

function scriptedGateway(content: string): LLMGateway {
  return {
    complete: vi.fn(async () => ({
      content,
      model: 'mock',
      provider: 'mock',
      tokenUsage: { input: 1, output: 1, total: 2 },
      latencyMs: 1,
    }) satisfies LLMResponse),
  } as unknown as LLMGateway;
}

let store: VoiceSessionStore | undefined;
afterEach(() => {
  store?.dispose();
  vi.useRealTimers();
});

describe('#1540 §6 — in-app: log_expense is drafted with the tenant-local spentAt', () => {
  it('05:00Z on May 1 is still April 30 for a Los Angeles tenant', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-05-01T05:00:00.000Z'));
    store = new VoiceSessionStore({ startInterval: false });
    const proposalRepo = new InMemoryProposalRepository();
    const settingsRepo = new InMemorySettingsRepository();
    await settingsRepo.create({ tenantId: TENANT, timezone: 'America/Los_Angeles' } as unknown as TenantSettings);
    const adapter = new InAppVoiceAdapter({
      store,
      gateway: scriptedGateway(
        JSON.stringify({
          intentType: 'log_expense',
          confidence: 0.95,
          extractedEntities: { amountCents: 6000, category: 'fuel', description: 'Fuel for the van' },
        }),
      ),
      proposalRepo,
      auditRepo: new InMemoryAuditRepository(),
      onCallRepo: new InMemoryOnCallRepository(new Map()),
      settingsRepo,
    });
    const { sessionId } = await adapter.startSession(TENANT, OPERATOR);
    await adapter.handleInput(sessionId, 'Log sixty dollars of fuel for the van.');
    await adapter.handleInput(sessionId, 'yes');

    const [proposal] = await proposalRepo.findByTenant(TENANT);
    expect(proposal?.proposalType).toBe('log_expense');
    expect(proposal?.payload.spentAt).toBe('2026-04-30T07:00:00.000Z');
  });
});
