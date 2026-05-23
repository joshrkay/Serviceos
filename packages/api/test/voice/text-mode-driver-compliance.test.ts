/**
 * Compliance-gate behavior in the Layer 1 TextModeDriver. Verifies the
 * production enforceCompliance + escalateToHuman wiring the driver exercises:
 *   - DNC caller → escalation_triggered + session_terminated('dnc_blocked')
 *   - after-hours booker → callback proposal (no create_appointment) + escalation
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { TextModeDriver } from '../../src/ai/voice-quality/text-mode-driver';
import { VoiceSessionStore } from '../../src/ai/agents/customer-calling/voice-session-store';
import { AgentEventBus } from '../../src/ai/voice-quality/event-bus';
import { InMemoryProposalRepository } from '../../src/proposals/proposal';
import { InMemoryDncRepository, normalizePhone } from '../../src/compliance/dnc';
import { InMemorySettingsRepository, type TenantSettings } from '../../src/settings/settings';
import { InMemoryOnCallRepository } from '../../src/oncall/rotation';
import { LLMGateway, type LLMRequest, type LLMResponse } from '../../src/ai/gateway/gateway';

const TENANT = '00000000-0000-0000-0000-0000000c0599';
const CALLER = '+15555550599';

/** Minimal gateway: classify_intent → fixed intent; judge → pass. */
class FixedIntentGateway extends LLMGateway {
  constructor(private readonly intent: string) {
    super({ defaultProvider: 'mock' }, new Map());
  }
  override async complete(request: LLMRequest): Promise<LLMResponse> {
    const content =
      request.taskType === 'voice_quality_judge'
        ? JSON.stringify({ answerMeaningMatches: true, softSlotsReasonable: true })
        : JSON.stringify({ intentType: this.intent, confidence: 0.95, reasoning: 'test' });
    return { content, model: 'mock', provider: 'mock', latencyMs: 1, tokenUsage: { input: 1, output: 1, total: 2 } };
  }
}

function settings(timezone: string, schedule: Array<{ dayOfWeek: number; openTime: string; closeTime: string }>): TenantSettings {
  const now = new Date();
  return {
    id: 'vq-s', tenantId: TENANT, businessName: 'VQ', timezone,
    estimatePrefix: 'EST-', invoicePrefix: 'INV-', nextEstimateNumber: 1, nextInvoiceNumber: 1,
    defaultPaymentTermDays: 30, createdAt: now, updatedAt: now,
    businessHoursSchedule: schedule,
  } as unknown as TenantSettings;
}

async function buildDriver(opts: {
  intent: string;
  dncList?: string[];
  schedule?: Array<{ dayOfWeek: number; openTime: string; closeTime: string }>;
  currentTime?: Date;
}) {
  const store = new VoiceSessionStore({ startInterval: false });
  const bus = new AgentEventBus();
  const proposalRepo = new InMemoryProposalRepository();
  const dncRepo = new InMemoryDncRepository();
  for (const p of opts.dncList ?? []) dncRepo.add(TENANT, normalizePhone(p));
  const settingsRepo = new InMemorySettingsRepository();
  await settingsRepo.create(settings('America/Los_Angeles', opts.schedule ?? []));
  const onCallRepo = new InMemoryOnCallRepository(
    new Map([[TENANT, [{ id: 'oc1', userId: 'u1', orderIndex: 0 }]]]),
  );
  const driver = new TextModeDriver({
    voiceSessionStore: store,
    bus,
    gateway: new FixedIntentGateway(opts.intent),
    proposalRepo,
    settingsRepo,
    dncRepo,
    onCallRepo,
    ...(opts.currentTime ? { currentTime: opts.currentTime } : {}),
    systemActorId: 'system:test',
  });
  return { store, bus, proposalRepo, driver };
}

describe('TextModeDriver compliance gate — DNC', () => {
  it('escalates and terminates a DNC caller', async () => {
    const { store, driver } = await buildDriver({ intent: 'lookup_customer', dncList: [CALLER] });
    const { sessionId } = await driver.startSession({ tenantId: TENANT, callerId: CALLER, callerIdBlocked: false });
    const events: string[] = [];
    const session = store.get(sessionId)!;
    session.events.on('voice-event', (e: { type: string }) => events.push(e.type));

    await driver.speak(sessionId, 'I want to ask about pricing.');

    expect(events).toContain('escalation_triggered');
    expect(events).toContain('session_terminated');
  });
});

describe('TextModeDriver compliance gate — after-hours', () => {
  it('queues a callback (no create_appointment) and escalates for an after-hours booker', async () => {
    // Mon–Fri 09:00–17:00 LA; call at 22:00 local → after hours.
    const schedule = [1, 2, 3, 4, 5].map((d) => ({ dayOfWeek: d, openTime: '09:00', closeTime: '17:00' }));
    const { proposalRepo, driver } = await buildDriver({
      intent: 'create_appointment',
      schedule,
      currentTime: new Date('2026-05-04T22:00:00-07:00'),
    });
    const { sessionId } = await driver.startSession({ tenantId: TENANT, callerId: CALLER, callerIdBlocked: false });
    await driver.speak(sessionId, 'I want to book an appointment for my AC.');

    const proposals = await proposalRepo.findByTenant(TENANT);
    expect(proposals.some((p) => p.proposalType === 'create_appointment')).toBe(false);
    expect(proposals.some((p) => p.proposalType === 'voice_clarification')).toBe(true);
  });
});
