/**
 * Returning-customer greeting (Feature 3).
 *
 * The inbound flow already identifies the caller (`identify-caller.ts`) and can
 * fetch their history (`summarize-customer-history.ts`), but the spoken opener
 * never referenced it. Avoca's demo-killer is exactly this moment: "Hi John,
 * are you calling about your AC tune-up from March?" — instant recognition.
 *
 * This module turns a resolved caller + last-service into that opener, in the
 * caller's language, using the typed i18n catalog. It is pure: the adapter
 * decides when to call it (returning caller with a usable name) and the
 * compliance disclosure is appended by the existing greeting path, exactly as
 * for `buildTelephonyGreeting`.
 */

import { t, type Language } from '../../ai/i18n/i18n';

/** Minimal last-service shape needed to reference a prior visit. */
export interface LastService {
  /** When the service happened (UTC instant). */
  date: Date;
  /** Short human label, e.g. "AC tune-up" or "water heater repair". */
  type: string;
}

export interface ReturningGreetingInput {
  /** Caller's preferred display name (usually first name). */
  customerName: string;
  /** Conversation language; controls catalog + month localization. */
  language?: Language;
  /** Most recent completed service, when known. */
  lastService?: LastService | null;
  /** IANA timezone for rendering the service month. Defaults to UTC. */
  timezone?: string;
}

const LOCALE_BY_LANGUAGE: Record<Language, string> = {
  en: 'en-US',
  es: 'es-ES',
};

/**
 * Build the returning-customer opener.
 *
 * - With a usable name + last service → references the prior visit by month
 *   ("…about your AC tune-up from March?").
 * - With a usable name but no service → "Hi {name}, welcome back. How can I
 *   help you today?".
 * - With no usable name → `null`, signalling the caller should fall through to
 *   the standard `buildTelephonyGreeting` path.
 *
 * The returned string never includes the recording disclosure — the telephony
 * adapter appends that uniformly afterward, identical to the default greeting.
 */
export function buildReturningCustomerGreeting(input: ReturningGreetingInput): string | null {
  const name = input.customerName?.trim();
  if (!name) return null;

  const language: Language = input.language ?? 'en';

  if (input.lastService && input.lastService.type.trim()) {
    const month = monthLabel(input.lastService.date, language, input.timezone ?? 'UTC');
    return t('identify.returning_with_service', language, {
      name,
      service: input.lastService.type.trim(),
      month,
    });
  }

  return t('identify.returning_named', language, { name });
}

/** Localized full month name (e.g. "March" / "marzo") in the tenant timezone. */
function monthLabel(date: Date, language: Language, timezone: string): string {
  const locale = LOCALE_BY_LANGUAGE[language] ?? 'en-US';
  try {
    return new Intl.DateTimeFormat(locale, { month: 'long', timeZone: timezone }).format(date);
  } catch {
    // Invalid timezone — fall back to UTC rather than throwing on a call path.
    return new Intl.DateTimeFormat(locale, { month: 'long', timeZone: 'UTC' }).format(date);
  }
}
