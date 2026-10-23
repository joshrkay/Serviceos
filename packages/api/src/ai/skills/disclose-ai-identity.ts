/**
 * disclose_ai_identity skill — tells a phone caller they are talking to a
 * virtual assistant, not a person (Epic 9.b; wired by PRIV-4).
 *
 * DISTINCT from `disclose-recording` (which discloses call RECORDING). This
 * says WHO is on the line. It is spoken on EVERY telephony call, inside the
 * greeting turn (`buildTelephonyGreeting` places it straight after the opener
 * or the tenant's own greeting, before the recording notice), so a tenant
 * persona name ("This is Sarah.") is never left standing as a human
 * introduction.
 *
 * Deliberately NOT gated on the caller's state: the caller's area code is a
 * weak proxy for where they are (ported mobiles, VoIP), and an unplaced
 * number must disclose. Bot-disclosure laws (e.g. California's B.O.T. Act,
 * Cal. Bus. & Prof. Code § 17940) are the reason the notice exists; playing
 * it on every call is the fail-safe posture.
 *
 * Caller-facing copy is plain words ("virtual assistant", "not a live
 * person"); it never says "AI".
 *
 * Ledgered the way `discloseRecording` ledgers the recording notice: the
 * write is a DEFERRED thunk the transport commits at its own point of
 * evidence that the caller heard the greeting (generating copy is not
 * evidence). The ledger is an `audit_events` row — an identity notice is not
 * a consent, so it does not belong in `consent_events`.
 *
 * ⚠️  Legal review required: counsel should confirm the wording and whether
 *     any jurisdiction needs a specific placement.
 */
import type { Language } from '../i18n/i18n';
import { createAuditEvent, type AuditRepository } from '../../audit/audit';

/** Built-in notice copy. `{business_name}` is substituted when a template uses it. */
export const DEFAULT_AI_DISCLOSURE_TEMPLATE_EN =
  "Just so you know, I'm a virtual assistant, not a live person.";
export const DEFAULT_AI_DISCLOSURE_TEMPLATE_ES =
  'Para que lo sepa, soy un asistente virtual, no una persona real.';

/**
 * Audit event type of the ledger row. The activity feed turns event types
 * into owner-visible words (`labelForEvent`), so the name stays plain.
 */
export const AI_DISCLOSURE_PLAYED_EVENT = 'virtual_assistant_notice.played';

function substitute(template: string, businessName: string): string {
  const name = (businessName ?? '').trim() || 'our team';
  return template.replace(/\{business_name\}/g, name).trim();
}

/**
 * Build the notice sentence. A per-tenant `customText` override wins (with
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

export interface AiDisclosureInput {
  tenantId: string;
  businessName: string;
  language?: Language;
  /** Per-tenant override of the wording; empty/undefined → built-in default. */
  customText?: string | null;
  /** Ledger target. Without it the commit is a no-op (the notice still plays). */
  auditRepo?: AuditRepository;
  /** The call's voice session — the audit row's entity and correlation id. */
  voiceSessionId: string;
  actorId: string;
  /** Which transport spoke it (the session channel), recorded on the row. */
  channel?: string;
}

export interface AiDisclosureResult {
  /** The sentence to speak inside the greeting turn. Never empty. */
  disclosureText: string;
  /**
   * Appends the `virtual_assistant_notice.played` audit row. The caller
   * decides WHEN — at the same point of evidence as the recording notice's
   * `commitConsentLedger`. Idempotent (a second call is a no-op) and
   * best-effort: never rejects, so a ledger failure never drops a live call.
   * Needs no caller phone, so a blocked caller ID is still ledgered.
   */
  commitDisclosureLedger: () => Promise<void>;
}

/** Generate the notice for a phone call, plus its deferred ledger write. */
export function discloseAiIdentity(input: AiDisclosureInput): AiDisclosureResult {
  const tenantWording = Boolean(input.customText?.trim());
  const disclosureText = buildAiDisclosureText(input);
  const auditRepo = input.auditRepo;
  let committed = false;
  const commitDisclosureLedger = async (): Promise<void> => {
    if (!auditRepo || committed) return;
    committed = true;
    try {
      await auditRepo.create(
        createAuditEvent({
          tenantId: input.tenantId,
          actorId: input.actorId,
          actorRole: 'system',
          eventType: AI_DISCLOSURE_PLAYED_EVENT,
          entityType: 'voice_session',
          entityId: input.voiceSessionId,
          correlationId: input.voiceSessionId,
          metadata: {
            text: disclosureText,
            wording: tenantWording ? 'tenant' : 'default',
            language: input.language ?? 'en',
            ...(input.channel ? { channel: input.channel } : {}),
          },
        }),
      );
    } catch {
      // Swallow — the ledger must never block or drop the call.
    }
  };
  return { disclosureText, commitDisclosureLedger };
}
