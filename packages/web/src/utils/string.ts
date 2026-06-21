/**
 * Snake/underscore-cased token → Title Case, e.g. "social_media" → "Social
 * Media", "bank_transfer" → "Bank Transfer". Single home for the
 * `replace(/_/g,' ').replace(/\b\w/g, upper)` transform that was copy-pasted
 * across customer/invoice/portal displays.
 */
export function toTitleCase(value: string): string {
  return value.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}
