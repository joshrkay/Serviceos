import { describe, it, expect } from 'vitest';
import { deriveGetFoundChecklist, type GetFoundFacts } from '../../src/get-found/derive-checklist';

function facts(overrides: Partial<GetFoundFacts> = {}): GetFoundFacts {
  return {
    presencePath: null,
    googleProfile: 'none',
    googleReviewUrl: null,
    hasForwardedLine: false,
    forwardingCheckPassedAt: null,
    rivetNumberLive: false,
    firstRealCallReceived: false,
    skippedItems: [],
    ...overrides,
  };
}

describe('deriveGetFoundChecklist', () => {
  it('shows no items until the owner answers the presence-path question', () => {
    const checklist = deriveGetFoundChecklist(facts());

    expect(checklist).toEqual({ presencePath: null, items: [], allDone: false });
  });

  it.each(['own_website', 'google_only', 'neither'] as const)(
    'on the %s path, a tenant with nothing set up sees Google profile, review link and call routing pending',
    (presencePath) => {
      const checklist = deriveGetFoundChecklist(facts({ presencePath }));

      expect(checklist.items).toEqual([
        { id: 'google_profile', status: 'pending' },
        { id: 'review_link', status: 'pending' },
        { id: 'call_routing', status: 'pending' },
      ]);
      expect(checklist.allDone).toBe(false);
    },
  );

  it('ticks the review link once one is set, however it was set', () => {
    const checklist = deriveGetFoundChecklist(
      facts({ presencePath: 'neither', googleReviewUrl: 'https://g.page/r/abc123/review' }),
    );

    expect(checklist.items).toContainEqual({ id: 'review_link', status: 'done' });
  });

  it('a day-one owner (no existing line) is not done by provisioning alone, only once the Rivet number has answered a call', () => {
    const live = { presencePath: 'neither' as const, rivetNumberLive: true };

    expect(deriveGetFoundChecklist(facts(live)).items).toContainEqual({ id: 'call_routing', status: 'pending' });
    expect(deriveGetFoundChecklist(facts({ ...live, firstRealCallReceived: true })).items).toContainEqual({
      id: 'call_routing',
      status: 'done',
    });
  });

  it('an owner forwarding an existing line is done only by a passing forwarding check, which the item dates', () => {
    const forwarding = { presencePath: 'own_website' as const, hasForwardedLine: true, rivetNumberLive: true, firstRealCallReceived: true };

    expect(deriveGetFoundChecklist(facts(forwarding)).items).toContainEqual({ id: 'call_routing', status: 'pending' });
    expect(
      deriveGetFoundChecklist(facts({ ...forwarding, forwardingCheckPassedAt: new Date('2026-10-22T15:00:00Z') })).items,
    ).toContainEqual({ id: 'call_routing', status: 'done', checkedAt: '2026-10-22T15:00:00.000Z' });
  });

  it('ticks the Google profile once a verified profile is connected', () => {
    const checklist = deriveGetFoundChecklist(facts({ presencePath: 'google_only', googleProfile: 'verified' }));

    expect(checklist.items).toContainEqual({ id: 'google_profile', status: 'done' });
  });

  it('shows the Google profile as waiting on Google while verification is pending', () => {
    const checklist = deriveGetFoundChecklist(
      facts({ presencePath: 'google_only', googleProfile: 'pending_verification' }),
    );

    expect(checklist.items).toContainEqual({
      id: 'google_profile',
      status: 'waiting',
      waitingOn: 'google_verification',
    });
  });

  it('shows an item the owner skipped as skipped', () => {
    const checklist = deriveGetFoundChecklist(facts({ presencePath: 'own_website', skippedItems: ['call_routing'] }));

    expect(checklist.items).toContainEqual({ id: 'call_routing', status: 'skipped' });
  });

  it('is all done once every item is done or skipped', () => {
    const checklist = deriveGetFoundChecklist(
      facts({
        presencePath: 'google_only',
        googleProfile: 'verified',
        googleReviewUrl: 'https://g.page/r/abc123/review',
        skippedItems: ['call_routing'],
      }),
    );

    expect(checklist.allDone).toBe(true);
  });
});
