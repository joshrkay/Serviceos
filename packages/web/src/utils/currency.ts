/**
 * Web money-formatting helpers.
 *
 * The full-symbol formatter is the cross-package canonical
 * `formatUsdCentsFixed` from `@ai-service-os/shared`; `formatCurrency` is kept
 * as the web-facing name and delegates to it so there is a single source of
 * truth for "$1,234.50"-style rendering. `formatCurrencyAmount` (bare number,
 * no symbol) stays here because it is web-only — used where the surrounding
 * JSX already prints the `$`.
 *
 * Both keep thousands separators (`$1,234.50` not `$1234.50`), trailing zero
 * cents (`$50.00`, never `$50`), and correct negatives (`-$5.00`).
 */
import { formatUsdCentsFixed } from '@ai-service-os/shared';

const AMOUNT_FORMATTER = new Intl.NumberFormat('en-US', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/** Format integer cents as a user-facing currency string: 123450 → "$1,234.50". */
export function formatCurrency(cents: number): string {
  return formatUsdCentsFixed(cents);
}

/** Format integer cents as a bare number with thousands separator: 123450 → "1,234.50". */
export function formatCurrencyAmount(cents: number): string {
  return AMOUNT_FORMATTER.format(cents / 100);
}
