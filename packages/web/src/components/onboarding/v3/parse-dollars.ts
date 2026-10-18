/**
 * Dollars the owner typed, as integer cents. Money is never a float: the
 * digits are split as text and combined as integers, so $19.99 is 1999 and not
 * 1998.9999999999998.
 *
 * Accepts "120", "$120", "$ 120", "89.50", "89.5", "1,234" and "$1,234.56".
 * Everything else is null: negatives, more than two decimals (rounding would
 * quietly change a price), a half-typed "120." or ".50", commas that are not
 * thousands separators, and more than seven digits of dollars (so the result
 * is always a safe integer).
 */
const AMOUNT = /^(?<whole>\d{1,7}|\d{1,3}(?:,\d{3})+)(?:\.(?<cents>\d{1,2}))?$/;

export function parseDollarsToCents(input: string): number | null {
  const text = input.trim().replace(/^\$\s*/, '');
  const match = AMOUNT.exec(text);
  const whole = match?.groups?.whole;
  if (!whole) return null;
  const dollars = Number(whole.replaceAll(',', ''));
  if (dollars > 9_999_999) return null;
  const cents = Number((match.groups?.cents ?? '').padEnd(2, '0'));
  return dollars * 100 + cents;
}
