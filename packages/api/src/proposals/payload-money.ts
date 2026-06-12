/**
 * Shared payload money helpers used by both:
 *   - proposal-approval-task.ts  (`payloadHeadlineCents` — readback display)
 *   - pending-proposal-resolver.ts (`payloadAmountsCents` — amount matching)
 *
 * Having two independent implementations of the same key extraction allowed
 * them to drift: `payloadHeadlineCents` included `totalAmountCents` while
 * `payloadAmountsCents` did not — causing "$450 invoice" to fail matching a
 * proposal whose readback said "$450.00".
 *
 * Extraction order is intentional:
 *   1. Explicit total-cents fields (most trustworthy, already integer cents)
 *   2. Amount-cents fields
 *   3. Computed line-item totals (last resort)
 */

/**
 * All money-key names considered by both the readback formatter and the
 * amount-match scorer. Ordered from most-specific to least-specific so
 * `payloadHeadlineCents` picks the best single value.
 *
 * Includes `totalAmountCents` (invoice executor output) that was previously
 * missing from `payloadAmountsCents`.
 */
export const PAYLOAD_MONEY_KEYS = [
  'totalCents',
  'totalAmountCents',
  'amountCents',
  'amountDueCents',
  'total',
  'amount',
] as const;

export type PayloadMoneyKey = (typeof PAYLOAD_MONEY_KEYS)[number];

/**
 * Compute the sum of line-item `total` fields, if present.
 * Returns `{ sum, saw }` — `saw` is false when no item had a numeric `total`.
 */
function lineItemsTotalCents(
  payload: Record<string, unknown>,
): { sum: number; saw: boolean } {
  const lineItems = payload.lineItems;
  if (!Array.isArray(lineItems)) return { sum: 0, saw: false };
  let sum = 0;
  let saw = false;
  for (const item of lineItems) {
    if (item && typeof item === 'object') {
      const t = (item as Record<string, unknown>).total;
      if (typeof t === 'number' && Number.isFinite(t)) {
        sum += Math.round(t);
        saw = true;
      }
    }
  }
  return { sum, saw };
}

/**
 * Headline money value for voice readback — the single best cents figure
 * carried by the payload.  Returns `null` when no money field is present.
 *
 * Priority: explicit scalar money keys (PAYLOAD_MONEY_KEYS order) → sum of
 * line-item `total` fields.
 */
export function payloadHeadlineCents(payload: Record<string, unknown>): number | null {
  for (const key of PAYLOAD_MONEY_KEYS) {
    const v = payload[key];
    if (typeof v === 'number' && Number.isFinite(v)) return Math.round(v);
  }
  const { sum, saw } = lineItemsTotalCents(payload);
  return saw ? sum : null;
}

/**
 * All plausible integer-cent money values carried by a proposal payload,
 * for use in amount-mention scoring.  Returns multiple values when several
 * fields are present (the scorer checks `.includes(parsedCents)`).
 */
export function payloadAmountsCents(payload: Record<string, unknown>): number[] {
  const out: number[] = [];
  for (const key of PAYLOAD_MONEY_KEYS) {
    const v = payload[key];
    if (typeof v === 'number' && Number.isFinite(v)) out.push(Math.round(v));
  }
  const { sum, saw } = lineItemsTotalCents(payload);
  if (saw) out.push(sum);
  return out;
}
