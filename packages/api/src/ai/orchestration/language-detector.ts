/**
 * P11-002 — Voice-stack language detector.
 *
 * Resolution order (first non-null wins):
 *   1. customer.preferredLanguage  (explicit per-customer override)
 *   2. transcript heuristic        (Whisper / classifier-detected language)
 *   3. tenant.defaultLanguage      (tenant-level default)
 *   4. 'en'                         (final fallback)
 *
 * The transcript heuristic is intentionally cheap — a token-overlap
 * scan against a short Spanish-marker list. We do NOT call the LLM
 * just to detect language; the cost adds up on every utterance and
 * Whisper / Deepgram already expose a language hint at the STT level.
 * If the STT layer surfaces a confident language code, callers should
 * pass it directly via `transcriptLanguageHint` and skip the heuristic.
 */

import type { Language } from '../i18n/i18n';

export interface DetectLanguageInput {
  /** Customer-level override; takes precedence when set. */
  customerPreferredLanguage?: Language | null;
  /** STT-provider language hint (e.g. Whisper auto-detect → 'es'). */
  transcriptLanguageHint?: Language | null;
  /** Tenant-level default; falls through when nothing else matches. */
  tenantDefaultLanguage?: Language | null;
  /** Raw transcript text for heuristic fallback (cheap token overlap). */
  transcript?: string;
}

/** Common Spanish stop-words / function-words. Kept short — false-positives on
 *  English text with embedded Spanish words are acceptable; the customer
 *  override and STT hint are stronger signals.
 */
const SPANISH_MARKERS = [
  'hola',
  'gracias',
  'por favor',
  'español',
  'espanol',
  'hablo',
  'cuanto',
  'cuánto',
  'donde',
  'dónde',
  'cuando',
  'cuándo',
  'qué',
  'que tal',
  'quiero',
  'necesito',
  'tengo',
  'usted',
  'señor',
  'señora',
  'señorita',
  'buenos días',
  'buenas tardes',
  'buenas noches',
];

/**
 * Heuristic transcript scan. Returns 'es' when the transcript contains
 * at least one strong Spanish marker; 'en' when it contains an English
 * "switch back" cue ("english please", "speak english"); null otherwise.
 *
 * Exported so tests can pin the behavior.
 */
export function detectLanguageFromTranscript(transcript: string): Language | null {
  const lower = transcript.toLowerCase();
  if (
    lower.includes('english please') ||
    lower.includes('speak english') ||
    lower.includes('in english')
  ) {
    return 'en';
  }
  for (const marker of SPANISH_MARKERS) {
    if (lower.includes(marker)) return 'es';
  }
  return null;
}

/**
 * Resolve the active language for a voice session given all the
 * available signals. See module header for resolution order.
 */
export function detectLanguage(input: DetectLanguageInput): Language {
  if (input.customerPreferredLanguage === 'en' || input.customerPreferredLanguage === 'es') {
    return input.customerPreferredLanguage;
  }
  if (input.transcriptLanguageHint === 'en' || input.transcriptLanguageHint === 'es') {
    return input.transcriptLanguageHint;
  }
  if (input.transcript && input.transcript.trim().length > 0) {
    const fromText = detectLanguageFromTranscript(input.transcript);
    if (fromText) return fromText;
  }
  if (input.tenantDefaultLanguage === 'en' || input.tenantDefaultLanguage === 'es') {
    return input.tenantDefaultLanguage;
  }
  return 'en';
}

/**
 * Lightweight predicate the FSM/adapter uses to detect a mid-call
 * language switch utterance ("english please", "hablo español").
 * Returns the requested target language or null when the utterance
 * is not a switch.
 */
export function detectLanguageSwitchIntent(transcript: string): Language | null {
  const lower = transcript.toLowerCase();
  if (
    lower.includes('english please') ||
    lower.includes('speak english') ||
    lower.includes('switch to english') ||
    lower.includes('in english')
  ) {
    return 'en';
  }
  if (
    lower.includes('hablo español') ||
    lower.includes('hablo espanol') ||
    lower.includes('en español') ||
    lower.includes('en espanol') ||
    lower.includes('habla español') ||
    lower.includes('habla espanol')
  ) {
    return 'es';
  }
  return null;
}
