/**
 * Estimate list responses serialize document money under `totals`, while a
 * few older callers still provide a flat `totalCents`. Keep the compatibility
 * read at the UI boundary and reject malformed values instead of rendering
 * `$NaN` or silently inventing an amount.
 */
export function getEstimateTotalCents(estimate: {
  totals?: { totalCents?: unknown } | null;
  totalCents?: unknown;
}): number | null {
  const value = estimate.totals?.totalCents ?? estimate.totalCents;
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : null;
}
