/**
 * WS12 — the ONE consent model for outbound contact (voice + SMS).
 *
 * Before this module, the two outbound channels enforced two unrelated
 * fields with no cross-enforcement: voice read `customers.consent_status`
 * (migration 132), SMS read `customers.sms_consent`. A customer who revoked
 * by phone could still be texted, and vice versa. Both gates now derive
 * their decision here, on top of the append-only `consent_events` ledger
 * (migration 168).
 *
 * THE ASYMMETRY RULE (deliberate, one-directional):
 *
 *   - REVOCATION crosses channels. A standing revocation of a CONTACT
 *     consent kind ('sms' | 'marketing') — arriving via SMS STOP, portal,
 *     or a manual operator change — suppresses BOTH voice and SMS
 *     (revoke-anywhere-suppress-everywhere).
 *   - A GRANT never crosses channels. TCPA voice-call consent and SMS
 *     consent are formally distinct; an SMS START / marketing opt-in must
 *     NOT manufacture consent for autodialed voice calls, and a voice
 *     consent capture must not manufacture SMS consent. Each channel keeps
 *     its own affirmative signal (voice: `consent_status === 'granted'`;
 *     SMS: `sms_consent === true`), and a grant in the ledger can only ever
 *     CLEAR a prior revocation of the SAME kind — never create affirmative
 *     consent anywhere.
 *   - kind 'recording' is NOT a contact kind and never crosses to SMS. A
 *     caller objecting to being RECORDED has not revoked being CONTACTED —
 *     appointment confirmations keep flowing. (Voice-side, a recording
 *     objection still rolls `consent_status = 'revoked'` via
 *     `updateDerivedConsentStatus`, so today's outbound-call blocking for
 *     that caller is preserved through the voice channel's own affirmative
 *     signal.)
 *
 * Each gate's pre-existing per-channel fail-closed rules are preserved
 * unchanged (voice: no customer row → refuse; SMS: no consent context →
 * refuse). This module only ADDS the cross-channel revocation check.
 */
import type { ConsentKind, ConsentState } from './consent-events';

/**
 * The consent kinds that gate CONTACT (may I reach out to you?), as opposed
 * to 'recording' which gates capture of an in-progress conversation. Only
 * these participate in cross-channel revocation.
 */
export const CONTACT_CONSENT_KINDS = ['sms', 'marketing'] as const;
export type ContactConsentKind = (typeof CONTACT_CONSENT_KINDS)[number];

/** Structural subset of a ConsentEventRow — both Pg and in-memory rows fit. */
export interface ConsentLedgerEventLike {
  kind: ConsentKind;
  state: ConsentState;
}

export interface StandingContactRevocation {
  revoked: boolean;
  /** Which contact kind carries the standing revocation (first of sms, marketing). */
  via?: ContactConsentKind;
}

/**
 * Compute whether the ledger carries a STANDING revocation of any contact
 * consent kind. "Standing" = the latest EXPLICIT (granted|revoked) event of
 * that kind is 'revoked'; 'implicit' events are skipped (they are recording
 * disclosures, never contact-consent signals). A later grant of the SAME
 * kind clears that kind's revocation (STOP → START re-opt-in); a grant of a
 * DIFFERENT kind clears nothing (the asymmetry rule — see module header).
 * 'recording' events are ignored entirely: not a contact kind.
 *
 * @param eventsNewestFirst ledger rows for the phone, newest first — the
 *   order `ConsentEventRepository.listByPhone` returns.
 */
export function standingContactRevocation(
  eventsNewestFirst: readonly ConsentLedgerEventLike[],
): StandingContactRevocation {
  const latestExplicit = new Map<ContactConsentKind, ConsentState>();
  for (const event of eventsNewestFirst) {
    if (!(CONTACT_CONSENT_KINDS as readonly string[]).includes(event.kind)) continue;
    if (event.state !== 'granted' && event.state !== 'revoked') continue;
    const kind = event.kind as ContactConsentKind;
    if (!latestExplicit.has(kind)) latestExplicit.set(kind, event.state);
  }
  for (const kind of CONTACT_CONSENT_KINDS) {
    if (latestExplicit.get(kind) === 'revoked') return { revoked: true, via: kind };
  }
  return { revoked: false };
}

export type OutboundConsentChannel = 'voice' | 'sms';

export type OutboundConsentDecisionReason =
  /** Number is on the tenant DNC list — absolute block, both channels. */
  | 'dnc'
  /** A standing contact-kind revocation on ANY channel — blocks both. */
  | 'cross_channel_revoked'
  /** The requested channel's own affirmative consent is absent/refused. */
  | 'no_channel_consent'
  /** SMS only: the send carried no consent context / tenant — fail closed. */
  | 'missing_channel_context'
  /** Voice only: no customer row for the number — fail closed. */
  | 'customer_not_found';

export interface OutboundConsentDecision {
  allowed: boolean;
  reason?: OutboundConsentDecisionReason;
  /** Set when reason === 'cross_channel_revoked'. */
  revokedVia?: ContactConsentKind;
}

export type VoiceConsentStatus = 'not_requested' | 'granted' | 'revoked' | 'expired';

export interface ResolveOutboundConsentInput {
  channel: OutboundConsentChannel;
  /** Result of the tenant DNC-list lookup for this number. */
  dncListed: boolean;
  /** Consent ledger rows for the number, newest first (listByPhone order). */
  ledgerEvents: readonly ConsentLedgerEventLike[];
  /** Voice channel's own affirmative signal — required when channel==='voice'. */
  voice?: {
    customerFound: boolean;
    consentStatus?: VoiceConsentStatus;
  };
  /** SMS channel's own affirmative signal — required when channel==='sms'. */
  sms?: {
    /** False when the send carried no consent snapshot / no tenant scope. */
    hasConsentContext: boolean;
    smsConsent?: boolean;
  };
}

/**
 * The single decision core both outbound gates route through
 * (voice/outbound-consent.ts and notifications/gated-message-delivery.ts).
 * Pure and synchronous — callers gather the inputs (DNC lookup, ledger
 * read, customer row) with their own transaction/audit discipline, then
 * derive here so the cross-channel rule lives in exactly one place.
 *
 * Check order: DNC (absolute) → cross-channel contact revocation → the
 * requested channel's own fail-closed affirmative rules (unchanged from
 * each gate's pre-WS12 behavior — this function never weakens them).
 */
export function resolveOutboundConsent(
  input: ResolveOutboundConsentInput,
): OutboundConsentDecision {
  if (input.dncListed) return { allowed: false, reason: 'dnc' };

  const revocation = standingContactRevocation(input.ledgerEvents);
  if (revocation.revoked) {
    return { allowed: false, reason: 'cross_channel_revoked', revokedVia: revocation.via };
  }

  if (input.channel === 'voice') {
    // Pre-WS12 voice rules, verbatim: no customer row → fail closed;
    // anything but an explicit 'granted' → refuse. A grant ARRIVES here only
    // via the voice channel's own consent capture — never from an SMS/
    // marketing ledger grant (deriveConsentStatus no longer rolls grants up).
    if (!input.voice?.customerFound) {
      return { allowed: false, reason: 'customer_not_found' };
    }
    if (input.voice.consentStatus !== 'granted') {
      return { allowed: false, reason: 'no_channel_consent' };
    }
    return { allowed: true };
  }

  // Pre-WS12 SMS rules, verbatim: a customer send with no consent context
  // fails closed; the stored sms_consent flag must be explicitly true.
  if (!input.sms?.hasConsentContext) {
    return { allowed: false, reason: 'missing_channel_context' };
  }
  if (input.sms.smsConsent !== true) {
    return { allowed: false, reason: 'no_channel_consent' };
  }
  return { allowed: true };
}
