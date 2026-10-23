/**
 * D-044 / #1763 — the "Get found online" checklist: web-presence setup an
 * owner finishes after activation. Derived from tenant facts, like the
 * onboarding steps (derive-status.ts), but deliberately NOT one of them:
 * activation and the setup-reminder email gate on the onboarding steps, and
 * a Google verification postcard can take weeks.
 *
 * Every item is derived, so a tenant who disconnects Google sees the item
 * reopen instead of a stale tick.
 */
import type { CallForwardingCarrier, CallForwardingMode } from '@ai-service-os/shared';
import type { GoogleBusinessLocationState } from '../reputation/google-business-integration';

export type GetFoundOnlineItemId = 'google_listing' | 'review_link' | 'call_forwarding' | 'website' | 'google_website';

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
  | 'missing'
  // call_forwarding: no carrier picked yet / picked but no passing check yet.
  | 'not_set_up'
  | 'not_checked'
  // google_website: the tenant has no website to show / the listing does not show it yet.
  | 'no_website'
  | 'not_published'
  // google_website: the owner approved the write and Google refused it.
  | 'failed';

export interface GetFoundOnlineItem {
  id: GetFoundOnlineItemId;
  status: GetFoundOnlineItemStatus;
  reason?: GetFoundOnlineItemReason;
  /** call_forwarding, when done: the date of the last passing check. */
  checkedAt?: string;
  /** google_website, when failed: why Google refused (owner-readable). */
  failureReason?: string;
}

export interface GetFoundOnlineFacts {
  /** The Google Business connection, or null when none exists. */
  google: {
    locationState: GoogleBusinessLocationState;
    /** Review polling is backed off (usually revoked credentials) — the
     *  same signal the Google Business sheet shows as "paused". */
    pollingPaused: boolean;
    /**
     * The website we last wrote to the connected listing (#1771), or null if
     * none. Recorded from our own approved write rather than read from Google
     * on every checklist load: the checklist is a cheap, always-available
     * derivation, and a Google call would add latency, quota use and a failure
     * mode to Home. A change the owner makes directly on Google is not seen.
     */
    listingWebsiteUri?: string | null;
  } | null;
  /** tenant_settings.google_review_url. */
  googleReviewUrl: string | null | undefined;
  /**
   * The owner's call forwarding (#1765). `checkPassedAt` is wired by the
   * forwarding check (#1766); until a check passes the item stays open.
   */
  callForwarding: {
    carrier: CallForwardingCarrier;
    mode: CallForwardingMode;
    checkPassedAt: Date | null;
  } | null;
  /** tenant_settings.website_url: the owner's own site or the published tenant site. */
  websiteUrl: string | null | undefined;
  /** The last failed Google website write (#1771): its reason, or null/absent. */
  googleWebsiteFailure?: string | null;
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

function callForwarding(facts: GetFoundOnlineFacts): Evaluated['result'] {
  const forwarding = facts.callForwarding;
  if (!forwarding) return { status: 'open', reason: 'not_set_up' };
  return forwarding.checkPassedAt ? 'done' : { status: 'open', reason: 'not_checked' };
}

function website(facts: GetFoundOnlineFacts): Evaluated['result'] {
  return facts.websiteUrl?.trim() ? 'done' : { status: 'open', reason: 'missing' };
}

/** Compare ignoring case, a trailing slash and a bare "www." — never the path. */
export function sameWebsite(a: string | null | undefined, b: string | null | undefined): boolean {
  const norm = (u: string | null | undefined) =>
    (u ?? '').trim().toLowerCase().replace(/^(https?:\/\/)www\./, '$1').replace(/\/+$/, '');
  return norm(a) !== '' && norm(a) === norm(b);
}

function googleWebsite(facts: GetFoundOnlineFacts): Evaluated['result'] {
  const google = facts.google;
  if (!google) return { status: 'open', reason: 'not_connected' };
  if (google.locationState === 'needs_pick') return { status: 'open', reason: 'needs_pick' };
  if (google.locationState !== 'connected') return { status: 'open', reason: 'not_connected' };
  if (!facts.websiteUrl?.trim()) return { status: 'open', reason: 'no_website' };
  if (sameWebsite(google.listingWebsiteUri, facts.websiteUrl)) return 'done';
  return facts.googleWebsiteFailure
    ? { status: 'error', reason: 'failed' }
    : { status: 'open', reason: 'not_published' };
}

export function deriveGetFoundOnlineChecklist(
  facts: GetFoundOnlineFacts,
): GetFoundOnlineChecklist {
  const evaluated: Evaluated[] = [
    { id: 'google_listing', result: googleListing(facts) },
    { id: 'review_link', result: reviewLink(facts) },
    { id: 'call_forwarding', result: callForwarding(facts) },
    { id: 'website', result: website(facts) },
    { id: 'google_website', result: googleWebsite(facts) },
  ];

  // The first open item is the owner's next step; waiting and error items
  // keep their own status so the card can say why.
  let currentAssigned = false;
  const items: GetFoundOnlineItem[] = evaluated.map(({ id, result }) => {
    if (result === 'done') {
      const checkedAt = id === 'call_forwarding' ? facts.callForwarding?.checkPassedAt : null;
      return { id, status: 'done', ...(checkedAt ? { checkedAt: checkedAt.toISOString() } : {}) };
    }
    if (result.status === 'open') {
      const status = currentAssigned ? 'pending' : 'current';
      currentAssigned = true;
      return { id, status, reason: result.reason };
    }
    return {
      id,
      status: result.status,
      reason: result.reason,
      ...(result.reason === 'failed' && facts.googleWebsiteFailure
        ? { failureReason: facts.googleWebsiteFailure }
        : {}),
    };
  });

  const allDone = items.every((i) => i.status === 'done');
  return { items, allDone, visible: !allDone || facts.dismissedAt === null };
}
