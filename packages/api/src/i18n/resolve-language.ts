/**
 * P11-002 — shared language resolution for non-voice surfaces (comms,
 * notifications). Wraps the voice-stack `detectLanguage` resolver so the
 * resolution order is identical everywhere:
 *   customer.preferredLanguage ?? tenant.defaultLanguage ?? 'en'.
 *
 * Lives outside `ai/` so the notifications layer can import it without
 * taking a dependency on the AI module graph.
 */
import { detectLanguage } from '../ai/orchestration/language-detector';
import type { Language } from '../ai/i18n/i18n';

/**
 * Narrow a free-form language string (customers.preferred_language is a
 * BCP-47 TEXT column, e.g. 'en-US', 'vi') to a supported Language, or
 * null when unsupported so the caller falls through to the tenant
 * default.
 */
export function narrowLanguage(value: string | null | undefined): Language | null {
  if (value === 'en' || value === 'es') return value;
  return null;
}

/**
 * Resolve the effective language for a customer-facing message. No
 * transcript signal is available off the voice path, so this is purely
 * customer override → tenant default → 'en'.
 */
export function resolveCustomerLanguage(args: {
  customerPreferredLanguage?: string | null;
  tenantDefaultLanguage?: string | null;
}): Language {
  return detectLanguage({
    customerPreferredLanguage: narrowLanguage(args.customerPreferredLanguage),
    tenantDefaultLanguage: narrowLanguage(args.tenantDefaultLanguage),
  });
}
