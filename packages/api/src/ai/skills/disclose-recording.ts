/**
 * disclose_recording skill — state-aware two-party consent disclosure.
 *
 * Plays (or returns text for) the call recording disclosure immediately
 * after greeting, before any caller utterance is captured.
 *
 * Design decisions
 * ─────────────────
 * - in-app channel: users consent via ToS at account creation; no spoken
 *   disclosure is needed or appropriate. Return disclosed=true immediately.
 * - telephony channel: generate disclosure text keyed to the caller's US
 *   state. Two-party-consent states (CA, CT, FL, IL, MD, MA, MT, NV, NH,
 *   OR, PA, WA) receive the consent-required copy; all others receive the
 *   shorter one-party copy. Unknown/null state defaults to two-party copy
 *   (safer legal posture).
 * - TTS failure is non-fatal: the TwiML <Say> path can use the disclosure
 *   text directly, so a TTS outage must never block the disclosure itself.
 *
 * ⚠️  Legal review required before production use.
 *     The disclosure copy is a best-effort starting point. See P8-005 and
 *     packages/shared/src/legal/recording-disclosure.ts for the canonical
 *     copy and statutory references.
 */

import { TtsProvider } from '../tts/tts-provider';

// ---------------------------------------------------------------------------
// Two-party consent state list
// Canonical source: packages/shared/src/legal/recording-disclosure.ts
// Duplicated here to stay within this package's TypeScript rootDir boundary.
// ---------------------------------------------------------------------------

/** US states requiring two-party (all-party) consent for call recording. */
const TWO_PARTY_CONSENT_STATES: ReadonlySet<string> = new Set([
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

// ---------------------------------------------------------------------------
// Disclosure copy
// ---------------------------------------------------------------------------

interface DisclosureTextPair {
  spoken: string;
  written: string;
  requiresTwoPartyConsent: boolean;
}

function buildDisclosureText(
  callerState: string | null | undefined,
  businessName: string
): DisclosureTextPair {
  const state = callerState?.toUpperCase().trim();
  const requiresTwoPartyConsent = !state || TWO_PARTY_CONSENT_STATES.has(state);

  if (requiresTwoPartyConsent) {
    return {
      spoken:
        'This call may be recorded for quality and training purposes. ' +
        'By continuing, you consent to this recording.',
      written:
        `${businessName} wishes to inform you that this call may be recorded ` +
        'for quality assurance and training purposes. By remaining on the line, ' +
        'you acknowledge and consent to the recording of this call.',
      requiresTwoPartyConsent: true,
    };
  }

  return {
    spoken: 'This call may be recorded for quality and training purposes.',
    written:
      `${businessName} wishes to inform you that this call may be recorded ` +
      'for quality assurance and training purposes.',
    requiresTwoPartyConsent: false,
  };
}

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface DisclosureInput {
  tenantId: string;
  /** ISO 3166-2 US state code (e.g. 'CA', 'TX'). Null/undefined → two-party copy. */
  callerState?: string | null;
  channel: 'telephony' | 'inapp';
  /**
   * When provided, the spoken disclosure is synthesized to audio and returned
   * in `audioBuffer`. TTS failure is non-fatal — the skill returns the text
   * so the TwiML <Say> path can speak it directly.
   */
  ttsProvider?: TtsProvider;
  /** Business name used in the written disclosure for audit clarity. */
  businessName: string;
}

export interface DisclosureResult {
  /** Always true once the disclosure text has been generated (or bypassed for in-app). */
  disclosed: boolean;
  /** Spoken disclosure text (empty string for in-app channel). */
  disclosureText: string;
  /** Whether two-party consent rules apply. Always false for in-app. */
  requiresTwoPartyConsent: boolean;
  /** Audio buffer if ttsProvider was supplied and synthesis succeeded; undefined otherwise. */
  audioBuffer?: Buffer;
}

/**
 * Generates the appropriate recording disclosure for the call channel and
 * caller's US state. Optionally synthesizes the spoken text to audio.
 *
 * Never throws — TTS failures are swallowed so the disclosure is always
 * returned with at minimum the text copy.
 */
export async function discloseRecording(
  input: DisclosureInput
): Promise<DisclosureResult> {
  const { channel, callerState, ttsProvider, businessName } = input;

  // ── In-app: user consented via ToS — no spoken disclosure needed ──────────
  if (channel === 'inapp') {
    return {
      disclosed: true,
      disclosureText: '',
      requiresTwoPartyConsent: false,
    };
  }

  // ── Telephony: generate state-appropriate disclosure text ─────────────────
  const disclosure = buildDisclosureText(callerState, businessName);

  let audioBuffer: Buffer | undefined;

  if (ttsProvider) {
    try {
      const result = await ttsProvider.synthesize({
        text: disclosure.spoken,
        tenantId: input.tenantId,
      });
      audioBuffer = result.audio;
    } catch {
      // Non-fatal: TwiML <Say> path will speak the text directly.
    }
  }

  return {
    disclosed: true,
    disclosureText: disclosure.spoken,
    requiresTwoPartyConsent: disclosure.requiresTwoPartyConsent,
    ...(audioBuffer !== undefined ? { audioBuffer } : {}),
  };
}
