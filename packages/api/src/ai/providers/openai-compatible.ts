import OpenAI from 'openai';
import type { LLMProvider, ChatMessage, ChatResponse } from '../gateway/types';

export interface OpenAICompatibleConfig {
  apiKey: string;
  baseURL: string;
  /** Optional extra headers — required by some providers (e.g. OpenRouter) */
  defaultHeaders?: Record<string, string>;
  /** Timeout in ms, default 60_000 */
  timeout?: number;
}

export class OpenAICompatibleProvider implements LLMProvider {
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

  async chat(
    messages: ChatMessage[],
    model: string,
    options: { temperature?: number; maxTokens?: number }
  ): Promise<ChatResponse> {
    const start = Date.now();

    const completion = await this.client.chat.completions.create({
      model,
      messages,
      temperature: options.temperature ?? 0.2,
      max_tokens: options.maxTokens,
    });

    const choice = completion.choices[0];
    if (!choice?.message?.content) {
      throw new Error(`Provider ${this.name} returned empty content for model ${model}`);
    }

    const usage = completion.usage;
    return {
      content: choice.message.content,
      model: completion.model ?? model,
      durationMs: Date.now() - start,
      tokenUsage: {
        input: usage?.prompt_tokens ?? 0,
        output: usage?.completion_tokens ?? 0,
        total: usage?.total_tokens ?? 0,
      },
    };
  }
}
