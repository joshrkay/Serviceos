import { v4 as uuidv4 } from 'uuid';
import { AppError, ValidationError } from '../../shared/errors';

export interface LLMMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LLMRequest {
  taskType: string;
  model?: string;
  messages: LLMMessage[];
  temperature?: number;
  maxTokens?: number;
  responseFormat?: 'text' | 'json';
  metadata?: Record<string, unknown>;
}

export interface LLMResponse {
  content: string;
  model: string;
  provider: string;
  tokenUsage: { input: number; output: number; total: number };
  latencyMs: number;
  cached?: boolean;
}

export interface LLMProvider {
  name: string;
  complete(request: LLMRequest): Promise<LLMResponse>;
  isAvailable(): Promise<boolean>;
}

export interface LLMGatewayConfig {
  defaultProvider: string;
  taskRouting?: Record<string, string>; // taskType -> providerName
  defaultModel?: string;
  taskModels?: Record<string, string>; // taskType -> model
}

export interface LLMGatewayLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

export function validateLLMRequest(request: LLMRequest): string[] {
  const errors: string[] = [];
  if (!request.taskType) errors.push('taskType is required');
  if (!request.messages || !Array.isArray(request.messages) || request.messages.length === 0) {
    errors.push('messages must be a non-empty array');
  }
  if (request.temperature !== undefined && (request.temperature < 0 || request.temperature > 2)) {
    errors.push('temperature must be between 0 and 2');
  }
  if (request.maxTokens !== undefined && request.maxTokens <= 0) {
    errors.push('maxTokens must be a positive number');
  }
  if (request.responseFormat !== undefined && request.responseFormat !== 'text' && request.responseFormat !== 'json') {
    errors.push('responseFormat must be "text" or "json"');
  }
  return errors;
}

export class LLMGateway {
  private readonly config: LLMGatewayConfig;
  private readonly providers: Map<string, LLMProvider>;
  private readonly logger?: LLMGatewayLogger;

  constructor(
    config: LLMGatewayConfig,
    providers: Map<string, LLMProvider>,
    logger?: LLMGatewayLogger
  ) {
    this.config = config;
    this.providers = providers;
    this.logger = logger;
  }

  async complete(request: LLMRequest): Promise<LLMResponse> {
    const validationErrors = validateLLMRequest(request);
    if (validationErrors.length > 0) {
      throw new ValidationError('Invalid LLM request', { errors: validationErrors });
    }

    const providerName = this.resolveProvider(request.taskType);
    const provider = this.providers.get(providerName);
    if (!provider) {
      throw new AppError('PROVIDER_NOT_FOUND', `Provider not found: ${providerName}`, 500);
    }

    const resolvedModel = this.resolveModel(request);
    const resolvedRequest: LLMRequest = { ...request, model: resolvedModel };

    const startTime = Date.now();

    try {
      const response = await provider.complete(resolvedRequest);
      const latencyMs = Date.now() - startTime;

      const result: LLMResponse = {
        ...response,
        latencyMs,
      };

      this.logger?.info('LLM completion succeeded', {
        taskType: request.taskType,
        provider: providerName,
        model: resolvedModel,
        latencyMs,
        tokenUsage: result.tokenUsage,
      });

      return result;
    } catch (err) {
      const latencyMs = Date.now() - startTime;
      this.logger?.error('LLM completion failed', {
        taskType: request.taskType,
        provider: providerName,
        model: resolvedModel,
        latencyMs,
        error: err instanceof Error ? err.message : String(err),
      });

      if (err instanceof AppError) {
        throw err;
      }

      throw new AppError(
        'LLM_PROVIDER_ERROR',
        `Provider ${providerName} failed: ${err instanceof Error ? err.message : String(err)}`,
        502,
        { provider: providerName, taskType: request.taskType }
      );
    }
  }

  private resolveProvider(taskType: string): string {
    if (this.config.taskRouting && this.config.taskRouting[taskType]) {
      return this.config.taskRouting[taskType];
    }
    return this.config.defaultProvider;
  }

  private resolveModel(request: LLMRequest): string {
    if (request.model) return request.model;
    if (this.config.taskModels && this.config.taskModels[request.taskType]) {
      return this.config.taskModels[request.taskType];
    }
    return this.config.defaultModel || 'default';
  }
}
