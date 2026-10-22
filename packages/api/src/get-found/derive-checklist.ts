/**
 * The Get-found checklist (D-044): the post-activation list of what still
 * stands between a tenant and being found, reviewed and answered online.
 *
 * A pure function of facts, like `deriveOnboardingStatus` — but deliberately
 * separate from it: nothing here gates activation, `isComplete`, or the
 * setup-reminder sweep. Items are ticked only by detected facts, never by
 * the owner (D-044 §21).
 */

export type PresencePath = 'own_website' | 'google_only' | 'neither';

export type CallRoutingMode = 'forward_all' | 'forward_unanswered' | 'rivet_only';

export type GoogleProfileState = 'none' | 'pending_verification' | 'verified';

export interface GetFoundFacts {
  presencePath: PresencePath | null;
  googleProfile: GoogleProfileState;
  /** `tenant_settings.google_review_url` — pasted by hand or filled from Google. */
  googleReviewUrl: string | null;
  callRoutingMode: CallRoutingMode | null;
  rivetNumberProvisioned: boolean;
  /** `tenant_settings.forwarding_verified_at` (migration 318): a forwarded call on the owner's current line reached Rivet. */
  forwardingVerifiedAt: Date | null;
  /** Items the owner chose to skip; they fold into the card's hidden row. */
  skippedItems: GetFoundItemId[];
}

/** Every item, in the order the card shows them. */
export const GET_FOUND_ITEM_IDS = ['google_profile', 'review_link', 'call_routing'] as const;

export type GetFoundItemId = (typeof GET_FOUND_ITEM_IDS)[number];

export type GetFoundItemStatus = 'done' | 'pending' | 'waiting' | 'skipped';

/** What a `waiting` item is waiting on — something outside the owner's next tap. */
export type GetFoundWaitingOn = 'google_verification';

export interface GetFoundItem {
  id: GetFoundItemId;
  status: GetFoundItemStatus;
  waitingOn?: GetFoundWaitingOn;
}

export interface GetFoundChecklist {
  presencePath: PresencePath | null;
  items: GetFoundItem[];
  allDone: boolean;
}

function isCallRoutingDone(f: GetFoundFacts): boolean {
  if (f.callRoutingMode === 'rivet_only') return f.rivetNumberProvisioned;
  if (f.callRoutingMode === null) return false;
  return f.forwardingVerifiedAt !== null;
}

export function deriveGetFoundChecklist(f: GetFoundFacts): GetFoundChecklist {
  if (f.presencePath === null) {
    return { presencePath: null, items: [], allDone: false };
  }
  const done: Record<GetFoundItemId, boolean> = {
    google_profile: f.googleProfile === 'verified',
    review_link: f.googleReviewUrl !== null,
    call_routing: isCallRoutingDone(f),
  };
  const items = GET_FOUND_ITEM_IDS.map((id): GetFoundItem => {
    if (done[id]) return { id, status: 'done' };
    if (f.skippedItems.includes(id)) return { id, status: 'skipped' };
    if (id === 'google_profile' && f.googleProfile === 'pending_verification') {
      return { id, status: 'waiting', waitingOn: 'google_verification' };
    }
    return { id, status: 'pending' };
  });
  const allDone = items.every((item) => item.status === 'done' || item.status === 'skipped');
  return { presencePath: f.presencePath, items, allDone };
}
