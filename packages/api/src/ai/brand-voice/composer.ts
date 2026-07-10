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
import type { Logger } from '../../logging/logger';
import type { SettingsRepository } from '../../settings/settings';
import type { StandingInstructionRepository } from '../../instructions/standing-instructions';
import {
  buildStandingInstructionsSection,
  selectInjectedStandingInstructions,
} from '../standing-instructions-context';
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

/**
 * N-011 — a structured brand-voice deviation. Promoted from the previous
 * log-only `enforceBannedPhrases` warn. When present, callers must downgrade
 * the proposal's `_meta.overallConfidence` to no higher than 'low' (see
 * `applyBrandVoiceDeviationToMeta`) so a message that departed from the locked
 * profile is surfaced for review instead of auto-approved (N-002 marker).
 */
export interface BrandVoiceDeviation {
  kind: 'banned_phrase_stripped' | 'register_mismatch';
  /** e.g. the removed banned phrases. */
  detail: string[];
}

export interface ComposeBrandVoiceResult {
  text: string;
  /** Existing: the prompt template version ('brand_voice_v1'). */
  promptVersionId: string;
  /**
   * N-011: the tenant's brand-voice CONFIG version (migration 238's
   * `brand_voice_version`; 0 = never configured / neutral). Every utterance
   * the composer drafts is tagged with this so the record it lands on can cite
   * which locked profile produced it.
   */
  brandVoiceVersion: number;
  /** N-011: present when the output departed from the locked profile. */
  deviation?: BrandVoiceDeviation;
}

export interface ComposeBrandVoiceDeps {
  gateway: LLMGateway;
  /**
   * Settings repository used to read `tenant_settings.brand_voice`. Reads are
   * tenantId-first per repo convention; we never open a pool directly here.
   */
  settingsRepo: SettingsRepository;
  /**
   * UB-A3 — owner standing instructions applied to brand-voiced drafts.
   * Resolved here (keyed on the brand-voice intent) rather than threaded by
   * every caller, because composer callers (digest sweep, reschedule drafts)
   * have no classifier in play — the intent IS the selection key. Optional
   * and failure-soft: a repo error composes without instructions.
   */
  standingInstructionRepo?: Pick<StandingInstructionRepository, 'listActive'>;
  /**
   * Optional logger. When a banned phrase is stripped from generated output
   * (see `enforceBannedPhrases`), a warn is emitted so the near-miss is visible
   * to telemetry / the correction loop. Optional and failure-soft: absent
   * logger simply means no log line.
   */
  logger?: Pick<Logger, 'warn'>;
}

/**
 * The settings row may carry the `brand_voice` JSONB column. The shared
 * `TenantSettings` type does not yet expose it as a typed field, so we read
 * it defensively off the row and validate the shape before use. A missing or
 * malformed value falls back to the neutral default inside the prompt builder.
 */
export function readToneFromSettings(settings: unknown): BrandVoiceTone | null {
  if (!settings || typeof settings !== 'object') return null;
  const raw = (settings as Record<string, unknown>).brandVoice ??
    (settings as Record<string, unknown>).brand_voice;
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const tone: BrandVoiceTone = {};
  // N-011 — register is authoritative; legacy formality is mapped forward in
  // renderToneAuthority via resolveRegister, so we retain both here.
  if (obj.register === 'formal' || obj.register === 'friendly' || obj.register === 'casual') {
    tone.register = obj.register;
  }
  if (obj.formality === 'casual' || obj.formality === 'professional') {
    tone.formality = obj.formality;
  }
  if (obj.pronoun === 'we' || obj.pronoun === 'i') {
    tone.pronoun = obj.pronoun;
  }
  if (
    Array.isArray(obj.opening_lines) &&
    obj.opening_lines.every((o) => typeof o === 'string')
  ) {
    tone.opening_lines = obj.opening_lines as string[];
  }
  if (typeof obj.signoff === 'string') {
    tone.signoff = obj.signoff;
  }
  if (typeof obj.persona_name === 'string') {
    tone.persona_name = obj.persona_name;
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
 * N-011 — read the tenant's brand-voice VERSION (the `brand_voice_version`
 * bookkeeping column, migration 238) off a settings row. This is the config
 * version the composer stamps onto every utterance — distinct from the
 * `brand_voice_v1` PROMPT version. 0 means never configured (neutral tone).
 */
export function readBrandVoiceVersion(settings: unknown): number {
  if (!settings || typeof settings !== 'object') return 0;
  const v = (settings as Record<string, unknown>).brandVoiceVersion;
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0;
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

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Enforce the tenant's `banned_phrases` in CODE, after generation — the model
 * is only *asked* not to use them (a negative prompt in `prompts.ts`), and an
 * LLM can ignore that. Banned phrases are grown by the correction loop from
 * explicit owner edits ("never say X again"), so letting one slip to a customer
 * silently breaks a locked brand-voice correction. This mirrors the `maxChars`
 * philosophy: the model is never trusted; the guarantee is enforced here.
 *
 * Matching is case-insensitive and literal (regex metachars escaped). Longest
 * phrases are removed first so an overlapping longer ban wins. Seams left by
 * removal (doubled spaces, space-before-punctuation, doubled/orphaned
 * punctuation) are cleaned up so the delivered message still reads naturally.
 */
export function enforceBannedPhrases(
  text: string,
  bannedPhrases: string[] | undefined,
): { text: string; removed: string[] } {
  const phrases = (bannedPhrases ?? [])
    .filter((p) => typeof p === 'string' && p.trim().length > 0)
    .sort((a, b) => b.trim().length - a.trim().length);
  if (phrases.length === 0) return { text, removed: [] };

  let out = text;
  const removed: string[] = [];
  for (const phrase of phrases) {
    const re = new RegExp(escapeRegExp(phrase.trim()), 'gi');
    const next = out.replace(re, '');
    if (next !== out) {
      removed.push(phrase);
      out = next;
    }
  }
  if (removed.length === 0) return { text, removed: [] };

  out = out
    .replace(/[ \t]{2,}/g, ' ')
    // No space before punctuation.
    .replace(/\s+([,.!?;:])/g, '$1')
    // Collapse a run of adjacent punctuation (e.g. the ",." left when a phrase
    // between a comma and a period is removed) down to the final mark.
    .replace(/[,.!?;:](?:\s*[,.!?;:])+/g, (m) => m.replace(/\s+/g, '').slice(-1))
    .replace(/\s{2,}/g, ' ')
    // No leading punctuation/space left dangling at the front.
    .replace(/^[\s,.!?;:]+/, '')
    .trim();
  return { text: out, removed };
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
  const brandVoiceVersion = readBrandVoiceVersion(settings);

  const { system, user } = buildBrandVoicePrompt({
    intent,
    tone,
    context,
    maxChars,
  });

  // UB-A3 — standing instructions ride a separate, delimited system message
  // AFTER the tone authority, adjusting CONTENT only (the section itself
  // forbids approval/confidence/schema overrides). Best-effort: a repo
  // failure never blocks composition. No applied-id ask: text output.
  let standingSection: string | undefined;
  if (deps.standingInstructionRepo) {
    try {
      const active = await deps.standingInstructionRepo.listActive(tenantId);
      const injected = selectInjectedStandingInstructions(active, intent);
      if (injected) {
        standingSection = buildStandingInstructionsSection(injected, {
          requestAppliedIds: false,
        });
      }
    } catch {
      standingSection = undefined;
    }
  }

  const response = await gateway.complete({
    taskType: BRAND_VOICE_TASK_TYPE,
    messages: [
      { role: 'system', content: system },
      ...(standingSection
        ? [{ role: 'system' as const, content: standingSection }]
        : []),
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

  // Banned phrases are enforced HERE, in code — the prompt only *asks* the
  // model to avoid them (prompts.ts), which an LLM can ignore. A banned phrase
  // is an explicit, locked owner correction; it must never reach the customer.
  const { text: cleaned, removed } = enforceBannedPhrases(raw, tone?.banned_phrases);
  // N-011 — promote the strip signal from a log line to a structured deviation
  // the caller maps to a downgraded N-002 confidence marker. The warn is kept
  // for telemetry / the correction loop.
  let deviation: BrandVoiceDeviation | undefined;
  if (removed.length > 0) {
    deviation = { kind: 'banned_phrase_stripped', detail: removed };
    deps.logger?.warn(
      'brand-voice: stripped banned phrase(s) from generated output',
      { tenantId, intent, removed },
    );
  }
  if (cleaned.trim().length === 0) {
    // The entire generation was banned content — surface typed, don't ship "".
    throw new AppError(
      'BRAND_VOICE_EMPTY_OUTPUT',
      'Brand-voice generation collapsed to empty after banned-phrase enforcement',
      502,
      { intent, tenantId },
    );
  }

  // maxChars is enforced HERE, after generation — the model is not trusted
  // to have respected the budget hint in the prompt.
  const text = trimToMaxChars(cleaned, maxChars);

  return {
    text,
    promptVersionId: BRAND_VOICE_PROMPT_VERSION_ID,
    brandVoiceVersion,
    ...(deviation ? { deviation } : {}),
  };
}

/**
 * N-011 — map a brand-voice deviation onto a proposal `_meta` confidence
 * envelope. A present deviation downgrades `overallConfidence` to no higher
 * than 'low' and attaches a marker, so the deviating message is routed to
 * review rather than auto-approved (threads into the existing N-002/RV-007
 * confidence gate). Also stamps the brand-voice version. Pure — returns a new
 * meta object, never mutates the input.
 */
export function applyBrandVoiceDeviationToMeta(
  meta: { overallConfidence: string; markers?: Array<{ path: string; reason: string }>; [k: string]: unknown } | undefined,
  brandVoiceVersion: number,
  deviation?: BrandVoiceDeviation,
): { overallConfidence: string; brandVoiceVersion: number; markers?: Array<{ path: string; reason: string }>; [k: string]: unknown } {
  const CONFIDENCE_RANK: Record<string, number> = { high: 3, medium: 2, low: 1, very_low: 0 };
  const base = meta ?? { overallConfidence: 'high' };
  const next = { ...base, brandVoiceVersion };
  if (!deviation) return next;
  // Cap at 'low': keep an already-lower level, otherwise pull down to 'low'.
  const current = CONFIDENCE_RANK[next.overallConfidence] ?? 3;
  if (current > CONFIDENCE_RANK.low) {
    next.overallConfidence = 'low';
  }
  const reason =
    deviation.kind === 'banned_phrase_stripped'
      ? `Brand-voice deviation: stripped banned phrase(s) — ${deviation.detail.join(', ')}`
      : `Brand-voice deviation: ${deviation.kind}`;
  next.markers = [...(next.markers ?? []), { path: '_brandVoice', reason }];
  return next;
}
