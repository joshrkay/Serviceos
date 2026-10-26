/**
 * GATEWAY-01 (residual) — the per-tenant token buckets sustain the live load
 * the concurrency caps are sized for.
 *
 * Before: classifier_standard refilled 1,000 tok/s (bucket 600,000) while its
 * concurrency (8) was sized for ~25 concurrent sessions. One classify call
 * costs ~5–9k tokens on a phone caller and ~17k on the operator taxonomy, so
 * ten sessions emptied the bucket in 34–145s and 74–93% of their turns were
 * rejected; acquire rejects at once, and voice files `quota_budget` as one
 * hold line, then system_failure. The `standard` bucket (500 tok/s) failed
 * the same way under the per-turn sentiment and vulnerability classifiers,
 * which swallow the rejection and score the turn 0.
 *
 * Every simulation drives the REAL stack — classifyIntent (or the real
 * sentiment / vulnerability classifiers, wired as app.ts wires them) →
 * LLMGateway → composeResilienceStack → TenantQuotaRegistry with the real
 * tier table — on a fake clock. The provider reports the real per-call cost:
 * prompt tokens = chars/4 of the assembled prompt (the live intent eval saw
 * ~15k on gpt-4o-mini for the ~15.3k chars/4 operator prompt,
 * packages/voice-eval/live-support.ts), plus a small JSON completion.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LLMGateway } from '../../../src/ai/gateway/gateway';
import type { LLMProvider, LLMRequest, LLMResponse } from '../../../src/ai/gateway/gateway';
import {
  composeResilienceStack,
  estimateRequestTokens,
} from '../../../src/ai/gateway/compose-resilience';
import {
  DEFAULT_TIER_CONFIG,
  TenantQuotaRegistry,
  estimateTokens,
  resolveQuotaTierConfig,
  type TenantQuotaTierConfig,
} from '../../../src/ai/gateway/tenant-quota';
import { DEFAULT_AI_ROUTING_CONFIG } from '../../../src/config/ai-routing';
import { CLASSIFY_TURN_INPUT_TOKEN_BUDGET } from '../../../src/ai/skills/session-cost-tracker';
import {
  classifyIntent,
  classifierUserContent,
  CUSTOMER_PROTECTION_PROMPT_SECTION,
  EXTENDED_INTENTS_PROMPT_SECTION,
  OWNER_APPROVAL_PROMPT_SECTION,
  type ClassifyContext,
} from '../../../src/ai/orchestration/intent-classifier';
import { buildClassifierSystemPrompt } from '../../../src/ai/orchestration/classifier-profile';
import { classifyTurnSentiment } from '../../../src/ai/agents/customer-calling/sentiment-classifier';
import { gradeVulnerability } from '../../../src/ai/agents/customer-calling/vulnerability-grader';
import {
  formatIntakeQuestionsForPrompt,
  formatObjectionScriptsForPrompt,
  formatVerticalForCallerPrompt,
} from '../../../src/verticals/context-assembly';
import { createHvacPack } from '../../../src/verticals/packs/hvac';

// ── Sizing basis (the same numbers tenant-quota.ts states) ──────────────────
/** One caller turn — and so one classify call — every 10s per live session. */
const TURN_INTERVAL_MS = 10_000;
/** Typical classify latency the concurrency cap is sized at (Little's law). */
const CLASSIFY_LATENCY_MS = 3_000;
/** A per-turn lightweight classifier (sentiment, vulnerability). */
const TRIAGE_LATENCY_MS = 800;
/** Completion tokens the provider reports for one classifier JSON reply. */
const CLASSIFY_OUTPUT_TOKENS = 150;
const TRIAGE_OUTPUT_TOKENS = 100;
const SIMULATED_MS = 30 * 60_000;

const TENANT = 'tenant-busy';
const HVAC_VERTICAL = (() => {
  const pack = createHvacPack();
  return [
    formatVerticalForCallerPrompt(pack),
    formatIntakeQuestionsForPrompt(pack),
    formatObjectionScriptsForPrompt(pack),
  ]
    .filter((s) => s.length > 0)
    .join('\n\n');
})();

const CALLER_UTTERANCE =
  'Hi, my AC stopped blowing cold air this morning, can someone come out tomorrow?';
const OWNER_UTTERANCE =
  'The Hendersons on Maple want their furnace looked at, put them down for Thursday morning';

/** Live telephony: S1 caller profile + customer protection + the tenant's vertical. */
const telephonyCaller: ClassifyContext = {
  tenantId: TENANT,
  classifierProfile: 'caller',
  customerProtectionIntents: true,
  verticalPromptSection: HVAC_VERTICAL,
};
/** Owner in-app chat (routes/assistant.ts): operator taxonomy + extended + approval + vertical. */
const ownerChat: ClassifyContext = {
  tenantId: TENANT,
  extendedIntents: true,
  ownerSession: true,
  verticalPromptSection: HVAC_VERTICAL,
};

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function promptTokens(req: LLMRequest): number {
  return req.messages.reduce(
    (sum, m) => sum + estimateTokens(typeof m.content === 'string' ? m.content : ''),
    0,
  );
}

const REPLIES: Record<string, string> = {
  classify_intent:
    '{"intentType":"create_appointment","confidence":0.91,"reasoning":"wants a visit","extractedEntities":{}}',
  call_sentiment: '{"frustrationScore":0.1,"reasonHint":null}',
  grade_vulnerability: '{"vulnerabilityScore":0,"urgencyTier":"none","signals":[]}',
};

/** Scripted provider: fixed latency per task, reports the real prompt cost. */
class MeteredProvider implements LLMProvider {
  readonly name = 'api.openai.com';
  calls = 0;
  inFlight = 0;
  peakInFlight = 0;
  /** Tokens the provider billed (input + output), across every call. */
  billed = 0;
  constructor(private readonly reportInputTokens: (req: LLMRequest) => number = promptTokens) {}

  async complete(req: LLMRequest): Promise<LLMResponse> {
    this.calls++;
    this.inFlight++;
    this.peakInFlight = Math.max(this.peakInFlight, this.inFlight);
    const classify = req.taskType === 'classify_intent';
    try {
      await sleep(classify ? CLASSIFY_LATENCY_MS : TRIAGE_LATENCY_MS);
    } finally {
      this.inFlight--;
    }
    const input = this.reportInputTokens(req);
    const output = classify ? CLASSIFY_OUTPUT_TOKENS : TRIAGE_OUTPUT_TOKENS;
    this.billed += input + output;
    return {
      content: REPLIES[req.taskType] ?? '{}',
      model: 'gpt-4o-mini',
      provider: this.name,
      tokenUsage: { input, output, total: input + output },
      latencyMs: classify ? CLASSIFY_LATENCY_MS : TRIAGE_LATENCY_MS,
    };
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }
}

function gatewayOver(provider: LLMProvider, tiers: Record<string, TenantQuotaTierConfig>) {
  const stack = composeResilienceStack(provider, { quota: new TenantQuotaRegistry(tiers) });
  return new LLMGateway({ defaultProvider: stack.name }, new Map([[stack.name, stack]]));
}

interface Tally {
  turns: number;
  rejections: Record<string, number>;
}

/**
 * Run each session's `turn` every TURN_INTERVAL_MS (start to start) for
 * SIMULATED_MS of fake time, sessions evenly staggered across one interval.
 * Every thrown error is tallied by its `code`.
 */
async function simulate(turns: Array<() => Promise<unknown>>): Promise<Tally> {
  const tally: Tally = { turns: 0, rejections: {} };
  const stagger = TURN_INTERVAL_MS / turns.length;
  const session = async (turn: () => Promise<unknown>, offsetMs: number) => {
    await sleep(offsetMs);
    for (let t = offsetMs; t < SIMULATED_MS; t += TURN_INTERVAL_MS) {
      const started = Date.now();
      tally.turns++;
      try {
        await turn();
      } catch (err) {
        const code = String((err as { code?: unknown }).code ?? 'uncoded');
        tally.rejections[code] = (tally.rejections[code] ?? 0) + 1;
      }
      await sleep(Math.max(0, TURN_INTERVAL_MS - (Date.now() - started)));
    }
  };
  const all = Promise.all(turns.map((turn, i) => session(turn, i * stagger)));
  await vi.advanceTimersByTimeAsync(SIMULATED_MS + 2 * TURN_INTERVAL_MS);
  await all;
  return tally;
}

const BUDGET_EXCEEDED = 'TENANT_TOKEN_BUDGET_EXCEEDED';
const CONCURRENCY_EXCEEDED = 'TENANT_CONCURRENCY_EXCEEDED';
const TURNS_PER_SESSION = SIMULATED_MS / TURN_INTERVAL_MS;

beforeEach(() => {
  // The quota registry, deadline and breaker clocks read process.hrtime.
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'hrtime', 'performance'],
  });
  // Production's classify deadline (docs/runbooks/live-ai-restore.md).
  vi.stubEnv('AI_CLASSIFY_INTENT_DEADLINE_MS', '12000');
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('GATEWAY-01 — classifier_standard sustains 10 live sessions for 30 minutes', () => {
  const cases: Array<{
    name: string;
    context: ClassifyContext;
    utterance: string;
    reportInputTokens?: (req: LLMRequest) => number;
  }> = [
    { name: 'phone callers (real assembled caller prompt)', context: telephonyCaller, utterance: CALLER_UTTERANCE },
    {
      name: 'phone callers at the per-turn input budget (CLASSIFY_TURN_INPUT_TOKEN_BUDGET)',
      context: telephonyCaller,
      utterance: CALLER_UTTERANCE,
      reportInputTokens: () => CLASSIFY_TURN_INPUT_TOKEN_BUDGET,
    },
    {
      name: 'owner chat sessions (operator taxonomy — the largest real prompt)',
      context: ownerChat,
      utterance: OWNER_UTTERANCE,
    },
  ];

  it.each(cases)('$name: no turn is budget-rejected', async ({ context, utterance, reportInputTokens }) => {
    const provider = new MeteredProvider(reportInputTokens);
    const gateway = gatewayOver(provider, resolveQuotaTierConfig({}));
    const sessions = Array.from({ length: 10 }, () => () => classifyIntent(utterance, context, gateway));

    const tally = await simulate(sessions);

    expect(tally.turns).toBe(10 * TURNS_PER_SESSION);
    expect(tally.rejections[BUDGET_EXCEEDED] ?? 0).toBe(0);
    expect(tally.rejections).toEqual({});
    // Every turn really reached the model (no deterministic short-circuit).
    expect(provider.calls).toBe(tally.turns);
  });
});

describe('GATEWAY-01 — at the sized load concurrency, not the bucket, is the binding limit', () => {
  it('25 sessions (20 phone callers at the per-turn budget + 5 owner chats) fill every slot and are never rejected', async () => {
    // Phone turns bill at the per-turn budget; chat turns at their real prompt.
    const callerSystemPrompt = buildClassifierSystemPrompt('caller');
    const provider = new MeteredProvider((req) =>
      req.messages[0]?.content === callerSystemPrompt ? CLASSIFY_TURN_INPUT_TOKEN_BUDGET : promptTokens(req),
    );
    const tiers = resolveQuotaTierConfig({});
    const gateway = gatewayOver(provider, tiers);
    const sessions = Array.from({ length: 25 }, (_, i) =>
      i % 5 === 4
        ? () => classifyIntent(OWNER_UTTERANCE, ownerChat, gateway)
        : () => classifyIntent(CALLER_UTTERANCE, telephonyCaller, gateway),
    );

    const tally = await simulate(sessions);

    expect(tally.turns).toBe(25 * TURNS_PER_SESSION);
    expect(tally.rejections).toEqual({});
    expect(provider.peakInFlight).toBe(tiers.classifier_standard.maxConcurrency);
  });
});

describe('GATEWAY-01 — AI_QUOTA_TIERS_JSON still governs the classify bucket', () => {
  it('an override back to the old 1,000 tok/s bucket reproduces the throttle', async () => {
    const tiers = resolveQuotaTierConfig({
      AI_QUOTA_TIERS_JSON: '{"classifier_standard":{"refillTokensPerSec":1000,"bucketCapacity":600000}}',
    });
    expect(tiers.classifier_standard.maxConcurrency).toBe(DEFAULT_TIER_CONFIG.classifier_standard.maxConcurrency);
    const gateway = gatewayOver(new MeteredProvider(), tiers);
    const sessions = Array.from({ length: 10 }, () => () => classifyIntent(OWNER_UTTERANCE, ownerChat, gateway));

    const tally = await simulate(sessions);

    expect(tally.rejections[BUDGET_EXCEEDED] ?? 0).toBeGreaterThan(tally.turns / 2);
    expect(tally.rejections[CONCURRENCY_EXCEEDED] ?? 0).toBe(0);
  });
});

describe('GATEWAY-01 — the standard bucket sustains the per-turn caller classifiers', () => {
  it('10 phone callers with sentiment + vulnerability triage on are never budget-rejected in 30 minutes', async () => {
    const provider = new MeteredProvider();
    const tiers = resolveQuotaTierConfig({});
    const gateway = gatewayOver(provider, tiers);
    const errors: unknown[] = [];
    // Wired exactly as app.ts wires both classifiers (one user message, the
    // tenant's top-level id). Both swallow a gateway error and return a
    // zero score, so the adapter records it before rethrowing.
    const llm = (taskType: string) => ({
      complete: async ({ prompt }: { prompt: string }) => {
        try {
          const res = await gateway.complete({
            taskType,
            tenantId: TENANT,
            messages: [{ role: 'user', content: prompt }],
          });
          return { text: res.content, tokenUsage: res.tokenUsage, model: res.model };
        } catch (err) {
          errors.push(err);
          throw err;
        }
      },
    });
    const priorTurns = [
      { role: 'caller' as const, text: 'Hi, I need someone to look at my air conditioner, it is blowing warm air.' },
      { role: 'ai' as const, text: 'I can help get that scheduled. What address is the service for?' },
      { role: 'caller' as const, text: 'It is 412 East Oakhurst Boulevard, the house on the corner.' },
      { role: 'ai' as const, text: 'Thanks. What day and time work best for you this week?' },
    ];
    const turn = async () => {
      const input = { transcript: CALLER_UTTERANCE, priorTurns, tenantId: TENANT };
      await Promise.all([
        classifyTurnSentiment({ ...input, intent: 'create_appointment' }, { llm: llm('call_sentiment') }),
        gradeVulnerability(input, { llm: llm('grade_vulnerability') }),
      ]);
    };

    const tally = await simulate(Array.from({ length: 10 }, () => turn));

    const codes = errors.map((e) => (e as { code?: string }).code);
    expect(codes.filter((c) => c === BUDGET_EXCEEDED)).toHaveLength(0);
    expect(codes).toEqual([]);
    expect(provider.calls).toBe(2 * tally.turns);
    // The per-turn classifiers of a busy tenant take at most half the refill,
    // so drafting, summaries and chat on the same bucket keep the rest.
    const billedTokPerSec = provider.billed / (SIMULATED_MS / 1000);
    expect(billedTokPerSec).toBeGreaterThan(1_000);
    expect(billedTokPerSec).toBeLessThanOrEqual(tiers.standard.refillTokensPerSec / 2);
  });
});

describe('GATEWAY-01 — classify tier sizing invariants', () => {
  const classifyTiers = ['classifier_standard', 'classifier_premium'] as const;
  /** Most output one classify call can bill: the lightweight tier's maxTokens. */
  const classifyOutputCeiling = DEFAULT_AI_ROUTING_CONFIG.tiers.lightweight.maxTokens ?? 0;
  /** The largest real classify admission: the owner-chat prompt (+ maxTokens). */
  const largestAdmission = estimateRequestTokens({
    taskType: 'classify_intent',
    maxTokens: classifyOutputCeiling,
    messages: [
      ...[
        buildClassifierSystemPrompt('operator'),
        `Tenant vertical context (use ONLY for entity recognition; do not change the JSON output schema):\n${HVAC_VERTICAL}`,
        OWNER_APPROVAL_PROMPT_SECTION,
        CUSTOMER_PROTECTION_PROMPT_SECTION,
        EXTENDED_INTENTS_PROMPT_SECTION,
      ].map((content) => ({ role: 'system' as const, content })),
      { role: 'user' as const, content: classifierUserContent(OWNER_UTTERANCE, 'operator') },
    ],
  });

  it('the largest real classify call is what this file assumes (~15–20k tokens)', () => {
    expect(classifyOutputCeiling).toBeGreaterThan(0);
    expect(largestAdmission).toBeGreaterThan(15_000);
    expect(largestAdmission).toBeLessThan(20_000);
  });

  it.each(classifyTiers)(
    '%s: refill covers the throughput its concurrency is sized for, at the per-turn budget',
    (tier) => {
      const cfg = DEFAULT_TIER_CONFIG[tier];
      // Little's law: maxConcurrency slots at the sizing latency complete
      // maxConcurrency / latency calls per second, each billing at most the
      // per-turn input budget plus the output ceiling.
      const sizedCallsPerSec = cfg.maxConcurrency / (CLASSIFY_LATENCY_MS / 1000);
      const sizedTokPerSec = sizedCallsPerSec * (CLASSIFY_TURN_INPUT_TOKEN_BUDGET + classifyOutputCeiling);
      expect(cfg.refillTokensPerSec).toBeGreaterThanOrEqual(sizedTokPerSec);
      // Equivalently, at a turn every TURN_INTERVAL_MS: the sessions it carries.
      const sessions = (cfg.refillTokensPerSec * (TURN_INTERVAL_MS / 1000)) /
        (CLASSIFY_TURN_INPUT_TOKEN_BUDGET + classifyOutputCeiling);
      expect(sessions).toBeGreaterThanOrEqual(cfg.maxConcurrency * (TURN_INTERVAL_MS / CLASSIFY_LATENCY_MS));
    },
  );

  it.each(classifyTiers)(
    '%s: a cold burst of maxConcurrency of the largest calls fits both the bucket and the hard bound',
    (tier) => {
      const cfg = DEFAULT_TIER_CONFIG[tier];
      expect(cfg.bucketCapacity).toBeGreaterThanOrEqual(cfg.maxConcurrency * largestAdmission);
      expect(cfg.hardUpperBoundTokens).toBeGreaterThanOrEqual(cfg.maxConcurrency * largestAdmission);
    },
  );

  it('premium tiers are never below standard on any limit (a plan → tier resolver can only raise)', () => {
    const fields: Array<keyof TenantQuotaTierConfig> = [
      'maxConcurrency',
      'bucketCapacity',
      'refillTokensPerSec',
      'hardUpperBoundTokens',
    ];
    for (const [lo, hi] of [
      ['standard', 'premium'],
      ['classifier_standard', 'classifier_premium'],
    ] as const) {
      for (const f of fields) {
        expect(DEFAULT_TIER_CONFIG[hi][f], `${hi}.${f} >= ${lo}.${f}`).toBeGreaterThanOrEqual(
          DEFAULT_TIER_CONFIG[lo][f],
        );
      }
    }
  });
});
