/**
 * D-044 / #1763 — the "Get found online" checklist is derived from tenant
 * facts; an item reopens the moment its fact stops being true.
 */
import { describe, expect, it } from 'vitest';
import {
  GetFoundOnlineFacts,
  deriveGetFoundOnlineChecklist,
} from '../../src/onboarding/get-found-online';

const NOTHING: GetFoundOnlineFacts = {
  google: null,
  googleReviewUrl: null,
  callForwarding: null,
  dismissedAt: null,
};
const FORWARDING_PASSED = {
  carrier: 'verizon' as const,
  mode: 'missed' as const,
  checkPassedAt: new Date('2026-10-20T15:00:00Z'),
};
const CONNECTED = { locationState: 'connected' as const, pollingPaused: false };
const REVIEW = 'https://g.page/r/review-999';

function statuses(facts: GetFoundOnlineFacts) {
  return Object.fromEntries(
    deriveGetFoundOnlineChecklist(facts).items.map((i) => [i.id, [i.status, i.reason]]),
  );
}

describe('deriveGetFoundOnlineChecklist', () => {
  it('a fresh tenant: connect Google is the next step, the review link waits behind it', () => {
    expect(statuses(NOTHING)).toEqual({
      google_listing: ['current', 'not_connected'],
      review_link: ['pending', 'missing'],
      call_forwarding: ['pending', 'not_set_up'],
    });
    expect(deriveGetFoundOnlineChecklist(NOTHING)).toMatchObject({ allDone: false, visible: true });
  });

  it('several locations: picking one is the next step', () => {
    expect(
      statuses({ ...NOTHING, google: { locationState: 'needs_pick', pollingPaused: false } }),
    ).toMatchObject({ google_listing: ['current', 'needs_pick'] });
  });

  it('no Business Profile yet: the listing waits on Google and the review link becomes current', () => {
    expect(
      statuses({ ...NOTHING, google: { locationState: 'no_location', pollingPaused: false } }),
    ).toEqual({
      google_listing: ['waiting', 'no_location'],
      review_link: ['current', 'missing'],
      call_forwarding: ['pending', 'not_set_up'],
    });
  });

  it('a connected listing whose polling is paused is an error, not done', () => {
    expect(
      statuses({ ...NOTHING, google: { ...CONNECTED, pollingPaused: true }, googleReviewUrl: REVIEW }),
    ).toEqual({
      google_listing: ['error', 'polling_paused'],
      review_link: ['done', undefined],
      call_forwarding: ['current', 'not_set_up'],
    });
  });

  it('a pasted review link counts even without Google connected', () => {
    expect(statuses({ ...NOTHING, googleReviewUrl: REVIEW })).toMatchObject({
      review_link: ['done', undefined],
    });
    expect(statuses({ ...NOTHING, googleReviewUrl: '   ' })).toMatchObject({
      review_link: ['pending', 'missing'],
    });
  });

  it('everything done: visible until dismissed', () => {
    const done = {
      ...NOTHING,
      google: CONNECTED,
      googleReviewUrl: REVIEW,
      callForwarding: FORWARDING_PASSED,
    };
    expect(deriveGetFoundOnlineChecklist(done)).toMatchObject({ allDone: true, visible: true });
    expect(
      deriveGetFoundOnlineChecklist({ ...done, dismissedAt: new Date('2026-10-22T00:00:00Z') }),
    ).toMatchObject({ allDone: true, visible: false });
  });

  it('disconnecting Google after a dismissal reopens the item and shows the card again', () => {
    const reopened = deriveGetFoundOnlineChecklist({
      google: null,
      googleReviewUrl: REVIEW,
      callForwarding: FORWARDING_PASSED,
      dismissedAt: new Date('2026-10-22T00:00:00Z'),
    });
    expect(reopened.visible).toBe(true);
    expect(reopened.allDone).toBe(false);
    expect(reopened.items[0]).toEqual({ id: 'google_listing', status: 'current', reason: 'not_connected' });
  });

  it('call forwarding: set up but never checked stays open until a check passes', () => {
    const picked = {
      ...NOTHING,
      google: CONNECTED,
      googleReviewUrl: REVIEW,
      callForwarding: { ...FORWARDING_PASSED, checkPassedAt: null },
    };
    expect(statuses(picked)).toMatchObject({ call_forwarding: ['current', 'not_checked'] });
    const passed = deriveGetFoundOnlineChecklist({ ...NOTHING, callForwarding: FORWARDING_PASSED });
    expect(passed.items[2]).toEqual({
      id: 'call_forwarding',
      status: 'done',
      checkedAt: '2026-10-20T15:00:00.000Z',
    });
  });
});
