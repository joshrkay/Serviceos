import type { LLMProvider, ChatMessage, ChatResponse } from '../gateway/types';

/**
 * Deterministic mock provider for unit tests.
 * Returns configurable responses without any network calls.
 */
export class MockLLMProvider implements LLMProvider {
  readonly name = 'mock';

  private responses: Map<string, string> = new Map();
  private callLog: Array<{ messages: ChatMessage[]; model: string }> = [];
  private defaultResponse: string;

  constructor(defaultResponse = '{"mock": true}') {
    this.defaultResponse = defaultResponse;
  }

  /** Prime a response for a specific model */
  setResponse(model: string, content: string): void {
    this.responses.set(model, content);
  }

  /** Set the fallback response for any model */
  setDefaultResponse(content: string): void {
    this.defaultResponse = content;
  }

  async chat(
    messages: ChatMessage[],
    model: string,
    _options: { temperature?: number; maxTokens?: number }
  ): Promise<ChatResponse> {
    this.callLog.push({ messages, model });
    const content = this.responses.get(model) ?? this.defaultResponse;
    return {
      content,
      model,
      durationMs: 1,
      tokenUsage: { input: 10, output: 10, total: 20 },
    };
  }

  getCalls(): Array<{ messages: ChatMessage[]; model: string }> {
    return [...this.callLog];
  }

  reset(): void {
    this.callLog = [];
    this.responses.clear();
  }
}
