/**
 * P5-020 — End-of-day digest SMS renderer.
 *
 * Pure function — takes DigestSection[] and renders to one or more SMS bodies.
 * Splits at section boundaries when total length exceeds 320 chars.
 *
 * Rules:
 *  - Section 5 ("What I wasn't sure about") omitted if no uncertain proposals
 *    (handled upstream in digest-builder — sections array won't include it)
 *  - Section 6 ("What I learned today") omitted if no correction chunks
 *    (handled upstream in digest-builder — sections array won't include it)
 *  - Sign-off uses business name or defaults to "Your ServiceOS"
 *  - Closing line: "Reply LOOKS GOOD or tell me what to fix."
 *  - If rendered text > 320 chars, split at section boundary into array
 */
import type { DigestSection } from './digest-types';

export const DIGEST_SMS_SPLIT_CHARS = 320;

/**
 * Renders digest sections into one or more SMS message bodies.
 *
 * @param sections  Array of DigestSection (already filtered — empty sections omitted by builder)
 * @param signOff   Business name or "Your ServiceOS"
 * @returns         Array of SMS bodies; usually 1, sometimes 2 when long
 */
export function renderDigest(sections: DigestSection[], signOff: string): string[] {
  const header = `${signOff} — end of day update:`;
  const closing = 'Reply LOOKS GOOD or tell me what to fix.';

  // Render each section as "Label: line1 line2..."
  const renderedSections = sections.map((s) => `${s.label}: ${s.lines.join(' ')}`);

  // Try fitting everything in one message
  const full = [header, ...renderedSections, closing].join('\n');
  if (full.length <= DIGEST_SMS_SPLIT_CHARS) {
    return [full];
  }

  // Split at section boundary — put as many sections as fit in message 1,
  // remainder + closing in message 2 (or more).
  const messages: string[] = [];
  let current: string[] = [header];

  for (const section of renderedSections) {
    const candidate = [...current, section].join('\n');
    if (candidate.length > DIGEST_SMS_SPLIT_CHARS && current.length > 1) {
      // Flush current batch as a message
      messages.push(current.join('\n'));
      current = [section];
    } else {
      current.push(section);
    }
  }

  // Final batch gets the closing line
  current.push(closing);
  messages.push(current.join('\n'));

  return messages;
}
