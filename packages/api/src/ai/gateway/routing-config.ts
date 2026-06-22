/**
 * TaskRouteConfig — the per-task model + generation-defaults shape.
 *
 * Used by the complexity classifier (complexity-classifier.ts: ComplexityRoute
 * extends this). The live gateway routing is `LLMGatewayConfig.taskRouting`
 * (gateway.ts), assembled by the factory from env vars — not from a static
 * table here.
 *
 * Moved here from the deleted types.ts (P2-027 Gap 2).
 */

export interface TaskRouteConfig {
  model: string;
  systemPrompt?: string;
  temperature?: number;
  maxTokens?: number;
}
