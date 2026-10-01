/**
 * #1331 — the inbound engine resolves spoken times against an injectable
 * clock. The voice-quality corpus is authored in a fixed world (the Layer 1
 * harness pins 2026-05-01T12:00Z); Layer 2 drives this processor with the
 * wall clock, so "next Tuesday at 2pm" could never land on the expected
 * instant. `now` is the same seam `resolveSchedulingEntities` already has
 * (SchedulingResolutionOptions.now), threaded from the processor deps.
 */
import { describe, it, expect, vi } from 'vitest';
import { createVoiceTurnProcessor } from '../../../src/ai/voice-turn';
import { VoiceSessionStore } from '../../../src/ai/agents/customer-calling/voice-session-store';
import { InMemoryProposalRepository } from '../../../src/proposals/proposal';
import { InMemorySettingsRepository } from '../../../src/settings/settings';
import type { LLMGateway, LLMResponse } from '../../../src/ai/gateway/gateway';

const TENANT = 'tenant-clock-1331';
const CUSTOMER_ID = '22222222-3333-4444-5555-666666666666';

function gatewaySequence(contents: string[]): LLMGateway {
  let i = 0;
  return {
    complete: vi.fn(async () => ({
      content: contents[Math.min(i++, contents.length - 1)],
      model: 'mock',
      provider: 'mock',
      tokenUsage: { input: 8, output: 8, total: 16 },
      latencyMs: 1,
    } satisfies LLMResponse)),
  } as unknown as LLMGateway;
}

describe('#1331 — speechTurn resolves spoken times on the injected clock', () => {
  it('books "Tuesday at 2pm" for the Tuesday after the pinned now, in the tenant zone', async () => {
    const store = new VoiceSessionStore({ startInterval: false });
    const proposalRepo = new InMemoryProposalRepository();
    const settingsRepo = new InMemorySettingsRepository();
    await settingsRepo.create({
      id: 'settings-clock',
      tenantId: TENANT,
      businessName: 'Clock HVAC',
      timezone: 'America/Los_Angeles',
      createdAt: new Date(),
      updatedAt: new Date(),
    } as unknown as Parameters<InMemorySettingsRepository['create']>[0]);

    const session = store.create(TENANT, 'telephony', { callSid: 'CA-clock-1' });
    session.machine.dispatch({ type: 'incoming_call', callSid: 'CA-clock-1', from: '+15125550100', to: '+15125550999', tenantId: TENANT });
    session.machine.dispatch({ type: 'greeted_ok' });
    session.machine.dispatch({ type: 'caller_known', customerId: CUSTOMER_ID });
    session.customerId = CUSTOMER_ID;

    const processor = createVoiceTurnProcessor({
      store,
      gateway: gatewaySequence([
        JSON.stringify({
          intentType: 'create_appointment',
          confidence: 0.92,
          reasoning: 'booking',
          extractedEntities: { dateTimeDescription: 'Tuesday at 2pm' },
        }),
        JSON.stringify({ answer: 'yes', reasoning: 'confirmed' }),
      ]),
      businessName: 'Clock HVAC',
      systemActorId: 'calling-agent',
      proposalRepo,
      settingsRepo,
      // Friday 2026-05-01, 05:00 in Los Angeles.
      now: () => new Date('2026-05-01T12:00:00.000Z'),
    });

    await processor.speechTurn({ session, speechResult: 'Can you come Tuesday at 2pm?', callSid: 'CA-clock-1', tenantId: TENANT });
    await processor.speechTurn({ session, speechResult: "Yes, that's right.", callSid: 'CA-clock-1', tenantId: TENANT });

    const [booking] = await proposalRepo.findByTenant(TENANT);
    // Tuesday 2026-05-05 14:00 PDT (UTC-7) = 21:00Z.
    expect((booking!.payload as Record<string, unknown>).scheduledStart).toBe('2026-05-05T21:00:00.000Z');
  });
});
