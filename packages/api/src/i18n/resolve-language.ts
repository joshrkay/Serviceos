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
 * BCP-47 TEXT column, e.g. 'en-US', 'es-MX', 'vi') to a supported Language.
 * The primary subtag is matched case-insensitively, so region-tagged values
 * like 'es-MX' resolve to 'es'. Truly unsupported languages (e.g. 'vi')
 * return null so the caller falls through to the tenant default.
 */
export function narrowLanguage(value: string | null | undefined): Language | null {
  if (!value) return null;
  const primary = value.trim().toLowerCase().split('-')[0];
  if (primary === 'en' || primary === 'es') return primary;
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
