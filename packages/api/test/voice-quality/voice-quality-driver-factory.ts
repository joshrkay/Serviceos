/**
 * Shared driver factory for the Layer 1 corpus runner.
 *
 * Wires `CassetteLLMGateway` around a script-aware mock LLM so CI can
 * replay deterministic cassettes without live API keys. Record/refresh
 * modes pass through to the same mock for `npm run voice-quality:record`.
 */
import type { LLMRequest, LLMResponse } from '../../src/ai/gateway/gateway';
import { LLMGateway } from '../../src/ai/gateway/gateway';
import { createMockLLMGateway } from '../../src/ai/gateway/factory';
import { VoiceSessionStore } from '../../src/ai/agents/customer-calling/voice-session-store';
import {
  CassetteLLMGateway,
  cassetteModeFromEnv,
  defaultCassettesDir,
  type CassetteMode,
} from '../../src/ai/voice-quality/cassette-gateway';
import { TextModeDriver, type AgentDriver } from '../../src/ai/voice-quality/text-mode-driver';
import type { DriverFactoryContext } from '../../src/ai/voice-quality/runner';
import type { VoiceQualityScript } from '../../src/ai/voice-quality/schema';

const JUDGE_PASS_JSON = JSON.stringify({
  answerMeaningMatches: true,
  softSlotsReasonable: true,
  rationale: 'vq mock judge pass',
});

/** Extract a display name from common signup phrasing in corpus scripts. */
function displayNameFromCaller(caller: string): string | undefined {
  const m = caller.match(
    /\b(?:name is|i am|i'm|this is)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)/i,
  );
  return m?.[1]?.trim();
}

function classifierJsonForTurn(script: VoiceQualityScript, turnIndex: number): string {
  const turn = script.turns[turnIndex];
  const intent = turn.expected.intent ?? 'unknown';
  const entities: Record<string, string> = {};
  if (intent === 'create_customer') {
    const name = displayNameFromCaller(turn.caller);
    if (name) entities.displayName = name;
    if (script.callerId) entities.phone = script.callerId;
  }
  return JSON.stringify({
    intentType: intent,
    confidence: 0.95,
    reasoning: 'voice-quality mock classifier',
    ...(Object.keys(entities).length > 0 ? { extractedEntities: entities } : {}),
  });
}

/**
 * Mock gateway that returns script-appropriate classifier + judge JSON.
 * Used as the "real" gateway inside `CassetteLLMGateway` record mode.
 */
export class ScriptAwareMockGateway extends LLMGateway {
  constructor(
    private readonly script: VoiceQualityScript,
    private readonly inner: LLMGateway,
  ) {
    super({ defaultProvider: 'mock' }, new Map());
  }

  override async complete(request: LLMRequest): Promise<LLMResponse> {
    if (request.taskType === 'voice_quality_judge') {
      return {
        content: JUDGE_PASS_JSON,
        model: 'mock-model',
        provider: 'mock',
        latencyMs: 1,
        tokenUsage: { input: 10, output: 10, total: 20 },
      };
    }

    if (request.taskType === 'classify_intent') {
      const userLine = request.messages.find((m) => m.role === 'user')?.content ?? '';
      const turnIndex = this.script.turns.findIndex(
        (t) => userLine.includes(t.caller) || t.caller.includes(userLine),
      );
      const idx = turnIndex >= 0 ? turnIndex : 0;
      return {
        content: classifierJsonForTurn(this.script, idx),
        model: request.model ?? 'mock-model',
        provider: 'mock',
        latencyMs: 1,
        tokenUsage: { input: 10, output: 10, total: 20 },
      };
    }

    return this.inner.complete(request);
  }
}

export function buildCassetteGatewayForScript(
  script: VoiceQualityScript,
  mode?: CassetteMode,
): LLMGateway {
  const { gateway: inner } = createMockLLMGateway();
  const realGateway = new ScriptAwareMockGateway(script, inner);
  return new CassetteLLMGateway({
    scriptId: script.id,
    cassettesDir: defaultCassettesDir(),
    mode: mode ?? cassetteModeFromEnv(),
    realGateway,
  });
}

export function makeVoiceQualityDriverFactory(
  script: VoiceQualityScript,
  cassetteMode?: CassetteMode,
): (fctx: DriverFactoryContext) => AgentDriver {
  return (fctx) => {
    const store = new VoiceSessionStore({ startInterval: false });
    const gateway =
      fctx.gateway ?? buildCassetteGatewayForScript(script, cassetteMode);

    const driver = new TextModeDriver({
      voiceSessionStore: store,
      bus: fctx.bus,
      gateway,
      proposalRepo: fctx.repos.proposalRepo,
      customerRepo: fctx.repos.customerRepo,
      appointmentRepo: fctx.repos.appointmentRepo,
      invoiceRepo: fctx.repos.invoiceRepo,
      estimateRepo: fctx.repos.estimateRepo,
      jobRepo: fctx.repos.jobRepo,
      leadRepo: fctx.repos.leadRepo,
      auditRepo: fctx.repos.auditRepo,
      systemActorId: 'system:vq-corpus',
    });

    const firstCustomer = script.fixtures.customers?.[0] as { id?: string } | undefined;
    const customerId = firstCustomer?.id;

    return {
      startSession: async (opts) => {
        const r = await driver.startSession(opts);
        if (customerId) {
          const session = store.get(r.sessionId);
          if (session) session.customerId = customerId;
        }
        return r;
      },
      speak: (sid, t) => driver.speak(sid, t),
      hangup: (sid) => driver.hangup(sid),
      endSession: async (sid) => {
        await driver.endSession(sid);
        store.dispose();
      },
    };
  };
}
