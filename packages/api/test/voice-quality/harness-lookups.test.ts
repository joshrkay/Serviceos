/**
 * #1395 — the voice-quality harnesses' shared `lookups` bundle.
 *
 * Layer 2 drives the media-streams `speechTurn`; before #1395 it built its
 * processor with no `lookups` bundle, so every lookup script would hear
 * LOOKUP_UNAVAILABLE_LINE once the media-streams branch opened. This pins
 * the one-line wiring both harnesses use: a processor built the way Layer 2
 * builds it, plus `lookups: buildHarnessPhoneLookups(repos)`, answers a
 * caller's lookup from the runner's seeded repos.
 */
import { describe, it, expect, vi } from 'vitest';

import { createVoiceTurnProcessor } from '../../src/ai/voice-turn';
import { VoiceSessionStore } from '../../src/ai/agents/customer-calling/voice-session-store';
import { makeRepoBundle } from '../../src/ai/voice-quality/runner';
import { buildHarnessPhoneLookups } from '../../src/ai/voice-quality/harness-lookups';
import { LOOKUP_UNAVAILABLE_LINE } from '../../src/ai/voice-turn/phone-lookup-surface';
import type { LLMGateway, LLMResponse } from '../../src/ai/gateway/gateway';
import type { SideEffect } from '../../src/ai/agents/customer-calling/types';

const TENANT = 'tenant-vq-lookups';
const CUSTOMER_ID = '33333333-3333-4333-8333-333333333333';

function gatewayClassifying(intentType: string): LLMGateway {
  const response = {
    content: JSON.stringify({
      intentType,
      confidence: 0.96,
      reasoning: 'harness lookups',
      extractedEntities: {},
    }),
    model: 'stub',
    provider: 'stub',
    tokenUsage: { input: 1, output: 1, total: 2 },
    latencyMs: 1,
  } as unknown as LLMResponse;
  return { complete: vi.fn(async () => response) } as unknown as LLMGateway;
}

const lookupLines = (fx: SideEffect[]) =>
  fx
    .filter((f) => f.type === 'tts_play' && (f.payload as { source?: string }).source === 'lookup_skill')
    .map((f) => String((f.payload as { text?: string }).text ?? ''));

describe('buildHarnessPhoneLookups — the harness lookups bundle', () => {
  it('a media-streams speechTurn wired with it answers the caller\'s lookup from the seeded repos', async () => {
    const repos = makeRepoBundle('memory');
    await repos.jobRepo.create({
      id: '44444444-4444-4444-8444-444444444444',
      tenantId: TENANT,
      customerId: CUSTOMER_ID,
      locationId: '55555555-5555-4555-8555-555555555555',
      jobNumber: 'JOB-1042',
      summary: 'Kitchen faucet replacement',
      status: 'scheduled',
      priority: 'normal',
      createdBy: 'u1',
      createdAt: new Date(),
      updatedAt: new Date(),
    } as never);

    const store = new VoiceSessionStore({ startInterval: false });
    const processor = createVoiceTurnProcessor({
      store,
      gateway: gatewayClassifying('lookup_jobs'),
      auditRepo: repos.auditRepo,
      proposalRepo: repos.proposalRepo,
      customerRepo: repos.customerRepo,
      appointmentRepo: repos.appointmentRepo,
      jobRepo: repos.jobRepo,
      businessName: 'Test Tenant',
      systemActorId: 'voice-quality-layer2',
      lookups: buildHarnessPhoneLookups(repos),
    });
    const callSid = 'CA-vq-lookups';
    const session = store.create(TENANT, 'telephony', { callSid });
    session.machine.dispatch({
      type: 'incoming_call',
      tenantId: TENANT,
      callSid,
      from: '+15125550111',
      to: '+15125550000',
    });
    session.machine.dispatch({ type: 'greeted_ok' });
    session.machine.dispatch({ type: 'caller_known', customerId: CUSTOMER_ID });
    session.customerId = CUSTOMER_ID;

    const fx = await processor.speechTurn({
      session,
      speechResult: "what's happening with my job",
      callSid,
      tenantId: TENANT,
    });

    const lines = lookupLines(fx);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('Kitchen faucet replacement');
    expect(lines[0]).not.toBe(LOOKUP_UNAVAILABLE_LINE);
  });
});
