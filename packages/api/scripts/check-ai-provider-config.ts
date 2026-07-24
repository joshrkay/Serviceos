#!/usr/bin/env npx tsx
/**
 * Static AI provider/model alignment checker.
 *
 * Exit 1 when AI_PROVIDER_API_KEY is missing or host/model IDs are incompatible
 * (e.g. Claude/Llama on api.openai.com — 2026-07-20 incident).
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
 * See docs/runbooks/live-ai-restore.md (Profile A / Profile B).
 */
import { findProviderModelMismatch } from '../src/ai/gateway/provider-model-compat';
import { validateClassifyIntentDeadlineEnv } from '../src/config/ai-routing';

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

const display = {
  AI_PROVIDER_BASE_URL: baseUrl,
  AI_PROVIDER_API_KEY: keyPresent ? '(set)' : '(MISSING)',
  AI_DEFAULT_MODEL: defaultModel ?? '(unset)',
  AI_LIGHTWEIGHT_MODEL: env('AI_LIGHTWEIGHT_MODEL') ?? `(effective: ${lightweight})`,
  AI_STANDARD_MODEL: env('AI_STANDARD_MODEL') ?? `(effective: ${standard})`,
  AI_COMPLEX_MODEL: env('AI_COMPLEX_MODEL') ?? `(effective: ${complex})`,
};

console.log('AI provider config check');
console.log('------------------------');
for (const [k, v] of Object.entries(display)) {
  console.log(`${k.padEnd(22)} = ${v}`);
}

if (!keyPresent) {
  console.error('\nFAIL: AI_PROVIDER_API_KEY is not set (hermetic mock / empty providers).');
  console.error('See docs/runbooks/live-ai-restore.md');
  process.exit(1);
}

const mismatch = findProviderModelMismatch(baseUrl, [lightweight, standard, complex]);
if (mismatch) {
  console.error(`\nFAIL: ${mismatch.reason}`);
  console.error('\nFix: Profile A (OpenAI + gpt-*) or Profile B (OpenRouter + vendor/model ids).');
  console.error('See docs/runbooks/live-ai-restore.md');
  process.exit(1);
}

const classifyDeadline = validateClassifyIntentDeadlineEnv(process.env);
const classifyRaw = process.env.AI_CLASSIFY_INTENT_DEADLINE_MS;
console.log(
  `${'AI_CLASSIFY_INTENT_DEADLINE_MS'.padEnd(22)} = ${
    classifyRaw === undefined ? '(unset → 4000)' : JSON.stringify(classifyRaw)
  }`,
);
if (!classifyDeadline.ok) {
  console.error(`\nFAIL: ${classifyDeadline.reason}`);
  process.exit(1);
}

// Dual-provider failover: both key+URL required; partial config is a footgun.
const fbKey = env('AI_FALLBACK_PROVIDER_API_KEY');
const fbUrl = env('AI_FALLBACK_PROVIDER_BASE_URL');
if ((fbKey && !fbUrl) || (!fbKey && fbUrl)) {
  console.error(
    '\nFAIL: AI_FALLBACK_PROVIDER_* partially set — need both API_KEY and BASE_URL (or neither).',
  );
  process.exit(1);
}
if (fbKey && fbUrl) {
  const fbMismatch = findProviderModelMismatch(fbUrl, [
    env('AI_FALLBACK_LIGHTWEIGHT_MODEL') ?? 'meta-llama/llama-3.1-8b-instruct',
    env('AI_FALLBACK_STANDARD_MODEL') ?? env('AI_FALLBACK_LIGHTWEIGHT_MODEL') ?? 'meta-llama/llama-3.1-8b-instruct',
    env('AI_FALLBACK_COMPLEX_MODEL') ?? env('AI_FALLBACK_LIGHTWEIGHT_MODEL') ?? 'meta-llama/llama-3.1-8b-instruct',
  ]);
  if (fbMismatch) {
    console.error(`\nFAIL (fallback): ${fbMismatch.reason}`);
    process.exit(1);
  }
  console.log('AI_FALLBACK_PROVIDER     = wired (dual-provider failover)');
} else {
  console.log('AI_FALLBACK_PROVIDER     = (unset — single provider)');
}

console.log('\nOK: provider host and model IDs are compatible (static check).');
console.log('Still run GET /api/health/ai/completion after deploy for live proof.');
process.exit(0);
