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
import { t, type Language } from '../i18n/i18n';
import type { ConsentEventRepository } from '../../compliance/consent-events';

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
  businessName: string,
  language: Language = 'en'
): DisclosureTextPair {
  const state = callerState?.toUpperCase().trim();
  const requiresTwoPartyConsent = !state || TWO_PARTY_CONSENT_STATES.has(state);

  if (requiresTwoPartyConsent) {
    return {
      spoken: t('disclose.two_party', language),
      written:
        language === 'es'
          ? `${businessName} le informa que esta llamada puede ser grabada con fines de calidad ` +
            'y entrenamiento. Al permanecer en la línea, usted reconoce y consiente la grabación de esta llamada.'
          : `${businessName} wishes to inform you that this call may be recorded ` +
            'for quality assurance and training purposes. By remaining on the line, ' +
            'you acknowledge and consent to the recording of this call.',
      requiresTwoPartyConsent: true,
    };
  }

  return {
    spoken: t('disclose.one_party', language),
    written:
      language === 'es'
        ? `${businessName} le informa que esta llamada puede ser grabada con fines de calidad y entrenamiento.`
        : `${businessName} wishes to inform you that this call may be recorded ` +
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
  /** P11-002: spoken-disclosure language. Defaults to 'en'. */
  language?: Language;
  /**
   * RV-130 — append-only consent ledger. When wired (with a caller phone),
   * `commitConsentLedger()` appends `{ kind: 'recording', state: 'implicit',
   * source: 'voice' }` tied to the session — "disclosure played; the caller
   * staying on the line is implicit consent". Best-effort: a ledger failure
   * never blocks the disclosure (the call must proceed).
   *
   * The write is DEFERRED to the returned thunk rather than performed here —
   * generating the copy is not evidence the caller heard it. See
   * {@link DisclosureResult.commitConsentLedger}.
   */
  consentLedger?: ConsentEventRepository;
  /** Caller E.164 for the ledger row. Without it, no event is written. */
  callerPhone?: string;
  /** Matched customer for the ledger row (null/undefined for unknown callers). */
  customerId?: string | null;
  /** Originating voice session id, for the ledger row. */
  voiceSessionId?: string;
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
  /**
   * Appends the implicit recording-consent ledger event. The CALLER decides
   * when — this skill only generates copy, and generating copy is not evidence
   * the caller heard anything.
   *
   * The ledger's contract (consent-events.ts) defines `recording/implicit` as
   * "the disclosure PLAYED and the caller stayed on the line". Writing it at
   * disclosure-generation time asserted that before a single byte of audio had
   * gone out, so every fail-closed hang-up (truncated / non-PCM / zero-length /
   * filler-only playback) left a row claiming a caller consented to a call we
   * terminated precisely because they were never told.
   *
   * Each transport commits at its own point of evidence:
   *   - Gather/PSTN — once the TwiML carrying `<Say>` before `<Start><Record>`
   *     is handed to Twilio; the ordering is structural in that document.
   *   - Media Streams — once the disclosure TURN is validated as played to
   *     completion (`disclosureTurnComplete`), never on a fail-closed path.
   *
   * Idempotent (a second call is a no-op) and best-effort: resolves even when
   * the append throws, and is a no-op for in-app or when no ledger/phone was
   * supplied. Never rejects.
   */
  commitConsentLedger: () => Promise<void>;
}

/** Shared no-op commit for the paths that never ledger (in-app, no ledger wired). */
const NO_CONSENT_LEDGER = async (): Promise<void> => {};

/**
 * Generates the appropriate recording disclosure for the call channel and
 * caller's US state. Optionally synthesizes the spoken text to audio.
 *
 * Never throws — TTS failures are swallowed so the disclosure is always
 * returned with at minimum the text copy. Does NOT write to the consent
 * ledger; call `result.commitConsentLedger()` once the caller has actually
 * heard the notice.
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
      commitConsentLedger: NO_CONSENT_LEDGER,
    };
  }

  // ── Telephony: generate state-appropriate disclosure text ─────────────────
  const lang: Language = input.language ?? 'en';
  const disclosure = buildDisclosureText(callerState, businessName, lang);

  // RV-130 — the implicit recording-consent write, DEFERRED to the caller (see
  // DisclosureResult.commitConsentLedger). Awaited when invoked (one fast
  // insert) so tests stay deterministic; failures are swallowed — the call
  // must never be blocked by a ledger write.
  const ledger = input.consentLedger;
  const callerPhone = input.callerPhone;
  let committed = false;
  const commitConsentLedger =
    ledger && callerPhone
      ? async (): Promise<void> => {
          if (committed) return;
          committed = true;
          try {
            await ledger.append({
              tenantId: input.tenantId,
              customerId: input.customerId ?? null,
              phone: callerPhone,
              kind: 'recording',
              state: 'implicit',
              source: 'voice',
              voiceSessionId: input.voiceSessionId ?? null,
            });
          } catch {
            // Swallow — see above.
          }
        }
      : NO_CONSENT_LEDGER;

  let audioBuffer: Buffer | undefined;

  if (ttsProvider) {
    try {
      const result = await ttsProvider.synthesize({
        text: disclosure.spoken,
        tenantId: input.tenantId,
        language: lang,
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
    commitConsentLedger,
    ...(audioBuffer !== undefined ? { audioBuffer } : {}),
  };
}
