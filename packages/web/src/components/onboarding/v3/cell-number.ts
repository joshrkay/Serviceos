/**
 * Whether a typed cell is one the API will accept.
 *
 * This mirrors `normalizeMobileE164` in packages/api/src/shared/phone/normalize.ts,
 * which the draft routes run the cell through (US/NANP numbers only). The two must
 * agree exactly: a number this lets through that the API refuses is a 400 on
 * "Show me my shop", and one it blocks that the API takes keeps an owner out of
 * setup. If the API's rules change, change them here and in cell-number.test.ts.
 *
 * The rules, in the API's order:
 *  - only digits, spaces and + ( ) - . may appear (no letters, no extension);
 *  - a leading "+" must be "+1" followed by the 10 national digits;
 *  - otherwise exactly 10 digits, or 11 with a leading 1;
 *  - the area code may not start with 0 or 1.
 */
export function isUsCellNumber(input: string): boolean {
  const raw = input.trim();
  if (raw === '' || !/^[+()\-.\s\d]+$/.test(raw)) return false;

  const digits = raw.replace(/\D/g, '');
  if (raw.startsWith('+') && !(digits.length === 11 && digits.startsWith('1'))) return false;

  let national: string;
  if (digits.length === 10) national = digits;
  else if (digits.length === 11 && digits.startsWith('1')) national = digits.slice(1);
  else return false;

  return !/^[01]/.test(national);
}
