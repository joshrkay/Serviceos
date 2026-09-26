/**
 * #897 — the corpus classifies with the prompt production sends.
 *
 * Production Gather always hands the classifier the tenant's vertical
 * section (the active pack's terminology), the caller's plan section when the
 * caller holds an active agreement, and the customer-protection intents.
 * The corpus driver factory wired none of them, so up to ~1.5k tokens of the
 * live prompt — and all complaint / negotiation classification — was
 * invisible to Layer 1.
 */
import { describe, it, expect } from 'vitest';
import { LLMGateway, type LLMRequest, type LLMResponse } from '../../src/ai/gateway/gateway';
import { AgentEventBus } from '../../src/ai/voice-quality/event-bus';
import { makeRepoBundle } from '../../src/ai/voice-quality/runner';
import { VoiceQualityScriptSchema } from '../../src/ai/voice-quality/schema';
import { makeVoiceQualityDriverFactory } from './voice-quality-driver-factory';

const TENANT = 't_897_parity';

class RecordingGateway extends LLMGateway {
  readonly requests: LLMRequest[] = [];
  constructor() {
    super({ defaultProvider: 'mock' }, new Map());
  }
  override async complete(request: LLMRequest): Promise<LLMResponse> {
    this.requests.push(request);
    return {
      model: 'mock',
      provider: 'mock',
      latencyMs: 1,
      tokenUsage: { input: 10, output: 10, total: 20 },
      content: JSON.stringify({ intentType: 'lookup_appointments', confidence: 0.95 }),
    };
  }
}

const script = VoiceQualityScriptSchema.parse({
  id: 'prompt-parity',
  bucket: '01-happy-lookups',
  callerId: '+15555558970',
  callerIdBlocked: false,
  fixtures: {
    tenant: { id: TENANT, display_name: 'Parity HVAC', timezone: 'America/Los_Angeles' },
    customers: [],
  },
  turns: [{ caller: 'When is my next appointment?', expected: { intent: 'lookup_appointments' } }],
  grading: { appliesFloor: [1], appliesDisposition: [9] },
});

describe('#897 — corpus driver factory prompt parity', () => {
  it('classifies with the tenant vertical section and the customer-protection intents', async () => {
    const gateway = new RecordingGateway();
    const driver = makeVoiceQualityDriverFactory(script)({
      repos: makeRepoBundle('memory'),
      bus: new AgentEventBus(),
      gateway,
      scriptId: script.id,
      tenantId: TENANT,
    });
    const { sessionId } = await driver.startSession({
      tenantId: TENANT,
      callerId: script.callerId,
      callerIdBlocked: false,
    });
    await driver.speak(sessionId, script.turns[0].caller);
    await driver.endSession(sessionId);

    const classify = gateway.requests.find((r) => r.taskType === 'classify_intent');
    expect(classify).toBeDefined();
    const system = classify!.messages
      .filter((m) => m.role === 'system')
      .map((m) => m.content)
      .join('\n');
    // The corpus tenant is an HVAC shop: the active pack's section rides the prompt.
    expect(system).toContain('Tenant vertical context');
    expect(system).toMatch(/furnace|HVAC/i);
    expect(system).toContain('Customer protection intents');
  });
});
