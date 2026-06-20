// Pure validation/normalization for the owner's click-to-call callback number.
// Kept RN-free so it unit-tests without a device; the secure-store binding lives
// in callbackStorage.ts.

export const CALLBACK_NUMBER_KEY = 'serviceos.callbackNumber';

/**
 * Normalize a typed phone to a callable form, or null when it can't be one.
 * Accepts US-style 10-digit input (prefixes +1) and already-E.164 input; keeps a
 * leading `+`, strips other punctuation, and requires 10–15 digits.
 */
export function normalizeCallbackNumber(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  const hasPlus = trimmed.startsWith('+');
  const digits = trimmed.replace(/\D/g, '');
  if (hasPlus) {
    return digits.length >= 10 && digits.length <= 15 ? `+${digits}` : null;
  }
  if (digits.length === 10) return `+1${digits}`; // bare US number
  if (digits.length >= 11 && digits.length <= 15) return `+${digits}`;
  return null;
}

export function isValidCallbackNumber(raw: string | null | undefined): boolean {
  return normalizeCallbackNumber(raw) !== null;
}
