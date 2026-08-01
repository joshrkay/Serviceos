/**
 * WS12 / D-017 — one consent model: the shared resolver matrix.
 *
 * Pins the asymmetry rule both outbound gates depend on:
 *   - revocation of a CONTACT kind (sms/marketing) on ANY channel blocks BOTH
 *     voice and SMS;
 *   - a grant never crosses channels (an SMS START / marketing opt-in cannot
 *     manufacture voice consent, and vice versa);
 *   - kind 'recording' never participates in cross-channel suppression;
 *   - each channel's pre-existing fail-closed rules are preserved.
 */
import { describe, it, expect } from 'vitest';
import {
  CONTACT_CONSENT_KINDS,
  resolveOutboundConsent,
  standingContactRevocation,
  type ConsentLedgerEventLike,
} from '../../src/compliance/resolve-outbound-consent';

/** Ledger rows NEWEST FIRST (the listByPhone contract). */
function events(
  ...rows: Array<[ConsentLedgerEventLike['kind'], ConsentLedgerEventLike['state']]>
): ConsentLedgerEventLike[] {
  return rows.map(([kind, state]) => ({ kind, state }));
}

describe('standingContactRevocation — kind-scoped standing revocation', () => {
  it('contact kinds are exactly sms + marketing (recording never crosses)', () => {
    expect([...CONTACT_CONSENT_KINDS]).toEqual(['sms', 'marketing']);
  });

  it('empty ledger → no revocation', () => {
    expect(standingContactRevocation([])).toEqual({ revoked: false });
  });

  it('sms revoked (STOP) → standing revocation via sms', () => {
    expect(standingContactRevocation(events(['sms', 'revoked']))).toEqual({
      revoked: true,
      via: 'sms',
    });
  });

  it('marketing revoked → standing revocation via marketing', () => {
    expect(standingContactRevocation(events(['marketing', 'revoked']))).toEqual({
      revoked: true,
      via: 'marketing',
    });
  });

  it('recording revoked alone is NOT a contact revocation', () => {
    expect(standingContactRevocation(events(['recording', 'revoked']))).toEqual({
      revoked: false,
    });
  });

  it('a later same-kind grant clears the revocation (STOP → START)', () => {
    // newest first: granted is the latest sms event.
    expect(
      standingContactRevocation(events(['sms', 'granted'], ['sms', 'revoked'])),
    ).toEqual({ revoked: false });
  });

  it('a grant of a DIFFERENT kind clears nothing (asymmetry)', () => {
    // marketing grant is newest, but the standing sms revocation remains.
    expect(
      standingContactRevocation(events(['marketing', 'granted'], ['sms', 'revoked'])),
    ).toEqual({ revoked: true, via: 'sms' });
  });

  it('implicit events are skipped (recording disclosures never move contact consent)', () => {
    expect(
      standingContactRevocation(events(['sms', 'implicit'], ['sms', 'revoked'])),
    ).toEqual({ revoked: true, via: 'sms' });
  });
});

describe('resolveOutboundConsent — voice channel', () => {
  const grantedVoice = { customerFound: true, consentStatus: 'granted' as const };

  it('allows a granted customer with a clean ledger', () => {
    expect(
      resolveOutboundConsent({
        channel: 'voice',
        dncListed: false,
        ledgerEvents: [],
        voice: grantedVoice,
      }),
    ).toEqual({ allowed: true });
  });

  it('SMS STOP blocks the CALL even while consent_status still reads granted', () => {
    const decision = resolveOutboundConsent({
      channel: 'voice',
      dncListed: false,
      ledgerEvents: events(['sms', 'revoked']),
      voice: grantedVoice,
    });
    expect(decision).toEqual({
      allowed: false,
      reason: 'cross_channel_revoked',
      revokedVia: 'sms',
    });
  });

  it('marketing revocation blocks the call too', () => {
    expect(
      resolveOutboundConsent({
        channel: 'voice',
        dncListed: false,
        ledgerEvents: events(['marketing', 'revoked']),
        voice: grantedVoice,
      }).reason,
    ).toBe('cross_channel_revoked');
  });

  it('a recording objection does NOT cross-block via the ledger — voice blocking for it flows through consent_status (rollup), preserving today’s semantics', () => {
    // Ledger-only recording revocation + still-granted status → allowed by the
    // resolver; in production the objection also rolled consent_status to
    // 'revoked', which the next case pins.
    expect(
      resolveOutboundConsent({
        channel: 'voice',
        dncListed: false,
        ledgerEvents: events(['recording', 'revoked']),
        voice: grantedVoice,
      }),
    ).toEqual({ allowed: true });
    expect(
      resolveOutboundConsent({
        channel: 'voice',
        dncListed: false,
        ledgerEvents: events(['recording', 'revoked']),
        voice: { customerFound: true, consentStatus: 'revoked' },
      }).reason,
    ).toBe('no_channel_consent');
  });

  it('an sms/marketing GRANT does not enable voice (grant never crosses)', () => {
    for (const kind of ['sms', 'marketing'] as const) {
      expect(
        resolveOutboundConsent({
          channel: 'voice',
          dncListed: false,
          ledgerEvents: events([kind, 'granted']),
          voice: { customerFound: true, consentStatus: 'not_requested' },
        }).reason,
      ).toBe('no_channel_consent');
    }
  });

  it('fail-closed rules preserved: no customer row / non-granted statuses refuse', () => {
    expect(
      resolveOutboundConsent({
        channel: 'voice',
        dncListed: false,
        ledgerEvents: [],
        voice: { customerFound: false },
      }).reason,
    ).toBe('customer_not_found');
    for (const consentStatus of ['not_requested', 'revoked', 'expired'] as const) {
      expect(
        resolveOutboundConsent({
          channel: 'voice',
          dncListed: false,
          ledgerEvents: [],
          voice: { customerFound: true, consentStatus },
        }).reason,
      ).toBe('no_channel_consent');
    }
  });

  it('DNC is the absolute block', () => {
    expect(
      resolveOutboundConsent({
        channel: 'voice',
        dncListed: true,
        ledgerEvents: [],
        voice: grantedVoice,
      }).reason,
    ).toBe('dnc');
  });
});

describe('resolveOutboundConsent — sms channel', () => {
  const consentedSms = { hasConsentContext: true, smsConsent: true };

  it('allows a consented customer with a clean ledger', () => {
    expect(
      resolveOutboundConsent({
        channel: 'sms',
        dncListed: false,
        ledgerEvents: [],
        sms: consentedSms,
      }),
    ).toEqual({ allowed: true });
  });

  it('a voice-channel (portal/manual) sms revocation blocks SMS even with sms_consent=true', () => {
    expect(
      resolveOutboundConsent({
        channel: 'sms',
        dncListed: false,
        ledgerEvents: events(['sms', 'revoked']),
        sms: consentedSms,
      }),
    ).toEqual({ allowed: false, reason: 'cross_channel_revoked', revokedVia: 'sms' });
  });

  it('a marketing revocation blocks SMS too', () => {
    expect(
      resolveOutboundConsent({
        channel: 'sms',
        dncListed: false,
        ledgerEvents: events(['marketing', 'revoked']),
        sms: consentedSms,
      }).reason,
    ).toBe('cross_channel_revoked');
  });

  it('a recording objection does NOT suppress SMS (confirmations keep flowing)', () => {
    expect(
      resolveOutboundConsent({
        channel: 'sms',
        dncListed: false,
        ledgerEvents: events(['recording', 'revoked']),
        sms: consentedSms,
      }),
    ).toEqual({ allowed: true });
  });

  it('a marketing GRANT does not enable sms (grant never crosses; per-channel flag rules)', () => {
    expect(
      resolveOutboundConsent({
        channel: 'sms',
        dncListed: false,
        ledgerEvents: events(['marketing', 'granted']),
        sms: { hasConsentContext: true, smsConsent: false },
      }).reason,
    ).toBe('no_channel_consent');
  });

  it('STOP → START re-opt-in clears the sms revocation (send allowed again)', () => {
    expect(
      resolveOutboundConsent({
        channel: 'sms',
        dncListed: false,
        ledgerEvents: events(['sms', 'granted'], ['sms', 'revoked']),
        sms: consentedSms,
      }),
    ).toEqual({ allowed: true });
  });

  it('fail-closed rules preserved: missing context / flag not true refuse', () => {
    expect(
      resolveOutboundConsent({
        channel: 'sms',
        dncListed: false,
        ledgerEvents: [],
        sms: { hasConsentContext: false },
      }).reason,
    ).toBe('missing_channel_context');
    expect(
      resolveOutboundConsent({
        channel: 'sms',
        dncListed: false,
        ledgerEvents: [],
        sms: { hasConsentContext: true, smsConsent: false },
      }).reason,
    ).toBe('no_channel_consent');
  });

  it('DNC is the absolute block', () => {
    expect(
      resolveOutboundConsent({
        channel: 'sms',
        dncListed: true,
        ledgerEvents: [],
        sms: consentedSms,
      }).reason,
    ).toBe('dnc');
  });
});
