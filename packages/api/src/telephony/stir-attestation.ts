/**
 * #1223 — STIR/SHAKEN attestation for caller-ID trust.
 *
 * Caller-ID is spoofable. Twilio reports the carrier's SHAKEN verification on
 * inbound call webhooks as `StirVerstat`:
 *   - `TN-Validation-Passed-A` — the originating carrier vouches for the
 *     caller AND their right to use this number (full attestation)
 *   - `TN-Validation-Passed-B` / `-C` — partial / gateway attestation
 *   - `TN-Validation-Failed[-A|-B|-C]`, `No-TN-Validation` — failed / absent
 * The parameter is omitted entirely when the call carried no SHAKEN
 * PASSporT (e.g. many international or legacy-TDM routes).
 *
 * Owner-line authority (ownerSession, the phone actor, voicemail → action
 * router) is granted ONLY on full A-attestation. Everything else — including
 * a missing value — is an untrusted caller. Fail-closed by construction:
 * exact match, no normalisation, so an unexpected casing or a new value
 * Twilio introduces later is treated as unverified.
 */

export const STIR_VERSTAT_FULL_ATTESTATION = 'TN-Validation-Passed-A';

/** True only for Twilio's full (A) attestation value. */
export function isOwnerLineAttested(stirVerstat: string | undefined | null): boolean {
  return stirVerstat === STIR_VERSTAT_FULL_ATTESTATION;
}
