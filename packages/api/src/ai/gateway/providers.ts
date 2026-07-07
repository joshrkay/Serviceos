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

    process.stderr.write(`[WARN] StubProvider handling LLM request — no real AI provider configured\n`);

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

// NOTE: the raw-fetch OpenAICompatibleProvider that used to live here was
// dead code — production uses the SDK-based provider in
// src/ai/providers/openai-compatible.ts (timeout + resilience-signal aware).
// Deleted so nobody wires the timeout-less variant by mistake.
