/**
 * Layer 2 harness constants shared by `real-layer-two-factory.ts` and the
 * voice-quality provider selector (`voice-quality/path-smoke/provider.ts`).
 * Kept in their own module so the factory can import the selector without an
 * import cycle.
 */

/** Anthropic fallback model (Haiku 4.5). Pinned so a model bump is an explicit edit. */
export const DEFAULT_LAYER_TWO_MODEL = 'claude-haiku-4-5-20251001';

/** Anthropic's OpenAI-compatible chat-completions endpoint. */
export const ANTHROPIC_OPENAI_COMPAT_BASE_URL = 'https://api.anthropic.com/v1/';
