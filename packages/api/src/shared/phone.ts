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
