import type { LLMProvider, ChatRequest, ChatResponse, GatewayConfig, ChatMessage } from './types';
import { DEFAULT_GATEWAY_CONFIG } from './routing-config';

export interface GatewayLogger {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 504]);
const MAX_RETRIES = 2;
const BASE_RETRY_DELAY_MS = 500;

function isRetryableError(err: unknown): boolean {
  if (err instanceof Error) {
    const status = (err as { status?: number }).status;
    if (status && RETRYABLE_STATUS_CODES.has(status)) return true;
    if (err.message.includes('rate limit') || err.message.includes('timeout')) return true;
  }
  return false;
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class LLMGateway {
  private readonly provider: LLMProvider;
  private readonly config: GatewayConfig;
  private readonly logger?: GatewayLogger;

  constructor(provider: LLMProvider, config?: Partial<GatewayConfig>, logger?: GatewayLogger) {
    this.provider = provider;
    this.config = { ...DEFAULT_GATEWAY_CONFIG, ...config };
    this.logger = logger;
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const route = this.config.routes[request.taskType];
    const model = request.modelOverride ?? route?.model ?? this.config.defaultModel;
    const temperature = request.temperature ?? route?.temperature ?? 0.2;
    const maxTokens = request.maxTokens ?? route?.maxTokens;

    // Prepend system prompt from route config if not already present
    const messages: ChatMessage[] = [...request.messages];
    if (route?.systemPrompt && messages[0]?.role !== 'system') {
      messages.unshift({ role: 'system', content: route.systemPrompt });
    }

    this.logger?.info('llm.request', {
      taskType: request.taskType,
      model,
      messageCount: messages.length,
      correlationId: request.correlationId,
      tenantId: request.tenantId,
    });

    let lastError: unknown;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (attempt > 0) {
        const delay = BASE_RETRY_DELAY_MS * Math.pow(2, attempt - 1);
        this.logger?.warn('llm.retry', {
          attempt,
          delay,
          taskType: request.taskType,
          correlationId: request.correlationId,
        });
        await sleep(delay);
      }

      try {
        const response = await this.provider.chat(messages, model, { temperature, maxTokens });

        this.logger?.info('llm.response', {
          taskType: request.taskType,
          model: response.model,
          durationMs: response.durationMs,
          tokens: response.tokenUsage,
          correlationId: request.correlationId,
          tenantId: request.tenantId,
        });

        return response;
      } catch (err) {
        lastError = err;
        if (!isRetryableError(err) || attempt === MAX_RETRIES) break;
      }
    }

    this.logger?.error('llm.failed', {
      taskType: request.taskType,
      model,
      error: lastError instanceof Error ? lastError.message : String(lastError),
      correlationId: request.correlationId,
    });

    throw lastError;
  }

  /** Convenience: send a single user message */
  async ask(taskType: string, userMessage: string, tenantId?: string): Promise<string> {
    const response = await this.chat({
      taskType,
      messages: [{ role: 'user', content: userMessage }],
      tenantId,
    });
    return response.content;
  }
}
