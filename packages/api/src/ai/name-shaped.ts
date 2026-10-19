/**
 * PI-1 — whether a short piece of internet-authored text reads as a name.
 *
 * Customer names are written by anyone on the internet through the public
 * booking form (routes/public-booking.ts) before anyone approves the booking,
 * so a name that reaches a model prompt is attacker-reachable text. A term is
 * name-shaped when it is at most `MAX_NAME_SHAPED_CHARS` characters and
 * `MAX_NAME_SHAPED_WORDS` words, drawn from letters, digits, apostrophes
 * (O'Brien), periods (St. Jude), ampersands (A&B), slashes (3/4in), hyphens
 * and spaces. Everything an instruction needs to read as one — colons,
 * quotes, newlines, brackets, commas, semicolons — is out.
 *
 * Name-shaped is a filter, not a trust grant: "Ignore prior rules" passes, so
 * a name that enters a prompt still rides inside the untrusted-content fence
 * (`buildUntrustedContentSection`).
 */

/** Longest term that still reads as a name or a catalog noun. */
const MAX_NAME_SHAPED_CHARS = 40;
/** Most whitespace-separated words a name-shaped term may carry. */
const MAX_NAME_SHAPED_WORDS = 4;
const NAME_SHAPED_TERM = /^[\p{L}\p{N}][\p{L}\p{N}'’.&/\- ]*$/u;

/** Whether an already-trimmed `term` is name-shaped. */
export function isNameShaped(term: string): boolean {
  if (term.length === 0 || term.length > MAX_NAME_SHAPED_CHARS) return false;
  if (!NAME_SHAPED_TERM.test(term)) return false;
  return term.split(/\s+/).length <= MAX_NAME_SHAPED_WORDS;
}
