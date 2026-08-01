/**
 * Strip all non-digit characters and drop the leading "1" on 11-digit
 * North-American numbers so that '+1 (512) 555-0100', '15125550100',
 * and '5125550100' all collapse to the same canonical form. This must
 * stay in sync with the SQL `phone_normalized` generated columns on
 * the `customers` and `leads` tables.
 */
export function normalizePhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) {
    return digits.slice(1);
  }
  return digits;
}

/**
 * True when `normalized` (the output of {@link normalizePhone}) is a valid
 * North-American Numbering Plan key: exactly 10 digits where both the area
 * code and the central-office (exchange) prefix begin with 2–9 (NANP forbids
 * 0/1 in those positions). `normalizePhone` has already dropped any leading
 * country-code 1, so a genuine NANP number is 10 digits here.
 *
 * Non-NANP / international inputs (wrong length, or an out-of-range leading
 * digit) return false. Callers must NOT tail-match such numbers against US
 * customers by their last-10 digits — e.g. `+445551112222` reduces to
 * `445551112222` (12 digits → false), so it can never be reconciled to a US
 * customer stored as `5551112222`.
 */
export function isNanpKey(normalized: string): boolean {
  return /^[2-9]\d{2}[2-9]\d{6}$/.test(normalized);
}
