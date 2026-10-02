/**
 * #1567 (owner decisions 2026-10-02) — the tenant service area on inbound
 * phone booking. Shared by both phone transports (via the voice-turn
 * processor's `serviceAreaGate` / `handlePendingServiceAreaCheck`) and the
 * voice-quality text driver, so the copy and the rules cannot drift.
 *
 *  1. A NEW caller booking outside the area is told so, kept as a lead, and
 *     no appointment is drafted.
 *  2. A new caller on a booking is asked for the service-address ZIP; the ZIP
 *     is checked with `checkServiceArea` (scheduling/service-area.ts) against
 *     `tenant_settings.service_area_zips`.
 *  3. No ZIPs configured → no check, no question (`not_configured`).
 *
 * Known customers are unchanged. The radius setting has no centre point to
 * measure from, so it cannot be checked from a ZIP; only the ZIP list gates.
 */

/** Asked of a new caller on a booking when the tenant has a service area. */
export const SERVICE_AREA_ZIP_QUESTION =
  "Sure — what's the ZIP code for the address where you need the service?";

/** Owner-decided copy for an out-of-area new caller (#1567 decision 1). */
export const OUT_OF_SERVICE_AREA_COPY =
  "We don't usually service that area, but I'll pass your details to the team.";

/** The caller-surface intents that book a visit. */
export const SERVICE_AREA_BOOKING_INTENTS: ReadonlySet<string> = new Set([
  'create_appointment',
  'create_job',
]);

const DIGIT_WORDS: Record<string, string> = {
  zero: '0', oh: '0', o: '0', one: '1', two: '2', three: '3', four: '4',
  five: '5', six: '6', seven: '7', eight: '8', nine: '9',
  cero: '0', uno: '1', dos: '2', tres: '3', cuatro: '4', cinco: '5',
  seis: '6', siete: '7', ocho: '8', nueve: '9',
};

/**
 * The 5-digit ZIP a caller said, or null. Accepts digits as transcribed
 * ("30309", "30309-1234") and digit-by-digit speech ("three oh three oh
 * nine", "nueve cero cero uno dos"). Longer digit runs (phone numbers,
 * street numbers over five digits) are not ZIPs.
 */
export function spokenZip(utterance: string): string | null {
  const direct = utterance.match(/(?<!\d)(\d{5})(?:-\d{4})?(?!\d)/);
  if (direct) return direct[1]!;
  const tokens = utterance.toLowerCase().split(/[^a-z0-9áéíóúñ]+/).filter(Boolean);
  let run = '';
  for (const t of tokens) {
    const d = /^\d$/.test(t) ? t : DIGIT_WORDS[t];
    if (d !== undefined) {
      run += d;
      if (run.length === 5) return run;
    } else {
      run = '';
    }
  }
  return null;
}
