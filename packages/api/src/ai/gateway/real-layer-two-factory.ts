/**
 * VQ2-005 — real-mode `LLMGateway` factory for Layer 2 of the Voice
 * Quality harness.
 *
 * Layer 1 always returns `CassetteLLMGateway` (record/replay). Layer 2
 * needs to actually exercise the production agent end-to-end against
 * Anthropic, but with two non-production concerns layered on:
 *
 *   1. **Per-call cost tracking.** The same `costTracker` accumulator
 *      that Whisper (VQ2-001) and TTS (VQ2-002) feed must also see LLM
 *      cents so the per-run budget cap is enforced uniformly.
 *   2. **Bus observability.** Each successful call records a
 *      `cost_incurred` event so graders can assert on cost growth
 *      without reaching into the gateway internals.
 *
 * # Mirror of production wiring
 *
 * The production `createLLMGateway` (see
 * `packages/api/src/ai/gateway/factory.ts`) builds an
 * `OpenAICompatibleProvider` (a thin wrapper over the `openai` SDK).
 * We mirror that exactly here — Anthropic exposes an OpenAI-compatible
 * endpoint at `https://api.anthropic.com/v1/`, so pointing the same
 * provider at that base URL is the most-faithful "real" mode we can
 * build without dragging the `@anthropic-ai/sdk` dependency into the
 * package. Prompt caching on Anthropic's OpenAI-compat endpoint is
 * applied automatically server-side (no client-side breakpoints to
 * configure); cached input tokens are reported via
 * `usage.prompt_tokens_details.cached_tokens` in the response, which
 * the cost wrapper reads.
 *
 * # Why a custom inner provider rather than reusing
 * `OpenAICompatibleProvider`?
 *
 * The shipping `OpenAICompatibleProvider.complete()` collapses the
 * OpenAI usage block into `{ input, output, total }` and drops the
 * `prompt_tokens_details.cached_tokens` field on the floor. We need
 * that field to apply the cache-read discount, so this module ships a
 * tiny `AnthropicCompatibleProvider` that is identical to its
 * production sibling EXCEPT it stashes `cachedInputTokens` on the
 * response so the cost wrapper can see it. When/if the production
 * provider grows a `cachedInputTokens` field, we should delete this
 * shim and reuse it.
 */
import OpenAI from 'openai';

import { LLMGateway, SYSTEM_TENANT_ID } from './gateway';
import type {
  LLMProvider,
  LLMRequest,
  LLMResponse,
  LLMGatewayConfig,
} from './gateway';
import { buildChatMessages } from '../providers/openai-compatible';
import type { AgentEventBus } from '../voice-quality/event-bus';
import { costIncurredEvent } from '../voice-quality/events';

/**
 * Anthropic Claude Haiku 4.5 pricing as of 2026-04-30.
 * Source: anthropic.com/pricing.
 *
 * Hoisted as named constants so a price update (or a model swap) is a
 * one-line change instead of a magic-number hunt across the file.
 *
 *   - input:      $3.00 / 1M tokens →   300 cents/M
 *   - output:    $15.00 / 1M tokens →  1500 cents/M
 *   - cache read: $0.30 / 1M tokens →    30 cents/M (90% discount)
 */
export const HAIKU_INPUT_CENTS_PER_MTOKEN = 300;
export const HAIKU_OUTPUT_CENTS_PER_MTOKEN = 1500;
export const HAIKU_CACHE_READ_CENTS_PER_MTOKEN = 30;

/** Production agent model. Pinned so a model bump is an explicit edit. */
export const DEFAULT_LAYER_TWO_MODEL = 'claude-haiku-4-5-20251001';

/** Anthropic's OpenAI-compatible chat-completions endpoint. */
export const ANTHROPIC_OPENAI_COMPAT_BASE_URL =
  'https://api.anthropic.com/v1/';

/**
 * Cost accumulator the wrapper feeds. Mirrors the structural shape of
 * `WhisperCostTracker` (VQ2-001) and the runner's `CostTracker` so a
 * single tracker instance can be threaded through Whisper + TTS + LLM.
 */
export interface LayerTwoCostTracker {
  addCents(n: number): void;
  totalCents(): number;
}

export interface RealLayerTwoGatewayDeps {
  apiKey: string;
  bus: AgentEventBus;
  costTracker: LayerTwoCostTracker;
  /**
   * Override model for testing. Defaults to {@link DEFAULT_LAYER_TWO_MODEL}.
   */
  model?: string;
  /** Override base URL for testing (e.g., a mock server). */
  baseUrl?: string;
}

/**
 * Creates a real-mode `LLMGateway` for Layer 2 use:
 *   - Direct Anthropic SDK calls (no cassette interception)
 *   - Prompt caching enabled (server-side on Anthropic's OpenAI-compat
 *     endpoint; cached tokens reported in usage)
 *   - Per-call cost tracking via injected `costTracker`
 *   - Emits `cost_incurred` events on the bus after each call
 *
 * Throws if `apiKey` is empty/missing — surfaces config error early
 * rather than mid-suite.
 */
export function createRealLayerTwoGateway(
  deps: RealLayerTwoGatewayDeps,
): LLMGateway {
  if (!deps.apiKey || deps.apiKey.trim() === '') {
    throw new Error(
      'createRealLayerTwoGateway: ANTHROPIC_API_KEY is required for Layer 2 real-mode gateway',
    );
  }

  const model = deps.model ?? DEFAULT_LAYER_TWO_MODEL;
  const baseURL = deps.baseUrl ?? ANTHROPIC_OPENAI_COMPAT_BASE_URL;

  const provider = new AnthropicCompatibleProvider({
    apiKey: deps.apiKey,
    baseURL,
    defaultModel: model,
  });

  const providers = new Map<string, LLMProvider>([[provider.name, provider]]);
  // P2-028: tier routing now controls model resolution. voice.agent is a
  // harness-specific taskType not in the default taskTierMapping. We configure
  // a 'system' tenant override so the caller-specified model is always used
  // for all tiers when no tenantId is set on the request (system calls default
  // to tenantId='system'). This preserves the deps.model override contract.
  const gatewayConfig: LLMGatewayConfig = {
    defaultProvider: provider.name,
    tenantOverrides: {
      [SYSTEM_TENANT_ID]: {
        tiers: {
          lightweight: { model, provider: provider.name },
          standard: { model, provider: provider.name },
          complex: { model, provider: provider.name },
        },
        taskTierMapping: {
          'voice.agent': 'lightweight',
        },
      },
    },
  };
  const baseGateway = new LLMGateway(gatewayConfig, providers);

  return wrapWithCostTracking(baseGateway, {
    bus: deps.bus,
    costTracker: deps.costTracker,
  });
}

/**
 * Wrap a gateway so every successful response computes cents from
 * token usage and adds it to the cost tracker, plus emits a
 * `cost_incurred` event. On error, no cost is tracked — failed calls
 * may still cost something, but the SDK doesn't reliably expose
 * `usage` on the error path so we can't account for it accurately.
 *
 * Implementation note: we subclass `LLMGateway` so the returned
 * value satisfies `instanceof LLMGateway`. Cassette + driver code
 * elsewhere relies on the type, not just the structural shape.
 *
 * Exported (rather than private) so the Layer 2 runner can layer a
 * per-run cost tracker on top of the suite-level gateway. The wrapper
 * is a pure decorator over `inner.complete()` — it does not depend on
 * any specific provider implementation; it only consumes the
 * `tokenUsage` shape on the response. For inner gateways that do not
 * populate `tokenUsage` (e.g., mock gateways used in unit tests), the
 * wrapper degrades to a no-op (adds 0 cents) rather than throwing.
 * This makes it safe to drop into the runner regardless of whether the
 * inner gateway is real or mocked.
 */
export function wrapWithCostTracking(
  inner: LLMGateway,
  deps: Pick<RealLayerTwoGatewayDeps, 'bus' | 'costTracker'>,
): LLMGateway {
  return new CostTrackingLayerTwoGateway(inner, deps);
}

/**
 * `LLMGateway` subclass that delegates `complete()` to an inner gateway
 * and post-processes the response to record cost. Subclassing (rather
 * than wrapping in a plain object) preserves `instanceof LLMGateway`
 * for downstream type guards.
 */
class CostTrackingLayerTwoGateway extends LLMGateway {
  constructor(
    private readonly inner: LLMGateway,
    private readonly deps: Pick<
      RealLayerTwoGatewayDeps,
      'bus' | 'costTracker'
    >,
  ) {
    // The parent constructor wants a config + providers map; we never
    // call its provider machinery (every call delegates to `inner`),
    // so a stub is sufficient. Mirrors `CassetteLLMGateway`.
    super({ defaultProvider: 'cost-tracking-passthrough' }, new Map());
  }

  override async complete(request: LLMRequest): Promise<LLMResponse> {
    const response = await this.inner.complete(request);
    // No try/catch: errors propagate upward unmodified. Cost is
    // intentionally NOT tracked on the error path (see file header).

    const inputTokens = response.tokenUsage?.input ?? 0;
    const outputTokens = response.tokenUsage?.output ?? 0;
    const cachedInputTokens = readCachedInputTokens(response);

    // Cached portion is billed at the cache rate; the remainder of
    // input tokens at the regular rate. Anthropic reports
    // `cached_tokens` as a SUBSET of `prompt_tokens`, not in addition
    // to it — so we subtract before applying the regular-input rate.
    const regularInputTokens = Math.max(inputTokens - cachedInputTokens, 0);

    const inputCents = Math.ceil(
      (regularInputTokens / 1_000_000) * HAIKU_INPUT_CENTS_PER_MTOKEN,
    );
    const outputCents = Math.ceil(
      (outputTokens / 1_000_000) * HAIKU_OUTPUT_CENTS_PER_MTOKEN,
    );
    const cacheCents = Math.ceil(
      (cachedInputTokens / 1_000_000) * HAIKU_CACHE_READ_CENTS_PER_MTOKEN,
    );
    const totalDelta = inputCents + outputCents + cacheCents;

    this.deps.costTracker.addCents(totalDelta);
    this.deps.bus.record(
      costIncurredEvent(totalDelta, this.deps.costTracker.totalCents()),
    );

    return response;
  }
}

/**
 * Read `cachedInputTokens` from a response without coupling to a
 * specific provider. The internal `AnthropicCompatibleProvider`
 * stashes the count on `tokenUsage.cachedInputTokens`; if that field
 * is absent (e.g., a different provider was wired in), default to
 * zero so cost just falls through to the regular-input rate — never
 * a NaN, never a throw.
 */
function readCachedInputTokens(response: LLMResponse): number {
  const usage = response.tokenUsage as
    | (LLMResponse['tokenUsage'] & { cachedInputTokens?: number })
    | undefined;
  return usage?.cachedInputTokens ?? 0;
}

/**
 * Anthropic-flavored variant of `OpenAICompatibleProvider` that
 * additionally surfaces `cached_tokens` from the response so the cost
 * wrapper can apply the cache-read discount. See file header for why
 * this lives here rather than in the production provider.
 */
interface AnthropicCompatibleProviderConfig {
  apiKey: string;
  baseURL: string;
  defaultModel: string;
}

class AnthropicCompatibleProvider implements LLMProvider {
  readonly name = 'anthropic-openai-compat';
  private readonly client: OpenAI;
  private readonly defaultModel: string;

  constructor(config: AnthropicCompatibleProviderConfig) {
    this.client = new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseURL,
    });
    this.defaultModel = config.defaultModel;
  }

  async complete(request: LLMRequest): Promise<LLMResponse> {
    const start = Date.now();
    const model = request.model ?? this.defaultModel;

    const completion = await this.client.chat.completions.create(
      {
        model,
        // Content may be a string or multimodal content-block array; cast at
        // the provider boundary (the gateway LLMMessage type is provider-agnostic).
        messages: request.messages as unknown as OpenAI.Chat.Completions.ChatCompletionMessageParam[],
        temperature: request.temperature ?? 0.2,
        max_tokens: request.maxTokens,
        response_format:
          request.responseFormat === 'json'
            ? { type: 'json_object' }
            : undefined,
      },
      request.signal ? { signal: request.signal } : undefined,
    );

    const choice = completion.choices?.[0];
    if (!choice?.message?.content) {
      throw new Error(
        `AnthropicCompatibleProvider: empty content for model ${model}`,
      );
    }

    const usage = completion.usage;
    const cachedInputTokens =
      usage?.prompt_tokens_details?.cached_tokens ?? 0;

    return {
      content: choice.message.content,
      model: completion.model ?? model,
      provider: this.name,
      latencyMs: Date.now() - start,
      tokenUsage: {
        input: usage?.prompt_tokens ?? 0,
        output: usage?.completion_tokens ?? 0,
        total: usage?.total_tokens ?? 0,
        // Extension field consumed by readCachedInputTokens above.
        // Cast keeps the public LLMResponse type narrow while letting
        // us pass extra info through the gateway boundary.
        ...(cachedInputTokens > 0 ? { cachedInputTokens } : {}),
      } as LLMResponse['tokenUsage'],
    };
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }
}
