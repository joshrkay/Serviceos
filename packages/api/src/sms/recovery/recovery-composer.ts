/**
 * P8-015 — production RecoveryMessageComposer.
 *
 * Routes through the shared brand-voice composer (P4-015, LLM gateway only)
 * with the registered `dropped_call_recovery_sms` intent. Two behaviors the
 * daily-digest wiring establishes and this copies:
 *
 *   - The composer only runs when a real AI provider key is configured
 *     (`aiEnabled`) — the mock gateway's canned output must never reach a
 *     customer.
 *   - Composer failure falls back to a deterministic template instead of
 *     throwing: the handler treats compose errors as infra errors and
 *     retries the row, so an LLM outage would otherwise mean silence until
 *     the row expires. For a time-sensitive recovery the template IS the
 *     product.
 *
 * PII invariant: only the curated context cue (state-aware-cue /
 * extract-context-cue — never transcript-derived text) and the business
 * name reach the prompt. Nothing else from the row is passed.
 */
import type { Logger } from '../../logging/logger';
import {
  composeBrandVoiceMessage,
  type ComposeBrandVoiceDeps,
} from '../../ai/brand-voice/composer';
import type { RecoveryMessageComposer } from './dropped-call-handler';

export interface RecoveryComposerOptions {
  /** Brand-voice composer deps (gateway, settingsRepo, standingInstructionRepo). */
  composerDeps: ComposeBrandVoiceDeps;
  /** Shown in the fallback template greeting. */
  businessName: string;
  /**
   * True only when a real AI provider key is configured. When false, the
   * deterministic template is used directly — never the mock gateway.
   */
  aiEnabled: boolean;
  logger: Logger;
}

/** Deterministic template used when AI is unavailable or the composer fails. */
export function recoveryFallbackTemplate(input: {
  businessName: string;
  contextCue: string;
  maxChars: number;
}): string {
  const parts = [`Hi — this is ${input.businessName}. We got cut off on your call.`];
  if (input.contextCue) parts.push(input.contextCue);
  parts.push("Reply and we'll pick up where we left off.");
  const text = parts.join(' ');
  if (text.length <= input.maxChars) return text;
  // Never send a mid-word cut: trim at the last whitespace inside budget.
  const slice = text.slice(0, input.maxChars);
  const lastSpace = slice.lastIndexOf(' ');
  return lastSpace > 0 ? slice.slice(0, lastSpace) : slice;
}

export function createRecoveryComposer(options: RecoveryComposerOptions): RecoveryMessageComposer {
  const { composerDeps, businessName, aiEnabled, logger } = options;

  return async ({ tenantId, contextCue, maxChars }) => {
    if (!aiEnabled) {
      return recoveryFallbackTemplate({ businessName, contextCue, maxChars });
    }
    try {
      const result = await composeBrandVoiceMessage(
        {
          tenantId,
          intent: 'dropped_call_recovery_sms',
          // PII opt-in: ONLY the curated cue + business name reach the prompt.
          context: { contextCue, businessName },
          maxChars,
        },
        composerDeps,
      );
      return result.text;
    } catch (err) {
      // Degrade to the template rather than throwing: a compose throw makes
      // the handler retry the row every sweep until expiry — silence during
      // exactly the window the recovery exists for.
      logger.warn('recovery composer failed — using fallback template', {
        tenantId,
        error: err instanceof Error ? err.message : String(err),
      });
      return recoveryFallbackTemplate({ businessName, contextCue, maxChars });
    }
  };
}
