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
 * Business name: resolved PER SEND from the tenant's own settings (the same
 * `settingsRepo.findByTenant(...).businessName` lookup the transactional SMS
 * path uses), never captured at boot — a boot-time name is the platform's, not
 * the tenant's, so every tenant's dropped caller was told the wrong business.
 * The platform name (`TWILIO_BUSINESS_NAME`) and then 'our team' are fallbacks
 * for a tenant with no name only, and a failed lookup falls back (and logs)
 * rather than blocking the send.
 *
 * PII invariant: only the curated context cue (state-aware-cue /
 * extract-context-cue — never transcript-derived text) and the business
 * name reach the prompt. Nothing else from the row is passed.
 */
import type { Logger } from '../../logging/logger';
import {
  composeBrandVoiceMessage,
  trimToMaxChars,
  type ComposeBrandVoiceDeps,
} from '../../ai/brand-voice/composer';
import type { RecoveryMessageComposer } from './dropped-call-handler';

/** Last resort when neither the tenant nor the platform has a business name. */
const DEFAULT_BUSINESS_NAME = 'our team';

export interface RecoveryComposerOptions {
  /**
   * Brand-voice composer deps (gateway, settingsRepo, standingInstructionRepo).
   * `settingsRepo` also supplies the tenant's business name, per send.
   */
  composerDeps: ComposeBrandVoiceDeps;
  /**
   * Platform-wide name (`TWILIO_BUSINESS_NAME`), used ONLY when the tenant has
   * no business name of its own or the lookup fails. Unset/blank → 'our team'.
   * Never the primary source — the tenant's name is resolved per send.
   */
  fallbackBusinessName?: string;
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
  // Reuse the composer's single maxChars authority (surrogate-safe, strips
  // trailing punctuation, guarantees <= maxChars) rather than a second
  // hand-rolled truncation that could split an astral char or exceed the cap.
  return trimToMaxChars(text, input.maxChars);
}

export function createRecoveryComposer(options: RecoveryComposerOptions): RecoveryMessageComposer {
  const { composerDeps, aiEnabled, logger } = options;
  const fallbackBusinessName = options.fallbackBusinessName?.trim() || DEFAULT_BUSINESS_NAME;

  // Failure-open: a settings outage must not block the send (the handler would
  // otherwise retry the row until it expires). A brand-new settings row has
  // businessName '' — that, a missing row, and a failed read all fall back.
  const resolveBusinessName = async (tenantId: string): Promise<string> => {
    try {
      const settings = await composerDeps.settingsRepo.findByTenant(tenantId);
      const name = settings?.businessName?.trim();
      if (name) return name;
    } catch (err) {
      logger.warn('recovery composer: tenant business name lookup failed — using fallback name', {
        tenantId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return fallbackBusinessName;
  };

  return async ({ tenantId, contextCue, maxChars }) => {
    const businessName = await resolveBusinessName(tenantId);
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
