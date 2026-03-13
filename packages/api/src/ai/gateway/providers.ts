import { ValidationError } from '../../shared/errors';
import type { LLMProvider, LLMRequest, LLMResponse } from './gateway';

export class StubProvider implements LLMProvider {
  readonly name: string;
  private response: LLMResponse;
  private lastRequest?: LLMRequest;
  private available: boolean;

  constructor(name: string = 'stub', available: boolean = true) {
    this.name = name;
    this.available = available;
    this.response = {
      content: 'stub response',
      model: 'stub-model',
      provider: this.name,
      tokenUsage: { input: 0, output: 0, total: 0 },
      latencyMs: 0,
    };
  }

  setResponse(response: Partial<LLMResponse>): void {
    this.response = { ...this.response, ...response };
  }

  setAvailable(available: boolean): void {
    this.available = available;
  }

  getLastRequest(): LLMRequest | undefined {
    return this.lastRequest;
  }

  async complete(request: LLMRequest): Promise<LLMResponse> {
    if (!request.messages || request.messages.length === 0) {
      throw new ValidationError('Request must have at least one message');
    }

    this.lastRequest = request;

    return {
      ...this.response,
      provider: this.name,
      model: request.model || this.response.model,
    };
  }

  async isAvailable(): Promise<boolean> {
    return this.available;
  }
}

export interface OpenAICompatibleProviderConfig {
  name: string;
  baseUrl: string;
  apiKey: string;
  defaultModel: string;
}

interface OpenAIChatCompletionResponse {
  id: string;
  choices: Array<{
    message: { role: string; content: string };
    finish_reason: string;
  }>;
  model: string;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export class OpenAICompatibleProvider implements LLMProvider {
  readonly name: string;
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly defaultModel: string;

  constructor(config: OpenAICompatibleProviderConfig) {
    this.name = config.name;
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
    this.apiKey = config.apiKey;
    this.defaultModel = config.defaultModel;
  }

  async complete(request: LLMRequest): Promise<LLMResponse> {
    const model = request.model || this.defaultModel;
    const url = `${this.baseUrl}/chat/completions`;

    const body: Record<string, unknown> = {
      model,
      messages: request.messages.map((m) => ({ role: m.role, content: m.content })),
    };

    if (request.temperature !== undefined) {
      body.temperature = request.temperature;
    }
    if (request.maxTokens !== undefined) {
      body.max_tokens = request.maxTokens;
    }
    if (request.responseFormat === 'json') {
      body.response_format = { type: 'json_object' };
    }

    const startTime = Date.now();

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errorBody = await res.text().catch(() => 'unknown error');
      throw new Error(`OpenAI API error ${res.status}: ${errorBody}`);
    }

    const data = (await res.json()) as OpenAIChatCompletionResponse;
    const latencyMs = Date.now() - startTime;

    return {
      content: data.choices[0]?.message?.content ?? '',
      model: data.model,
      provider: this.name,
      tokenUsage: {
        input: data.usage?.prompt_tokens ?? 0,
        output: data.usage?.completion_tokens ?? 0,
        total: data.usage?.total_tokens ?? 0,
      },
      latencyMs,
    };
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }
}
