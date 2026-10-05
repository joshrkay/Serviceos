/**
 * #1587 — the Layer 1 text-mode driver drives the PRODUCTION turn processor.
 *
 * Seam: `TextModeDriver.speak()` (the harness's public AgentDriver contract).
 * Expected values come from production copy (`tts-copy.ts`) and the phone's
 * documented flow (a write is read back and drafted on the caller's yes),
 * never from the driver.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { VoiceSessionStore } from '../../src/ai/agents/customer-calling/voice-session-store';
import { AgentEventBus } from '../../src/ai/voice-quality/event-bus';
import { TextModeDriver } from '../../src/ai/voice-quality/text-mode-driver';
import { LLMGateway, type LLMRequest, type LLMResponse } from '../../src/ai/gateway/gateway';
import { InMemoryProposalRepository } from '../../src/proposals/proposal';
import { InMemoryCustomerRepository } from '../../src/customers/customer';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { InMemoryOnCallRepository } from '../../src/oncall/rotation';
import type { SettingsRepository, TenantSettings } from '../../src/settings/settings';
import { OPERATOR_DRAFTED_FOR_REVIEW_COPY } from '../../src/ai/agents/customer-calling/tts-copy';

const TENANT = 't-1587';
const OWNER_PHONE = '+15125550100';

/**
 * Offline stand-in for the two model calls a drafting turn makes: the intent
 * classifier (answers the scripted classification) and the yes/no model the
 * readback answer goes through (`confirmIntent`, same task type, its own
 * prompt).
 */
class RoutedMockGateway extends LLMGateway {
  constructor(private readonly classification: Record<string, unknown>) {
    super({ defaultProvider: 'mock' }, new Map());
  }

  override async complete(request: LLMRequest): Promise<LLMResponse> {
    const user = request.messages.find((m) => m.role === 'user')?.content ?? '';
    const content = user.includes('Classify the caller\'s response as YES or NO')
      ? JSON.stringify({ answer: 'yes', reasoning: 'affirmative' })
      : JSON.stringify(this.classification);
    return {
      content,
      model: 'mock-model',
      provider: 'mock',
      latencyMs: 1,
      tokenUsage: { input: 10, output: 10, total: 20 },
    };
  }
}

function settingsRepo(): SettingsRepository {
  const row = {
    tenantId: TENANT,
    timezone: 'America/Los_Angeles',
    businessHoursSchedule: [],
    ownerPhone: OWNER_PHONE,
  } as unknown as TenantSettings;
  return {
    findByTenant: async (t: string) => (t === TENANT ? row : null),
  } as unknown as SettingsRepository;
}

describe('#1587 — TextModeDriver drives the production speechTurn', () => {
  const store = new VoiceSessionStore({ startInterval: false });
  const bus = new AgentEventBus();
  afterEach(() => {
    bus.unsubscribeAll();
  });

  it('an owner-line write is read back first and drafted on the yes, with the production closer', async () => {
    const proposalRepo = new InMemoryProposalRepository();
    const driver = new TextModeDriver({
      voiceSessionStore: store,
      bus,
      gateway: new RoutedMockGateway({
        intentType: 'log_expense',
        confidence: 0.95,
        extractedEntities: { amount: 5500, expenseCategory: 'fuel' },
      }),
      proposalRepo,
      customerRepo: new InMemoryCustomerRepository(),
      auditRepo: new InMemoryAuditRepository(),
      onCallRepo: new InMemoryOnCallRepository(
        new Map([[TENANT, [{ id: 'oncall_1', userId: 'dispatcher_1', orderIndex: 0 }]]]),
      ),
      settingsRepo: settingsRepo(),
      now: () => new Date('2026-05-01T12:00:00.000Z'),
      systemActorId: 'system:vq-test',
    });
    const { sessionId } = await driver.startSession({
      tenantId: TENANT,
      callerId: OWNER_PHONE,
      callerIdBlocked: false,
    });

    const request = await driver.speak(sessionId, 'Add a 55 dollar fuel expense for today.');

    // The phone never drafts on the request turn: it reads the request back.
    expect(request.agentResponse).toContain('Is that right?');
    expect(await proposalRepo.findByTenant(TENANT)).toHaveLength(0);

    const yes = await driver.speak(sessionId, "Yes, that's right.");

    const proposals = await proposalRepo.findByTenant(TENANT);
    expect(proposals.map((p) => p.proposalType)).toEqual(['log_expense']);
    // The closer is production copy — not a line the harness composed.
    expect(yes.agentResponse).toBe(OPERATOR_DRAFTED_FOR_REVIEW_COPY);
    expect(bus.filterByType('proposal_created')).toHaveLength(1);
    await driver.endSession(sessionId);
  });
});
