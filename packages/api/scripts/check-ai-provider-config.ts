#!/usr/bin/env npx tsx
/**
 * Static AI provider/model alignment checker.
 *
 * Exit 1 when AI_PROVIDER_API_KEY is missing or host/model IDs are incompatible
 * (e.g. Claude/Llama on api.openai.com — 2026-07-20 incident), or when
 * AI_CLASSIFY_INTENT_DEADLINE_MS is present-but-empty (4s silent regression).
 *
 * Usage:
 *   AI_PROVIDER_BASE_URL=https://api.openai.com/v1 \
 *   AI_PROVIDER_API_KEY=sk-dummy \
 *   AI_DEFAULT_MODEL=gpt-4o-mini \
 *   AI_LIGHTWEIGHT_MODEL=gpt-4o-mini \
 *   AI_STANDARD_MODEL=gpt-4o-mini \
 *   AI_COMPLEX_MODEL=gpt-4o \
 *   npm run check:ai-provider-config
 *
 * See docs/runbooks/live-ai-restore.md (Profile A / Profile B / A+fallback).
 */
import { findProviderModelMismatch } from '../src/ai/gateway/provider-model-compat';
import { isEnvPresentButBlank } from '../src/config/ai-routing';

function env(name: string): string | undefined {
  const v = process.env[name];
  return v && v.trim() !== '' ? v.trim() : undefined;
}

/** Same fallthrough as packages/api/src/config/ai-routing.ts when tiers unset. */
const ROUTING_DEFAULTS = {
  lightweight: 'meta-llama/llama-3.1-8b-instruct',
  standard: 'meta-llama/llama-3.3-70b-instruct',
  complex: 'qwen/qwen2.5-vl-72b-instruct',
} as const;

const baseUrl = env('AI_PROVIDER_BASE_URL') ?? 'https://api.openai.com/v1';
const keyPresent = Boolean(env('AI_PROVIDER_API_KEY'));
const defaultModel = env('AI_DEFAULT_MODEL');

const lightweight = env('AI_LIGHTWEIGHT_MODEL') ?? defaultModel ?? ROUTING_DEFAULTS.lightweight;
const standard = env('AI_STANDARD_MODEL') ?? defaultModel ?? ROUTING_DEFAULTS.standard;
const complex = env('AI_COMPLEX_MODEL') ?? defaultModel ?? ROUTING_DEFAULTS.complex;

const fallbackKey = env('AI_FALLBACK_PROVIDER_API_KEY');
const fallbackBase = env('AI_FALLBACK_PROVIDER_BASE_URL');
const classifyDeadlineRaw = process.env.AI_CLASSIFY_INTENT_DEADLINE_MS;
const classifyDeadlineBlank = isEnvPresentButBlank('AI_CLASSIFY_INTENT_DEADLINE_MS');

const display = {
  AI_PROVIDER_BASE_URL: baseUrl,
  AI_PROVIDER_API_KEY: keyPresent ? '(set)' : '(MISSING)',
  AI_DEFAULT_MODEL: defaultModel ?? '(unset)',
  AI_LIGHTWEIGHT_MODEL: env('AI_LIGHTWEIGHT_MODEL') ?? `(effective: ${lightweight})`,
  AI_STANDARD_MODEL: env('AI_STANDARD_MODEL') ?? `(effective: ${standard})`,
  AI_COMPLEX_MODEL: env('AI_COMPLEX_MODEL') ?? `(effective: ${complex})`,
  AI_CLASSIFY_INTENT_DEADLINE_MS: classifyDeadlineBlank
    ? '(EMPTY — FAIL)'
    : classifyDeadlineRaw === undefined
      ? '(unset → default 4000)'
      : classifyDeadlineRaw,
  AI_FALLBACK_PROVIDER_BASE_URL: fallbackBase ?? '(unset — single provider)',
  AI_FALLBACK_PROVIDER_API_KEY: fallbackKey ? '(set)' : '(unset)',
  AI_FALLBACK_LIGHTWEIGHT_MODEL:
    env('AI_FALLBACK_LIGHTWEIGHT_MODEL') ?? '(default: meta-llama/llama-3.1-8b-instruct)',
};

console.log('AI provider config check');
console.log('------------------------');
for (const [k, v] of Object.entries(display)) {
  console.log(`${k.padEnd(34)} = ${v}`);
}

if (!keyPresent) {
  console.error('\nFAIL: AI_PROVIDER_API_KEY is not set (hermetic mock / empty providers).');
  console.error('See docs/runbooks/live-ai-restore.md');
  process.exit(1);
}

if (classifyDeadlineBlank) {
  console.error(
    '\nFAIL: AI_CLASSIFY_INTENT_DEADLINE_MS is set but empty. ' +
      'This silently falls back to 4000ms and regressed production voice. ' +
      'Set a positive integer (production: 12000) or unset the variable.',
  );
  process.exit(1);
}

if ((fallbackKey && !fallbackBase) || (!fallbackKey && fallbackBase)) {
  console.error(
    '\nFAIL: AI_FALLBACK_PROVIDER_API_KEY and AI_FALLBACK_PROVIDER_BASE_URL must both be set (or both unset).',
  );
  console.error('See docs/runbooks/live-ai-restore.md (Profile A + OpenRouter fallback).');
  process.exit(1);
}

if (fallbackBase) {
  const fallbackMismatch = findProviderModelMismatch(fallbackBase, [
    env('AI_FALLBACK_LIGHTWEIGHT_MODEL') ?? 'meta-llama/llama-3.1-8b-instruct',
  ]);
  if (fallbackMismatch) {
    console.error(`\nFAIL (fallback): ${fallbackMismatch.reason}`);
    process.exit(1);
  }
}

const mismatch = findProviderModelMismatch(baseUrl, [lightweight, standard, complex]);
if (mismatch) {
  console.error(`\nFAIL: ${mismatch.reason}`);
  console.error('\nFix: Profile A (OpenAI + gpt-*) or Profile B (OpenRouter + vendor/model ids).');
  console.error('See docs/runbooks/live-ai-restore.md');
  process.exit(1);
}

console.log('\nOK: provider host and model IDs are compatible (static check).');
if (fallbackKey && fallbackBase) {
  console.log('OK: dual-provider failover env pair is present.');
}
console.log('Still run GET /api/health/ai/completion after deploy for live proof.');
process.exit(0);
