import OpenAI from 'openai';
import type { LLMProvider, LLMRequest, LLMResponse, LLMMessage } from '../gateway/gateway';
import { EmptyProviderResponseError, ProviderRateLimitError } from '../gateway/retry';

type OpenAIChatMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;
type OpenAIContentPart = OpenAI.Chat.Completions.ChatCompletionContentPart;

/**
 * OpenAI rejects `response_format: { type: 'json_object' }` outright unless the
 * outbound messages mention "json" somewhere:
 *
 *   400 'messages' must contain the word 'json' in some form, to use
 *       'response_format' of type 'json_object'
 *
 * The rejection lands BEFORE any tokens are generated, so a caller that forgets
 * the word fails 100% of the time — and a caller that swallows the error as an
 * advisory skip (as the supervisor annotator sweep did) re-issues the same
 * doomed request on every tick, burning the tenant's AI quota with nothing to
 * show for it. This helper closes that hole at the ONE point where
 * `responseFormat: 'json'` is translated into the provider parameter, so no
 * present or future gateway caller can reintroduce the bug.
 *
 * Deliberately case-insensitive and `parts`-aware: the precondition is
 * satisfied by any mention, in any message, in either the plain `content` or a
 * text content part.
 */
export function messagesMentionJson(messages: LLMMessage[]): boolean {
  return messages.some((message) => {
    if (typeof message.content === 'string' && message.content.toLowerCase().includes('json')) {
      return true;
    }
    return (
      Array.isArray(message.parts) &&
      message.parts.some(
        (part) =>
          part != null &&
          part.type === 'text' &&
          typeof part.text === 'string' &&
          part.text.toLowerCase().includes('json'),
      )
    );
  });
}

/**
 * Minimal instruction injected only when a JSON-mode request would otherwise be
 * rejected. Intentionally says nothing about SHAPE — the caller's own prompt
 * owns the schema; this exists purely to satisfy the provider precondition.
 */
export const JSON_MODE_SYSTEM_INSTRUCTION =
  'Respond with a single valid JSON object and nothing else.';

/**
 * Guard for the JSON-mode precondition. Chosen remedy is INJECTION rather than
 * throwing in development, because a dev-only throw would convert a silent
 * production 400 into a loud crash only on the paths that are already broken,
 * while leaving production just as broken; injecting makes the request VALID,
 * which is what the caller asked for by setting `responseFormat: 'json'`.
 *
 * Cannot silently change behaviour for callers that already work: when the word
 * is already present this returns the SAME ARRAY BY REFERENCE, so those
 * requests stay byte-identical (load-bearing here — cassette hashes and the
 * gateway cache key are derived from message content). Injection also happens
 * inside the adapter, i.e. downstream of the gateway's cache-key computation,
 * so it cannot perturb cache identity either.
 */
export function ensureJsonModeMessages(messages: LLMMessage[]): LLMMessage[] {
  if (messagesMentionJson(messages)) return messages;
  return [{ role: 'system', content: JSON_MODE_SYSTEM_INSTRUCTION }, ...messages];
}

/**
 * Translate gateway messages to the OpenAI chat format. Messages without
 * `parts` pass through as plain string content (the text path is unchanged);
 * messages with `parts` become an ordered content-part array — the message's
 * text first, then each part. The provider-neutral `image` part maps to the
 * OpenAI `image_url` shape. Pure + exported for unit testing.
 */
export function buildChatMessages(messages: LLMMessage[]): OpenAIChatMessage[] {
  return messages.map((message): OpenAIChatMessage => {
    if (!message.parts || message.parts.length === 0) {
      return { role: message.role, content: message.content } as OpenAIChatMessage;
    }
    const content: OpenAIContentPart[] = [];
    if (message.content) {
      content.push({ type: 'text', text: message.content });
    }
    for (const part of message.parts) {
      if (part.type === 'text') {
        content.push({ type: 'text', text: part.text });
      } else {
        content.push({
          type: 'image_url',
          image_url: {
            url: part.url,
            ...(part.detail ? { detail: part.detail } : {}),
          },
        });
      }
    }
    return { role: message.role, content } as OpenAIChatMessage;
  });
}

export interface OpenAICompatibleConfig {
  apiKey: string;
  baseURL: string;
  /** Optional extra headers — required by some providers (e.g. OpenRouter) */
  defaultHeaders?: Record<string, string>;
  /** Timeout in ms, default 60_000 */
  timeout?: number;
  /** Escape hatch for tests; see {@link PROVIDER_SDK_MAX_RETRIES}. */
  maxRetries?: number;
}

/**
 * The OpenAI SDK must NOT retry on its own. Keep this 0.
 *
 * The SDK's built-in retry loop (`maxRetries`, default **2**) obeys the
 * provider's `retry-after` by calling a bare, non-cancellable
 * `sleep(timeoutMillis)` (openai/core.js → `retryRequest`). That sleep does
 * not observe the `AbortSignal` we hand it, so it runs *outside* our
 * `DeadlineContext` entirely.
 *
 * That is the whole 17.4s of the 2026-07-27 incident. With the org's daily
 * request quota spent, OpenAI answered in ~0.3s with
 * `429 rate_limit_exceeded / requests … Please try again in 8.64s`:
 *
 *   attempt 1  →  429 at ~0.3s   → SDK sleeps 8.64s (uncancellable)
 *   attempt 2  →  429            → SDK sleeps 8.64s (uncancellable)
 *   [our 12s classify_intent deadline fires at 12.0s — nobody is listening]
 *   attempt 3  →  starts at ~17.4s, sees `options.signal.aborted`
 *                 → throws APIUserAbortError('Request was aborted.')
 *
 * 2 × 8.64s = 17.28s + request overhead ≈ the 17401/17412/17415/17425/17441/
 * 17479 ms rows in `ai_runs`, and the ~78ms spread across six runs is the
 * giveaway that the waits were a fixed provider-supplied value, not the SDK's
 * jittered default backoff. Our resilience layer never saw the 429 at all —
 * only an abort — which is why it reported "All providers failed. Last error:
 * Request was aborted."
 *
 * Retry is `runWithRetry`'s job (gateway/retry.ts): it is deadline-aware, it
 * honours `retry-after` only when the wait actually fits, and it fails fast
 * otherwise.
 */
export const PROVIDER_SDK_MAX_RETRIES = 0;

/**
 * Case-insensitive read from either a plain header bag (what the OpenAI SDK
 * attaches to `APIError.headers`) or a `Headers` instance.
 */
function headerValue(headers: unknown, name: string): string | undefined {
  if (!headers || typeof headers !== 'object') return undefined;
  const get = (headers as { get?: unknown }).get;
  if (typeof get === 'function') {
    const via = (headers as Headers).get(name);
    if (typeof via === 'string' && via.length > 0) return via;
    return undefined;
  }
  const bag = headers as Record<string, unknown>;
  const wanted = name.toLowerCase();
  // The SDK's own bag is already lowercased, but a hand-rolled fetch adapter
  // (or a test fixture) may not be — match on lowercase either way.
  let raw = bag[wanted];
  if (raw === undefined) {
    for (const key of Object.keys(bag)) {
      if (key.toLowerCase() === wanted) {
        raw = bag[key];
        break;
      }
    }
  }
  return typeof raw === 'string' && raw.length > 0 ? raw : undefined;
}

/**
 * Parse OpenAI's `x-ratelimit-reset-*` duration format: a concatenation of
 * magnitude+unit segments, e.g. `8.64s`, `230ms`, `6m0s`, `1h2m3s`.
 * `ms` is matched before `m`/`s` so `230ms` is not read as 230 minutes.
 */
export function parseRateLimitResetMs(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const re = /(\d+(?:\.\d+)?)(ms|h|m|s)/g;
  const unitMs: Record<string, number> = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 };
  let total = 0;
  let matched = false;
  for (const m of raw.trim().toLowerCase().matchAll(re)) {
    total += Number.parseFloat(m[1]) * unitMs[m[2]];
    matched = true;
  }
  if (!matched || !Number.isFinite(total) || total < 0) return undefined;
  return Math.round(total);
}

/**
 * Extract a wait hint in ms from a throttled response's headers.
 *
 * Precedence mirrors what the provider actually means, most explicit first:
 *   1. `retry-after-ms`  — OpenAI's millisecond-precision hint (this is the
 *                          header that produced the observed 8.64s waits).
 *   2. `retry-after`     — RFC 7231: delta-seconds or an HTTP-date.
 *   3. `x-ratelimit-reset-requests` / `-tokens` — when the reset window is all
 *                          the provider offers.
 *
 * Same job as `parseRetryAfterSeconds` in
 * `notifications/twilio-delivery-provider.ts`, at ms resolution.
 */
export function parseProviderRetryAfterMs(headers: unknown): number | undefined {
  const ms = headerValue(headers, 'retry-after-ms');
  if (ms) {
    const parsed = Number.parseFloat(ms);
    if (Number.isFinite(parsed) && parsed >= 0) return Math.round(parsed);
  }

  const retryAfter = headerValue(headers, 'retry-after');
  if (retryAfter) {
    const seconds = Number.parseFloat(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1_000);
    const asDate = Date.parse(retryAfter);
    if (Number.isFinite(asDate)) return Math.max(0, asDate - Date.now());
  }

  return (
    parseRateLimitResetMs(headerValue(headers, 'x-ratelimit-reset-requests')) ??
    parseRateLimitResetMs(headerValue(headers, 'x-ratelimit-reset-tokens'))
  );
}

/**
 * Turn a raw provider error into a typed one the resilience layer can reason
 * about, preserving the provider's own type/code/message rather than
 * flattening it.
 *
 * Only 429 needs normalizing today:
 *   - 401/403 already carry `status`, so `classifyError` → 'permanent' and
 *     `isFailoverEligible` → false: they fail fast and loudly with the
 *     provider's own "Incorrect API key provided…" text. Nothing to fix.
 *   - 5xx already carry `status`, so `classifyError` → 'transient': retried
 *     with jittered backoff inside the deadline. Nothing to fix.
 *   - 429 was the broken one: the SDK never let it out (see
 *     {@link PROVIDER_SDK_MAX_RETRIES}), and even when it did, nothing read
 *     `retry-after`.
 *
 * Exported for unit testing.
 */
export function normalizeProviderError(err: unknown, providerName: string): unknown {
  if (!err || typeof err !== 'object') return err;
  const status = (err as { status?: unknown }).status;
  if (status !== 429) return err;
  if (err instanceof ProviderRateLimitError) return err;

  const e = err as {
    headers?: unknown;
    message?: unknown;
    type?: unknown;
    code?: unknown;
  };
  const providerMessage =
    typeof e.message === 'string' && e.message.length > 0
      ? e.message
      : `Provider ${providerName} rate limited (HTTP 429)`;

  return new ProviderRateLimitError({
    providerName,
    providerMessage,
    retryAfterMs: parseProviderRetryAfterMs(e.headers),
    providerErrorType: typeof e.type === 'string' ? e.type : undefined,
    providerErrorCode: typeof e.code === 'string' ? e.code : undefined,
  });
}

/**
 * Embedding surface used by the RAG corpus (Phase 1 of the inbound-CSR
 * training-data architecture). Locked to `text-embedding-3-small`
 * (1536 dims) at the schema level via the CHECK constraint on
 * `knowledge_chunks.embedding_model`; mixing models in the same ivfflat
 * index would silently degrade retrieval quality because cosine
 * distances aren't comparable across models.
 */
export interface EmbeddingProvider {
  readonly name: string;
  createEmbedding(input: string): Promise<EmbeddingResult>;
}

export interface EmbeddingResult {
  embedding: number[];
  model: string;
  /** Total tokens billed by the provider for this request. */
  tokenUsage: number;
  latencyMs: number;
}

const DEFAULT_EMBEDDING_MODEL = 'text-embedding-3-small';
const EXPECTED_EMBEDDING_DIMS = 1536;

export class OpenAICompatibleProvider implements LLMProvider, EmbeddingProvider {
  readonly name: string;
  private readonly client: OpenAI;

  constructor(config: OpenAICompatibleConfig) {
    this.client = new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseURL,
      defaultHeaders: config.defaultHeaders,
      timeout: config.timeout ?? 60_000,
      // Deliberate: the SDK's own retry sleeps outside our deadline.
      // See PROVIDER_SDK_MAX_RETRIES above — this is the 17.4s fix.
      maxRetries: config.maxRetries ?? PROVIDER_SDK_MAX_RETRIES,
    });

    // Derive a friendly name from the baseURL for logs
    try {
      this.name = new URL(config.baseURL).hostname;
    } catch {
      this.name = 'openai-compatible';
    }
  }

  /**
   * Single-input embedding call. The OpenAI embeddings endpoint accepts
   * arrays for batching; we expose a single-string surface for now and
   * let callers loop. Batching can be added when ingestion volume
   * warrants it (Phase 4a metric — embedding tokens per minute).
   */
  async createEmbedding(input: string): Promise<EmbeddingResult> {
    if (input.length === 0) {
      throw new Error('createEmbedding: input must be non-empty');
    }
    const start = Date.now();
    const response = await this.client.embeddings.create({
      model: DEFAULT_EMBEDDING_MODEL,
      input,
    });
    const datum = response.data[0];
    if (!datum) {
      throw new Error(`Provider ${this.name} returned no embedding data`);
    }
    const embedding = datum.embedding;
    if (embedding.length !== EXPECTED_EMBEDDING_DIMS) {
      // Fail loud rather than silently inserting a vector that breaks
      // the schema CHECK constraint at INSERT time.
      throw new Error(
        `Provider ${this.name} returned ${embedding.length}-dim embedding; expected ${EXPECTED_EMBEDDING_DIMS} for ${DEFAULT_EMBEDDING_MODEL}`,
      );
    }
    return {
      embedding,
      model: response.model ?? DEFAULT_EMBEDDING_MODEL,
      tokenUsage: response.usage?.total_tokens ?? 0,
      latencyMs: Date.now() - start,
    };
  }

  async complete(request: LLMRequest): Promise<LLMResponse> {
    const start = Date.now();
    const model = request.model ?? 'gpt-4o-mini';

    // Honor the resilience-layer signal so deadline expiry / breaker abort
    // tears down the in-flight HTTP request instead of leaving a zombie.
    let completion: OpenAI.Chat.Completions.ChatCompletion;
    try {
      completion = await this.client.chat.completions.create(
        {
          model,
          // Translate gateway messages (text + optional multimodal parts) to the
          // OpenAI chat format via the shared pure helper. `ensureJsonModeMessages`
          // is a strict no-op unless this is a JSON-mode request whose messages
          // would trip OpenAI's "must contain the word 'json'" precondition.
          messages: buildChatMessages(
            request.responseFormat === 'json'
              ? ensureJsonModeMessages(request.messages)
              : request.messages,
          ),
          temperature: request.temperature ?? 0.2,
          max_tokens: request.maxTokens,
          response_format:
            request.responseFormat === 'json' ? { type: 'json_object' } : undefined,
        },
        request.signal ? { signal: request.signal } : undefined,
      );
    } catch (err) {
      // A 429 becomes a typed ProviderRateLimitError carrying the provider's
      // own error type/code/message plus the parsed retry-after, so the
      // resilience layer can tell "throttled, come back in 8.6s" from "the
      // provider is down". Every other status passes through untouched.
      throw normalizeProviderError(err, this.name);
    }

    const choice = completion.choices[0];
    if (!choice?.message?.content) {
      // VOX-32: empty/malformed output is a transient LLM hiccup, not a
      // permanent failure. Throw a typed error so classifyError marks it
      // 'transient' and runWithRetry retries it within the deadline (a bare
      // Error has no .status and would fall through to 'permanent' → no retry).
      // KNOWN LIMITATION (separately tracked): with a single configured provider
      // the failover list is always empty, so in-deadline retry is the only
      // recovery path here — there is no cross-provider failover for this yet.
      throw new EmptyProviderResponseError(
        `Provider ${this.name} returned empty content for model ${model}`,
      );
    }

    const usage = completion.usage;
    return {
      content: choice.message.content,
      model: completion.model ?? model,
      provider: this.name,
      latencyMs: Date.now() - start,
      tokenUsage: {
        input: usage?.prompt_tokens ?? 0,
        output: usage?.completion_tokens ?? 0,
        total: usage?.total_tokens ?? 0,
      },
    };
  }

  async isAvailable(): Promise<boolean> {
    try {
      await this.client.models.list();
      return true;
    } catch {
      return false;
    }
  }
}
