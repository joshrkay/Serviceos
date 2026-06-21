// Pure validation/normalization for the owner's click-to-call callback number.
// Kept RN-free so it unit-tests without a device; the secure-store binding lives
// in callbackStorage.ts.

export const CALLBACK_NUMBER_KEY = 'serviceos.callbackNumber';

/**
 * Normalize a typed phone to a callable form, or null when it can't be one.
 * Accepts US-style 10-digit input (prefixes +1) and already-E.164 input; keeps a
 * leading `+`, strips other punctuation. Without a `+`, only US-style input is
 * accepted (10 digits, or 11 starting with country code 1) — international
 * numbers must be entered in `+` E.164 form so we never guess a country code.
 */
export function normalizeCallbackNumber(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  const hasPlus = trimmed.startsWith('+');
  const digits = trimmed.replace(/\D/g, '');
  if (hasPlus) {
    // Trust an explicit + as E.164: 10–15 digits (some country codes yield a
    // 10-digit total, e.g. +47), never starting with 0 (country codes don't).
    return digits.length >= 10 && digits.length <= 15 && !digits.startsWith('0')
      ? `+${digits}`
      : null;
  }
  if (digits.length === 10) return `+1${digits}`; // bare US number
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`; // US with country code
  return null;
}

export function isValidCallbackNumber(raw: string | null | undefined): boolean {
  return normalizeCallbackNumber(raw) !== null;
}
