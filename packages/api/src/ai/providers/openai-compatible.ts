import OpenAI from 'openai';
import type { LLMProvider, LLMRequest, LLMResponse, LLMMessage } from '../gateway/gateway';

type OpenAIChatMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;
type OpenAIContentPart = OpenAI.Chat.Completions.ChatCompletionContentPart;

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
    const completion = await this.client.chat.completions.create(
      {
        model,
        // Translate gateway messages (text + optional multimodal parts) to the
        // OpenAI chat format via the shared pure helper.
        messages: buildChatMessages(request.messages),
        temperature: request.temperature ?? 0.2,
        max_tokens: request.maxTokens,
        response_format:
          request.responseFormat === 'json' ? { type: 'json_object' } : undefined,
      },
      request.signal ? { signal: request.signal } : undefined,
    );

    const choice = completion.choices[0];
    if (!choice?.message?.content) {
      throw new Error(`Provider ${this.name} returned empty content for model ${model}`);
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
