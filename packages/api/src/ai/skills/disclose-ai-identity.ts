/**
 * disclose_ai_identity skill — state-aware AI/bot identity disclosure (Epic 9.b).
 *
 * DISTINCT from `disclose-recording` (which discloses call RECORDING). This
 * discloses that the caller is speaking with an AI. Bot-disclosure laws in
 * some states require it (e.g. California's B.O.T. Act, SB 1001). Played at
 * call start, after the greeting. Per-tenant editable copy with a built-in
 * default; tenants may also opt in to play it everywhere.
 *
 * Pure decision + copy here (fully unit-tested, no I/O); the greeting-path
 * wiring + consent-ledger/audit are the integration layer.
 *
 * ⚠️  Legal review required before production use. The state list and copy are
 *     a best-effort starting point — confirm statutes per jurisdiction.
 */
import type { Language } from '../i18n/i18n';

/**
 * US states with AI/bot identity-disclosure requirements (best-effort starting
 * point — legal review required). Kept as a small set, mirroring the
 * recording-disclosure two-party table; extend as counsel confirms statutes.
 */
const AI_DISCLOSURE_REQUIRED_STATES: ReadonlySet<string> = new Set([
  'CA', // B.O.T. Act — Cal. Bus. & Prof. Code § 17940 et seq. (SB 1001)
  'FL', // per product spec — confirm statute in legal review
]);

/** True when the caller's US state legally requires an AI-identity disclosure. */
export function requiresAiDisclosure(callerState: string | null | undefined): boolean {
  const state = callerState?.toUpperCase().trim();
  if (!state) return false; // unknown state → not legally required (tenant opt-in still applies)
  return AI_DISCLOSURE_REQUIRED_STATES.has(state);
}

/** Built-in default disclosure copy. `{business_name}` is substituted. */
export const DEFAULT_AI_DISCLOSURE_TEMPLATE_EN =
  "Just so you know, you're speaking with {business_name}'s AI virtual assistant.";
export const DEFAULT_AI_DISCLOSURE_TEMPLATE_ES =
  'Para que lo sepa, está hablando con el asistente virtual de inteligencia artificial de {business_name}.';

function substitute(template: string, businessName: string): string {
  const name = (businessName ?? '').trim() || 'our team';
  return template.replace(/\{business_name\}/g, name).trim();
}

/**
 * Build the AI-disclosure sentence. A tenant `customText` override wins (with
 * `{business_name}` substitution); otherwise the language-appropriate default.
 */
export function buildAiDisclosureText(input: {
  businessName: string;
  language?: Language;
  customText?: string | null;
}): string {
  const custom = input.customText?.trim();
  if (custom) return substitute(custom, input.businessName);
  const template =
    (input.language ?? 'en') === 'es'
      ? DEFAULT_AI_DISCLOSURE_TEMPLATE_ES
      : DEFAULT_AI_DISCLOSURE_TEMPLATE_EN;
  return substitute(template, input.businessName);
}

export type AiDisclosureReason = 'state_required' | 'tenant_enabled' | 'none';

export interface AiDisclosureInput {
  channel: 'telephony' | 'inapp';
  /** ISO 3166-2 US state (e.g. 'CA'). Null/undefined → not legally required. */
  callerState?: string | null;
  businessName: string;
  language?: Language;
  /** Per-tenant override of the wording; empty/undefined → built-in default. */
  customText?: string | null;
  /** Tenant opt-in: play the disclosure even where not legally required. Default false. */
  tenantEnabled?: boolean;
}

export interface AiDisclosureResult {
  /** Whether the AI disclosure should be spoken on this call. */
  shouldDisclose: boolean;
  /** The disclosure text (empty when shouldDisclose is false). */
  text: string;
  reason: AiDisclosureReason;
}

/**
 * Decide whether — and what — to disclose. In-app callers know they're using
 * the product (ToS consent), so no spoken disclosure. On telephony it plays
 * when the caller's state requires it OR the tenant opted in.
 */
export function resolveAiDisclosure(input: AiDisclosureInput): AiDisclosureResult {
  if (input.channel === 'inapp') {
    return { shouldDisclose: false, text: '', reason: 'none' };
  }
  const stateRequired = requiresAiDisclosure(input.callerState);
  const tenantEnabled = input.tenantEnabled === true;
  if (!stateRequired && !tenantEnabled) {
    return { shouldDisclose: false, text: '', reason: 'none' };
  }
  return {
    shouldDisclose: true,
    text: buildAiDisclosureText(input),
    reason: stateRequired ? 'state_required' : 'tenant_enabled',
  };
}
