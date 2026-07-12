// Pure builders for device deep links (sms:, tel:, mailto:, and platform maps).
// Kept RN-free so they unit-test without a device; screens wire the result into
// Linking.openURL and disable the control when a builder returns null (no phone,
// email, or address to act on).

export type DevicePlatform = 'ios' | 'android' | 'web';

/**
 * Reduce a display phone to a dialable sequence: keep a single leading `+`, drop
 * all other punctuation/whitespace. Null when nothing dialable remains — callers
 * treat that as "no number on file" and disable the control.
 */
function sanitizePhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const hasPlus = raw.trim().startsWith('+');
  const digits = raw.replace(/\D/g, '');
  if (!digits) return null;
  return hasPlus ? `+${digits}` : digits;
}

/** `sms:<number>` for a customer text, or null when there's no dialable phone. */
export function buildSmsUrl(phone: string | null | undefined): string | null {
  const p = sanitizePhone(phone);
  return p ? `sms:${p}` : null;
}

/** `tel:<number>` for a direct dial, or null when there's no dialable phone. */
export function buildTelUrl(phone: string | null | undefined): string | null {
  const p = sanitizePhone(phone);
  return p ? `tel:${p}` : null;
}

/** `mailto:<address>` for an email, or null when no address is present. */
export function buildMailtoUrl(email: string | null | undefined): string | null {
  const e = email?.trim();
  return e ? `mailto:${encodeURIComponent(e)}` : null;
}

/**
 * Platform maps URL for a free-text address. iOS opens Apple Maps, Android the
 * `geo:` scheme (which lets the OS pick the installed maps app), and every other
 * platform a universal Google Maps https link. Null when there's no address to
 * route to, so the caller disables the Navigate control.
 */
export function buildMapsUrl(
  address: string | null | undefined,
  platform: DevicePlatform,
): string | null {
  const a = address?.trim();
  if (!a) return null;
  const q = encodeURIComponent(a);
  if (platform === 'ios') return `http://maps.apple.com/?q=${q}`;
  if (platform === 'android') return `geo:0,0?q=${q}`;
  return `https://maps.google.com/?q=${q}`;
}
