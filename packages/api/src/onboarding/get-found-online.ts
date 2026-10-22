/**
 * D-044 / #1763 — the "Get found online" checklist: web-presence setup an
 * owner finishes after activation. Derived from tenant facts, like the
 * onboarding steps (derive-status.ts), but deliberately NOT one of them:
 * activation and the setup-reminder email gate on the onboarding steps, and
 * a Google verification postcard can take weeks.
 *
 * Every item is derived, so a tenant who disconnects Google sees the item
 * reopen instead of a stale tick. Later tickets (website #1768, forwarding
 * #1765/#1766, Google website #1771) add their items here.
 */
import type { GoogleBusinessLocationState } from '../reputation/google-business-integration';

export type GetFoundOnlineItemId = 'google_listing' | 'review_link';

/**
 * done — finished. current — the owner's next step. pending — open, after
 * the current one. waiting — nothing the owner can do yet (Google is
 * verifying). error — was working and broke; the owner must act.
 */
export type GetFoundOnlineItemStatus = 'done' | 'current' | 'pending' | 'waiting' | 'error';

/** Why an item is not done; the web picks its copy from this. */
export type GetFoundOnlineItemReason =
  | 'not_connected'
  | 'needs_pick'
  | 'no_location'
  | 'polling_paused'
  | 'missing';

export interface GetFoundOnlineItem {
  id: GetFoundOnlineItemId;
  status: GetFoundOnlineItemStatus;
  reason?: GetFoundOnlineItemReason;
}

export interface GetFoundOnlineFacts {
  /** The Google Business connection, or null when none exists. */
  google: {
    locationState: GoogleBusinessLocationState;
    /** Review polling is backed off (usually revoked credentials) — the
     *  same signal the Google Business sheet shows as "paused". */
    pollingPaused: boolean;
  } | null;
  /** tenant_settings.google_review_url. */
  googleReviewUrl: string | null | undefined;
  /** When the owner dismissed the finished checklist; null if never. */
  dismissedAt: Date | null;
}

export interface GetFoundOnlineChecklist {
  items: GetFoundOnlineItem[];
  allDone: boolean;
  /** False only when every item is done AND the owner dismissed the card. */
  visible: boolean;
}

type Open = { status: 'open' | 'waiting' | 'error'; reason: GetFoundOnlineItemReason };
type Evaluated = { id: GetFoundOnlineItemId; result: 'done' | Open };

function googleListing(facts: GetFoundOnlineFacts): Evaluated['result'] {
  const google = facts.google;
  if (!google) return { status: 'open', reason: 'not_connected' };
  if (google.pollingPaused) return { status: 'error', reason: 'polling_paused' };
  switch (google.locationState) {
    case 'connected':
      return 'done';
    case 'no_location':
      return { status: 'waiting', reason: 'no_location' };
    case 'needs_pick':
      return { status: 'open', reason: 'needs_pick' };
  }
}

function reviewLink(facts: GetFoundOnlineFacts): Evaluated['result'] {
  return facts.googleReviewUrl?.trim() ? 'done' : { status: 'open', reason: 'missing' };
}

export function deriveGetFoundOnlineChecklist(
  facts: GetFoundOnlineFacts,
): GetFoundOnlineChecklist {
  const evaluated: Evaluated[] = [
    { id: 'google_listing', result: googleListing(facts) },
    { id: 'review_link', result: reviewLink(facts) },
  ];

  // The first open item is the owner's next step; waiting and error items
  // keep their own status so the card can say why.
  let currentAssigned = false;
  const items: GetFoundOnlineItem[] = evaluated.map(({ id, result }) => {
    if (result === 'done') return { id, status: 'done' };
    if (result.status === 'open') {
      const status = currentAssigned ? 'pending' : 'current';
      currentAssigned = true;
      return { id, status, reason: result.reason };
    }
    return { id, status: result.status, reason: result.reason };
  });

  const allDone = items.every((i) => i.status === 'done');
  return { items, allDone, visible: !allDone || facts.dismissedAt === null };
}
