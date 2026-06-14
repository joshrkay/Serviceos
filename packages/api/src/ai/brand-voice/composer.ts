/**
 * P4-015 — Brand-voice composer.
 *
 * A single shared entry point for the three Wave-C stories that draft
 * customer-facing text (P6-028, P7-026, P8-015). Each picks an intent; the
 * composer pulls the tenant tone, builds the `brand_voice_v1` prompt, routes
 * through the existing AI gateway (so failover/breaker/retry apply), and
 * enforces `maxChars` AFTER the model returns.
 *
 * Invariants (see review prompt):
 *   - Tone is the authority. The tenant tone is rendered as a non-overridable
 *     system instruction; caller context can never jailbreak it.
 *   - `maxChars` is enforced in code after generation — the model is never
 *     trusted to obey the budget.
 *   - Routing goes through `gateway.complete()` only. No provider SDK calls.
 *   - PII opt-in. Only the fields the caller passes in `context` reach the
 *     prompt; nothing is pulled implicitly.
 *   - Gateway failure surfaces a typed error (never a silent empty string).
 */

import { AppError } from '../../shared/errors';
import type { LLMGateway } from '../gateway/gateway';
import type { SettingsRepository } from '../../settings/settings';
import {
  BRAND_VOICE_TASK_TYPE,
  BRAND_VOICE_PROMPT_VERSION_ID,
} from '../prompt-registry';
import {
  buildBrandVoicePrompt,
  isBrandVoiceIntent,
  type BrandVoiceIntent,
  type BrandVoiceTone,
} from './prompts';

export type { BrandVoiceIntent, BrandVoiceTone } from './prompts';

export interface ComposeBrandVoiceInput {
  tenantId: string;
  intent: BrandVoiceIntent;
  /**
   * Caller-supplied facts the message may reference. PII OPT-IN: only the
   * keys present here reach the prompt. Defaulting to "include everything"
   * would leak PII to the model, so callers must pass fields explicitly.
   */
  context: Record<string, unknown>;
  /** Hard character cap enforced in code after the model returns. */
  maxChars: number;
}

export interface ComposeBrandVoiceResult {
  text: string;
  promptVersionId: string;
}

export interface ComposeBrandVoiceDeps {
  gateway: LLMGateway;
  /**
   * Settings repository used to read `tenant_settings.brand_voice`. Reads are
   * tenantId-first per repo convention; we never open a pool directly here.
   */
  settingsRepo: SettingsRepository;
}

/**
 * The settings row may carry the `brand_voice` JSONB column. The shared
 * `TenantSettings` type does not yet expose it as a typed field, so we read
 * it defensively off the row and validate the shape before use. A missing or
 * malformed value falls back to the neutral default inside the prompt builder.
 */
function readToneFromSettings(settings: unknown): BrandVoiceTone | null {
  if (!settings || typeof settings !== 'object') return null;
  const raw = (settings as Record<string, unknown>).brandVoice ??
    (settings as Record<string, unknown>).brand_voice;
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const tone: BrandVoiceTone = {};
  if (obj.formality === 'casual' || obj.formality === 'professional') {
    tone.formality = obj.formality;
  }
  if (obj.pronoun === 'we' || obj.pronoun === 'i') {
    tone.pronoun = obj.pronoun;
  }
  if (
    Array.isArray(obj.vibe_words) &&
    obj.vibe_words.every((w) => typeof w === 'string')
  ) {
    tone.vibe_words = obj.vibe_words as string[];
  }
  if (typeof obj.business_name === 'string') {
    tone.business_name = obj.business_name;
  }
  // N-009 / P2-038 — negative prompt grown by the correction loop.
  if (
    Array.isArray(obj.banned_phrases) &&
    obj.banned_phrases.every((p) => typeof p === 'string')
  ) {
    tone.banned_phrases = obj.banned_phrases as string[];
  }
  return tone;
}

/**
 * Trim `text` to at most `maxChars` characters without cutting mid-word.
 * Prefers a clean cut at the last whitespace boundary; only appends `...`
 * when the trim actually removed content AND there is room for the ellipsis.
 */
export function trimToMaxChars(text: string, maxChars: number): string {
  const trimmed = text.trim();
  if (maxChars <= 0) return '';
  if (trimmed.length <= maxChars) return trimmed;

  const ELLIPSIS = '...';
  // Reserve room for the ellipsis when the cap is large enough to fit a word
  // plus the marker; for very tight caps we just hard-cut to a word boundary.
  const budget =
    maxChars > ELLIPSIS.length + 1 ? maxChars - ELLIPSIS.length : maxChars;

  const slice = trimmed.slice(0, budget);
  const lastSpace = slice.lastIndexOf(' ');
  let cut = lastSpace > 0 ? slice.slice(0, lastSpace) : slice;
  cut = cut.replace(/[\s.,;:!?-]+$/, '').trim();

  if (cut.length === 0) {
    // No usable word boundary (e.g. a single long token under a tiny cap):
    // hard-cut to the cap so we never exceed maxChars.
    return trimmed.slice(0, maxChars);
  }

  // Only add the ellipsis when it still fits within maxChars.
  if (cut.length + ELLIPSIS.length <= maxChars) {
    return `${cut}${ELLIPSIS}`;
  }
  return cut;
}

/**
 * Compose a customer-facing message in the tenant's brand voice.
 *
 * @throws AppError when the gateway fails or returns empty content — callers
 *   get a typed error, never a silent empty string.
 */
export async function composeBrandVoiceMessage(
  input: ComposeBrandVoiceInput,
  deps: ComposeBrandVoiceDeps,
): Promise<ComposeBrandVoiceResult> {
  const { tenantId, intent, context, maxChars } = input;
  const { gateway, settingsRepo } = deps;

  if (!isBrandVoiceIntent(intent)) {
    throw new AppError(
      'BRAND_VOICE_UNKNOWN_INTENT',
      `Unknown brand-voice intent: ${String(intent)}`,
      400,
      { intent },
    );
  }
  if (!Number.isFinite(maxChars) || maxChars <= 0) {
    throw new AppError(
      'BRAND_VOICE_INVALID_MAX_CHARS',
      `maxChars must be a positive number, got ${String(maxChars)}`,
      400,
      { maxChars },
    );
  }

  const settings = await settingsRepo.findByTenant(tenantId);
  const tone = readToneFromSettings(settings);

  const { system, user } = buildBrandVoicePrompt({
    intent,
    tone,
    context,
    maxChars,
  });

  const response = await gateway.complete({
    taskType: BRAND_VOICE_TASK_TYPE,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    responseFormat: 'text',
    temperature: 0.4,
    tenantId,
    metadata: {
      tenantId,
      skill: 'brand_voice',
      intent,
      promptVersionId: BRAND_VOICE_PROMPT_VERSION_ID,
    },
  });

  const raw = (response.content ?? '').trim();
  if (raw.length === 0) {
    // Do NOT return an empty string silently — surface a typed error.
    throw new AppError(
      'BRAND_VOICE_EMPTY_OUTPUT',
      'Brand-voice generation returned empty content',
      502,
      { intent, tenantId },
    );
  }

  // maxChars is enforced HERE, after generation — the model is not trusted
  // to have respected the budget hint in the prompt.
  const text = trimToMaxChars(raw, maxChars);

  return { text, promptVersionId: BRAND_VOICE_PROMPT_VERSION_ID };
}
