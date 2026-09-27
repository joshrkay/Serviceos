import { ValidationError } from '../errors';

/**
 * P1-022 — E.164 normalization for inbound identity binding.
 *
 * The `users.mobile_number` column stores numbers in canonical E.164
 * form (`+15551234567`). Two upcoming inbound flows match a sender to a
 * user by mobile number:
 *   - P6-028: a technician replies `OUT` from their phone.
 *   - P8-016: an emergency call is patched through to the owner's cell.
 *
 * Both the storage path and the lookup path MUST funnel raw input through
 * `normalizeMobileE164()` so the stored value and the lookup key agree.
 *
 * Scope: US/North-American (NANP) numbers only. We accept the common ways
 * a human or upstream system might present a US number and reject anything
 * that is obviously not one (letters, wrong length) with a typed error so
 * callers can surface a clear message.
 *
 * NOTE: This is intentionally separate from `src/shared/phone.ts`'s
 * `normalizePhone()`, which produces a 10-digit *bare* key kept in lock-
 * step with the SQL `phone_normalized` generated columns on customers/
 * leads. That function deliberately strips the `+1`. This helper produces
 * full E.164 (`+1...`) for the new `users.mobile_number` column.
 */

export class InvalidPhoneNumberError extends ValidationError {
  constructor(message: string, public readonly input: string) {
    super(message, { input });
    this.name = 'InvalidPhoneNumberError';
  }
}

/**
 * Normalize common US phone-number input formats to E.164 (`+15551234567`).
 *
 * Accepts, e.g.:
 *   (555) 123-4567
 *   555-123-4567
 *   555.123.4567
 *   5551234567
 *   +1-555-123-4567
 *   1 (555) 123-4567
 *
 * Rejects (throws InvalidPhoneNumberError):
 *   - input containing letters or otherwise unexpected characters
 *   - numbers that are too short / too long to be a US number
 *   - a US area code or exchange code that starts with 0 or 1 (invalid NANP)
 */
export function normalizeMobileE164(input: string): string {
  if (typeof input !== 'string' || input.trim() === '') {
    throw new InvalidPhoneNumberError('Phone number is required', String(input));
  }

  const raw = input.trim();

  // Only allow characters that legitimately appear in a typed phone number.
  // Anything else (notably letters) is rejected up front so "abc" can never
  // be coerced into a number.
  if (!/^[+()\-.\s\d]+$/.test(raw)) {
    throw new InvalidPhoneNumberError(
      `Invalid phone number: "${input}" contains unexpected characters`,
      input,
    );
  }

  const hadPlus = raw.startsWith('+');
  const digits = raw.replace(/\D/g, '');

  // Resolve to the 10 significant NANP digits (area code + 7-digit number).
  let national: string;
  if (digits.length === 10) {
    national = digits;
  } else if (digits.length === 11 && digits.startsWith('1')) {
    national = digits.slice(1);
  } else {
    throw new InvalidPhoneNumberError(
      `Invalid phone number: "${input}" is not a valid US (10-digit) number`,
      input,
    );
  }

  // A leading "+" that wasn't a "+1" country code is bogus (e.g. "+44..."
  // arriving with only 10 digits, or "+1234"). The length checks above
  // already reject most of these; guard the remaining ambiguous case where
  // a "+" prefixed something that wasn't the US country code.
  if (hadPlus && digits.length === 11 && !digits.startsWith('1')) {
    throw new InvalidPhoneNumberError(
      `Invalid phone number: "${input}" is not a US (+1) number`,
      input,
    );
  }

  // NANP validity: the area code may not begin with 0 or 1. (We do NOT
  // constrain the exchange's leading digit — real test/fixture numbers like
  // 555-123-4567 use exchange "123", and stricter validation here would
  // reject legitimate, story-required inputs.)
  const areaCode = national.slice(0, 3);
  if (/^[01]/.test(areaCode)) {
    throw new InvalidPhoneNumberError(
      `Invalid phone number: "${input}" has an invalid US area code`,
      input,
    );
  }

  return `+1${national}`;
}

/**
 * #1397 — normalise a tenant's business phone to E.164, or `null` when it
 * can't be. Unlike `normalizeMobileE164` (NANP-only), a business may list an
 * international line, so a number typed with a leading '+' and a non-US
 * country code is accepted as '+' + its 8–15 digits (the E.164 length
 * bounds). Extensions, letters and wrong-length numbers return `null` —
 * business_phone is dialed by the escalation fallback, so a value that
 * can't be dialed must never be stored.
 */
export function normalizeBusinessPhoneE164(input: string): string | null {
  try {
    return normalizeMobileE164(input);
  } catch {
    // fall through to the international form
  }
  const raw = typeof input === 'string' ? input.trim() : '';
  if (!raw.startsWith('+') || !/^\+[()\-.\s\d]+$/.test(raw)) return null;
  const digits = raw.replace(/\D/g, '');
  if (digits.startsWith('1') || digits.startsWith('0')) return null;
  if (digits.length < 8 || digits.length > 15) return null;
  return `+${digits}`;
}
