export type ChatRole = 'system' | 'user' | 'assistant';

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

export interface ChatRequest {
  /** Logical task type — used to look up model + system prompt */
  taskType: string;
  messages: ChatMessage[];
  /** Override the model resolved from taskType routing */
  modelOverride?: string;
  /** 0–1, passed to provider */
  temperature?: number;
  maxTokens?: number;
  /** Correlation ID for tracing */
  correlationId?: string;
  tenantId?: string;
}

export interface TokenUsage {
  input: number;
  output: number;
  total: number;
}

export interface ChatResponse {
  content: string;
  model: string;
  tokenUsage: TokenUsage;
  /** Wall-clock ms for the provider call */
  durationMs: number;
}

export interface LLMProvider {
  chat(
    messages: ChatMessage[],
    model: string,
    options: { temperature?: number; maxTokens?: number }
  ): Promise<ChatResponse>;
  /** Human-readable name for logs */
  readonly name: string;
}

export interface TaskRouteConfig {
  model: string;
  systemPrompt?: string;
  temperature?: number;
  maxTokens?: number;
}

export interface GatewayConfig {
  /** Per-task routing: taskType → model + defaults */
  routes: Record<string, TaskRouteConfig>;
  /** Fallback model when taskType has no route */
  defaultModel: string;
}
