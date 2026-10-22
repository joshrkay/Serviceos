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
  websiteUrl: null,
  dismissedAt: null,
};
const FORWARDING_PASSED = {
  carrier: 'verizon' as const,
  mode: 'missed' as const,
  checkPassedAt: new Date('2026-10-20T15:00:00Z'),
};
const CONNECTED = {
  locationState: 'connected' as const,
  pollingPaused: false,
  listingWebsiteUri: 'https://joes-plumbing.sites.example.com',
};
const REVIEW = 'https://g.page/r/review-999';
const SITE = 'https://joes-plumbing.sites.example.com';

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
      website: ['pending', 'missing'],
      google_website: ['pending', 'not_connected'],
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
      website: ['pending', 'missing'],
      google_website: ['pending', 'not_connected'],
    });
  });

  it('a connected listing whose polling is paused is an error, not done', () => {
    expect(
      statuses({ ...NOTHING, google: { ...CONNECTED, pollingPaused: true }, googleReviewUrl: REVIEW }),
    ).toEqual({
      google_listing: ['error', 'polling_paused'],
      review_link: ['done', undefined],
      call_forwarding: ['current', 'not_set_up'],
      website: ['pending', 'missing'],
      google_website: ['pending', 'no_website'],
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

  it('a website URL counts, whether the owner typed their own or publishing filled it in', () => {
    expect(statuses({ ...NOTHING, websiteUrl: SITE })).toMatchObject({ website: ['done', undefined] });
    expect(statuses({ ...NOTHING, websiteUrl: 'https://joesplumbing.com' })).toMatchObject({
      website: ['done', undefined],
    });
    expect(statuses({ ...NOTHING, websiteUrl: '  ' })).toMatchObject({ website: ['pending', 'missing'] });
  });

  it('#1771 google_website: ticks only when the listing shows the tenant website', () => {
    const base = { ...NOTHING, google: CONNECTED, websiteUrl: SITE };
    expect(statuses(base)).toMatchObject({ google_website: ['done', undefined] });
    // Case, a trailing slash and a bare www. do not matter.
    expect(
      statuses({ ...base, websiteUrl: 'HTTPS://www.Joes-Plumbing.sites.example.com/' }),
    ).toMatchObject({ google_website: ['done', undefined] });
    // A different path is a different page.
    expect(statuses({ ...base, websiteUrl: `${SITE}/about` })).toMatchObject({
      google_website: ['pending', 'not_published'],
    });
    // The owner changed their website setting after we wrote the old one.
    expect(statuses({ ...base, websiteUrl: 'https://joesplumbing.com' })).toMatchObject({
      google_website: ['pending', 'not_published'],
    });
    // Nothing written yet.
    expect(
      statuses({ ...base, google: { ...CONNECTED, listingWebsiteUri: null } }),
    ).toMatchObject({ google_website: ['pending', 'not_published'] });
  });

  it('#1771 google_website: a refused write is an error with the reason, until the listing shows the site', () => {
    const failed = {
      ...NOTHING,
      google: { ...CONNECTED, listingWebsiteUri: null },
      websiteUrl: SITE,
      googleWebsiteFailure: 'Google no longer accepts the connection.',
    };
    const item = deriveGetFoundOnlineChecklist(failed).items.find((i) => i.id === 'google_website');
    expect(item).toEqual({
      id: 'google_website',
      status: 'error',
      reason: 'failed',
      failureReason: 'Google no longer accepts the connection.',
    });
    expect(
      statuses({ ...failed, google: CONNECTED }),
    ).toMatchObject({ google_website: ['done', undefined] });
  });

  it('#1771 google_website: needs a connected listing and a website first', () => {
    expect(statuses({ ...NOTHING, websiteUrl: SITE })).toMatchObject({
      google_website: ['pending', 'not_connected'],
    });
    expect(
      statuses({ ...NOTHING, websiteUrl: SITE, google: { ...CONNECTED, locationState: 'needs_pick' } }),
    ).toMatchObject({ google_website: ['pending', 'needs_pick'] });
    expect(statuses({ ...NOTHING, google: CONNECTED })).toMatchObject({
      google_website: ['pending', 'no_website'],
    });
    expect(statuses({ ...NOTHING, google: CONNECTED, websiteUrl: '  ' })).toMatchObject({
      google_website: ['pending', 'no_website'],
    });
  });

  it('everything done: visible until dismissed', () => {
    const done = {
      ...NOTHING,
      google: CONNECTED,
      googleReviewUrl: REVIEW,
      callForwarding: FORWARDING_PASSED,
      websiteUrl: SITE,
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
      websiteUrl: SITE,
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
