/**
 * P2-028 — Task-complexity-based model routing.
 *
 * Given a request, decides whether the task is "simple" or "complex". Paired
 * with a TaskRouteConfig that exposes both a simple and a complex model,
 * this lets the gateway pick the right-sized model per-request instead of
 * locking the whole task type to one model up-front.
 */

import type { TaskRouteConfig } from './routing-config';

export type TaskComplexity = 'simple' | 'complex';

export interface ComplexityInput {
  /** The user-facing message or primary input. */
  message?: string;
  /** Approximate size of any structured context passed to the model, in chars. */
  contextSize?: number;
  /** True when the expected output is a structured JSON document with many fields. */
  structuredOutput?: boolean;
  /** True when the task touches financial, legal, or irreversible domains. */
  highStakes?: boolean;
}

/**
 * Heuristic complexity classifier. Cheap, deterministic, no LLM involvement.
 *
 * Escalation triggers (any ONE promotes to "complex"):
 *   • message > 80 words — long inputs usually need more nuance
 *   • contextSize > 2000 chars — big contexts overwhelm small models
 *   • structuredOutput: true — many-field extraction needs the stronger model
 *   • highStakes: true — money / irreversible tasks get the stronger model
 */
export function classifyComplexity(input: ComplexityInput): TaskComplexity {
  if (input.highStakes) return 'complex';
  if (input.structuredOutput) return 'complex';
  if (input.contextSize !== undefined && input.contextSize > 2000) return 'complex';

  if (input.message) {
    const wordCount = input.message.trim().split(/\s+/).filter(Boolean).length;
    if (wordCount > 80) return 'complex';
  }

  return 'simple';
}

export interface ComplexityRoute extends TaskRouteConfig {
  /** Optional override used when classifyComplexity returns 'complex'. */
  complexModel?: string;
}

/**
 * Resolve the model to use for a ComplexityRoute given a classified complexity.
 *
 * When `complexModel` is set and the complexity is 'complex', returns that.
 * Otherwise falls back to the route's primary `model` (treated as the simple
 * model). Static per-task routes without a `complexModel` are unaffected.
 */
export function modelForComplexity(
  route: ComplexityRoute,
  complexity: TaskComplexity
): string {
  if (complexity === 'complex' && route.complexModel) {
    return route.complexModel;
  }
  return route.model;
}
