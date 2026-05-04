/**
 * Recording disclosure copy for inbound call recording.
 *
 * ⚠️  Legal review required before production use.
 *     See P8-005. The copy below is a best-effort starting point;
 *     it must be reviewed by legal counsel before any customer-facing
 *     deployment that involves actual call recording.
 *
 * US two-party (all-party) consent states require that ALL parties on a
 * call be informed of and (in some states) affirmatively consent to
 * recording. Failing to comply can expose the business to civil and
 * criminal liability.
 *
 * Reference: ECPA (federal, one-party), plus state wiretap statutes.
 * Newest addition: OR joined the two-party list (ORS 165.543, as amended).
 */

/** US states requiring two-party (all-party) consent for call recording. */
export const TWO_PARTY_CONSENT_STATES: ReadonlySet<string> = new Set([
  'CA', // Penal Code § 632
  'CT', // Conn. Gen. Stat. § 52-570d
  'FL', // Fla. Stat. § 934.03
  'IL', // 720 ILCS 5/14-2
  'MD', // Md. Code, Cts. & Jud. Proc. § 10-402
  'MA', // Mass. Gen. Laws ch. 272, § 99
  'MT', // Mont. Code Ann. § 45-8-213
  'NV', // Nev. Rev. Stat. § 200.620
  'NH', // N.H. Rev. Stat. § 570-A:2
  'OR', // ORS 165.543
  'PA', // 18 Pa. Cons. Stat. § 5703
  'WA', // Wash. Rev. Code § 9.73.030
]);

export interface RecordingDisclosureContext {
  /**
   * ISO 3166-2 US state code (e.g. 'CA', 'TX').
   * Null / undefined → default to two-party copy (safer fallback when
   * caller location is unknown).
   */
  callerState?: string | null;
  /** Business name inserted into written disclosure for audit clarity. */
  businessName: string;
}

export interface RecordingDisclosureText {
  /** Short spoken disclosure (TTS). Keep concise — played over telephone. */
  spoken: string;
  /** Longer written version for logging and audit trail. */
  written: string;
  /** Whether two-party consent rules apply for this disclosure. */
  requiresTwoPartyConsent: boolean;
}

/**
 * Returns the appropriate recording disclosure text for the given context.
 *
 * Default (unknown state) → two-party copy: safer legal posture when we
 * cannot confirm the caller is in a one-party state.
 */
export function getRecordingDisclosure(
  ctx: RecordingDisclosureContext
): RecordingDisclosureText {
  const state = ctx.callerState?.toUpperCase().trim();
  const requiresTwoPartyConsent =
    !state || TWO_PARTY_CONSENT_STATES.has(state);

  if (requiresTwoPartyConsent) {
    return {
      spoken:
        'This call may be recorded for quality and training purposes. ' +
        'By continuing, you consent to this recording.',
      written:
        `${ctx.businessName} wishes to inform you that this call may be recorded ` +
        'for quality assurance and training purposes. By remaining on the line, ' +
        'you acknowledge and consent to the recording of this call.',
      requiresTwoPartyConsent: true,
    };
  }

  return {
    spoken: 'This call may be recorded for quality and training purposes.',
    written:
      `${ctx.businessName} wishes to inform you that this call may be recorded ` +
      'for quality assurance and training purposes.',
    requiresTwoPartyConsent: false,
  };
}
