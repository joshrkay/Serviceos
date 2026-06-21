/**
 * What's-new changelog entries, newest first. Client-side and intentionally
 * simple — a small SaaS doesn't need a news API; shipping a release note is a
 * one-line edit here. The newest entry's `id` is the cursor: when it differs
 * from the user's stored "last seen" id, WhatsNewModal surfaces the unseen
 * entries.
 *
 * Bump by PREPENDING a new entry with a fresh, stable `id` (date-prefixed).
 */
/** localStorage cursor: the id of the newest release the user has seen. */
export const WHATS_NEW_SEEN_KEY = 'walkthrough.whatsnew.lastSeen';

export interface Release {
  /** Stable, unique, sortable id — e.g. "2026-06-21-onboarding". */
  id: string;
  /** Display date. */
  date: string;
  title: string;
  items: string[];
}

export const RELEASES: Release[] = [
  {
    id: '2026-06-21-onboarding',
    date: 'June 2026',
    title: 'A smoother welcome',
    items: [
      'New owners now get a welcome email and a quick in-app tour to get live faster.',
      'We’ll email you a friendly nudge if setup stalls, and before your trial ends.',
      'This “What’s new” panel — so you never miss an improvement.',
    ],
  },
  {
    id: '2026-06-20-marketing',
    date: 'June 2026',
    title: 'Rivet on the web and in your pocket',
    items: [
      'A refreshed marketing site with dedicated Features and Pricing pages.',
      'The Rivet app is coming to iOS and Android — approvals and voice capture on the go.',
    ],
  },
];

/** The id a fresh account is initialized to (suppresses the changelog on day one). */
export function latestReleaseId(): string | null {
  return RELEASES[0]?.id ?? null;
}
