/**
 * Canonical money formatting.
 *
 * All money in the system is integer cents. Two formatters are exposed:
 *
 *  - `formatCurrency(cents)` — full display string with the currency
 *    symbol: `formatCurrency(123450) // "$1,234.50"`. Use this anywhere
 *    a user-facing dollar amount renders on its own.
 *
 *  - `formatCurrencyAmount(cents)` — formatted number without the
 *    symbol: `formatCurrencyAmount(123450) // "1,234.50"`. Use this
 *    when the JSX already prints the symbol next to the value (e.g.
 *    `${formatCurrencyAmount(x)}` inside a styled span where the `$`
 *    is part of the surrounding template).
 *
 * Both formatters use `Intl.NumberFormat`, which gives thousands
 * separators (`$1,234.50` instead of `$1234.50`), keeps trailing
 * zero cents (`$50.00`, never `$50`), and renders negatives correctly
 * (`-$5.00`, not `$-5.00`).
 *
 * Pre-fix, `centsToDisplay` used `.toFixed(2)` which dropped the
 * grouping separator entirely (`$1000.00`), and an ad-hoc `formatMoney`
 * helper in InvoicePaymentPage used `.toLocaleString` correctly but
 * only on that one page. This module unifies both.
 */

const CURRENCY_FORMATTER = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
});

const AMOUNT_FORMATTER = new Intl.NumberFormat('en-US', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/** Format integer cents as a user-facing currency string: 123450 → "$1,234.50". */
export function formatCurrency(cents: number): string {
  return CURRENCY_FORMATTER.format(cents / 100);
}

/** Format integer cents as a bare number with thousands separator: 123450 → "1,234.50". */
export function formatCurrencyAmount(cents: number): string {
  return AMOUNT_FORMATTER.format(cents / 100);
}
