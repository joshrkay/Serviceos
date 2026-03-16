/**
 * Shared text normalization for line-item matching, bundle detection, and wording preferences.
 */
export function normalizeDescription(desc: string): string {
  return desc.toLowerCase().trim().replace(/\s+/g, ' ');
}
