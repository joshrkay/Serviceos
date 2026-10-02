/**
 * #1563 — best-effort US state code from a free-text business address
 * ("100 Congress Ave, Austin, TX 78701" → "TX"), used by "Pick one for me" to
 * search the business's home area code first (purchasePhoneNumber maps the
 * state through STATE_AREA_CODE and falls back to any US local number when
 * the code is unknown or null).
 *
 * Takes the LAST two-letter token that sits in the state position: after a
 * comma, optionally followed by a ZIP / ZIP+4, at the end of the address.
 */
export function usStateFromAddress(address: string | null | undefined): string | null {
  if (!address) return null;
  const m = address.trim().match(/,\s*([A-Za-z]{2})\.?(?:\s+\d{5}(?:-\d{4})?)?\s*(?:,\s*(?:USA?|United States))?\s*$/i);
  return m ? m[1].toUpperCase() : null;
}
