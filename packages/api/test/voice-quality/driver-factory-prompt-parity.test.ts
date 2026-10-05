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
import { createMockLLMGateway } from '../../src/ai/gateway/factory';
import { makeVoiceQualityDriverFactory, ScriptAwareMockGateway } from './voice-quality-driver-factory';
import { asPhonePersona } from '../../src/ai/voice-quality/corpus/loader';

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
    // #888/#897 — a customer's line is classified on the production S1
    // 'caller' taxonomy, not the full operator prompt (~4x the tokens).
    expect(system).toContain('from an inbound customer caller');
  });

  it('#888 — the corpus mock reports classify usage sized to the real prompt, not a fixed 10 tokens', async () => {
    const bus = new AgentEventBus();
    const { gateway: inner } = createMockLLMGateway();
    const driver = makeVoiceQualityDriverFactory(script)({
      repos: makeRepoBundle('memory'),
      bus,
      gateway: new ScriptAwareMockGateway(script, inner),
      scriptId: script.id,
      tenantId: TENANT,
    });
    const { sessionId } = await driver.startSession({
      tenantId: TENANT,
      callerId: script.callerId,
      callerIdBlocked: false,
    });
    await driver.speak(sessionId, script.turns[0].caller);
    const classified = bus.filterByType('intent_classified');
    await driver.endSession(sessionId);

    // The caller-profile prompt + vertical + protection sections are ~16k
    // characters (~4k tokens at the gateway's 4-chars-per-token estimate).
    expect(classified).toHaveLength(1);
    expect(classified[0].tokenUsage.inputTokens).toBeGreaterThan(3_000);
    expect(classified[0].tokenUsage.inputTokens).toBeLessThan(9_000);
    expect(classified[0].tokenUsage.outputTokens).toBeGreaterThan(0);
  });

  it('a script that declares the operator taxonomy (D-028 follow-up) runs as the owner line and classifies on the operator prompt', async () => {
    const gateway = new RecordingGateway();
    // #1587 — the loader's phone persona turns the declaration into an owner
    // line (RV-070 ownerSession), the surface production classifies on the
    // operator taxonomy for.
    const operatorScript = asPhonePersona(
      VoiceQualityScriptSchema.parse({
        ...script,
        fixtures: { ...script.fixtures, tenant: { ...script.fixtures.tenant, harnessOperatorTaxonomy: true } },
      }),
      'gather',
    );
    expect(operatorScript.callerIsOwner).toBe(true);
    const driver = makeVoiceQualityDriverFactory(operatorScript)({
      repos: makeRepoBundle('memory'),
      bus: new AgentEventBus(),
      gateway,
      scriptId: operatorScript.id,
      tenantId: TENANT,
    });
    const { sessionId } = await driver.startSession({
      tenantId: TENANT,
      callerId: operatorScript.callerId,
      callerIdBlocked: false,
      callerIsOwner: operatorScript.callerIsOwner,
    });
    await driver.speak(sessionId, operatorScript.turns[0].caller);
    await driver.endSession(sessionId);

    const classify = gateway.requests.find((r) => r.taskType === 'classify_intent');
    const system = classify!.messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n');
    expect(system).toContain('from a field service operator');
  });
});
