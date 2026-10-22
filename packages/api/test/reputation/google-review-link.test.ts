/**
 * D-044 — the Google review link follows the connected listing, but a link
 * the owner typed always wins.
 */
import { describe, expect, it } from 'vitest';
import {
  applyDerivedGoogleReviewUrl,
  nextGoogleReviewUrl,
} from '../../src/reputation/google-review-link';
import { InMemorySettingsRepository } from '../../src/settings/settings';

const DERIVED = 'https://g.page/r/new/review';
const OLD_DERIVED = 'https://g.page/r/old/review';
const SET = { kind: 'set', url: DERIVED };

describe('nextGoogleReviewUrl', () => {
  it('fills an empty setting', () => {
    expect(nextGoogleReviewUrl({ current: null, previousDerived: null, derived: DERIVED })).toEqual(SET);
    expect(nextGoogleReviewUrl({ current: '  ', previousDerived: null, derived: DERIVED })).toEqual(SET);
  });

  it('replaces the link a previous listing derived', () => {
    expect(
      nextGoogleReviewUrl({ current: OLD_DERIVED, previousDerived: OLD_DERIVED, derived: DERIVED }),
    ).toEqual(SET);
  });

  it('clears the previous listing link when the new listing has none', () => {
    expect(
      nextGoogleReviewUrl({ current: OLD_DERIVED, previousDerived: OLD_DERIVED, derived: null }),
    ).toEqual({ kind: 'clear' });
    // ...but never a link the owner typed.
    expect(
      nextGoogleReviewUrl({ current: 'https://g.page/r/mine', previousDerived: OLD_DERIVED, derived: null }),
    ).toBeNull();
  });

  it('never overwrites a link the owner typed', () => {
    expect(
      nextGoogleReviewUrl({ current: 'https://g.page/r/mine', previousDerived: OLD_DERIVED, derived: DERIVED }),
    ).toBeNull();
    expect(
      nextGoogleReviewUrl({ current: 'https://g.page/r/mine', previousDerived: null, derived: DERIVED }),
    ).toBeNull();
  });

  it('writes nothing when the listing has no review link or the value is unchanged', () => {
    expect(nextGoogleReviewUrl({ current: '', previousDerived: null, derived: null })).toBeNull();
    expect(nextGoogleReviewUrl({ current: DERIVED, previousDerived: null, derived: DERIVED })).toBeNull();
  });
});

describe('applyDerivedGoogleReviewUrl', () => {
  it('writes the derived link to settings and reports it', async () => {
    const repo = new InMemorySettingsRepository();
    await repo.upsertIdentityFields('t1', { businessName: 'Acme' });
    expect(await applyDerivedGoogleReviewUrl(repo, 't1', DERIVED)).toBe('set');
    expect((await repo.findByTenant('t1'))?.googleReviewUrl).toBe(DERIVED);
  });

  it('leaves a tenant with no settings row alone', async () => {
    const repo = new InMemorySettingsRepository();
    expect(await applyDerivedGoogleReviewUrl(repo, 'nobody', DERIVED)).toBe('kept');
    expect(await repo.findByTenant('nobody')).toBeNull();
  });

  it('replaces the old listing link after a disconnect and reconnect to another listing', async () => {
    const repo = new InMemorySettingsRepository();
    await repo.upsertIdentityFields('t1', { businessName: 'Acme' });
    await applyDerivedGoogleReviewUrl(repo, 't1', 'https://g.page/r/old');
    // Disconnect deleted the integration row; the settings marker still knows the old link.
    expect(await applyDerivedGoogleReviewUrl(repo, 't1', 'https://g.page/r/new')).toBe('set');
    expect((await repo.findByTenant('t1'))?.googleReviewUrl).toBe('https://g.page/r/new');
  });

  it('still never replaces a link the owner typed after the app filled one in', async () => {
    const repo = new InMemorySettingsRepository();
    await repo.upsertIdentityFields('t1', { businessName: 'Acme' });
    await applyDerivedGoogleReviewUrl(repo, 't1', 'https://g.page/r/old');
    await repo.update('t1', { googleReviewUrl: 'https://g.page/r/typed' });
    expect(await applyDerivedGoogleReviewUrl(repo, 't1', 'https://g.page/r/new')).toBe('kept');
    expect((await repo.findByTenant('t1'))?.googleReviewUrl).toBe('https://g.page/r/typed');
  });

  it('a typed link that matches the listing stays the owner\'s: never replaced or cleared later', async () => {
    const repo = new InMemorySettingsRepository();
    await repo.upsertIdentityFields('t1', { businessName: 'Acme' });
    await repo.update('t1', { googleReviewUrl: 'https://g.page/r/old' });
    expect(await applyDerivedGoogleReviewUrl(repo, 't1', 'https://g.page/r/old')).toBe('kept');
    expect(await applyDerivedGoogleReviewUrl(repo, 't1', 'https://g.page/r/new')).toBe('kept');
    expect(await applyDerivedGoogleReviewUrl(repo, 't1', null)).toBe('kept');
    expect((await repo.findByTenant('t1'))?.googleReviewUrl).toBe('https://g.page/r/old');
  });

  it('an owner edit drops the app-filled marker, even if they later type the old link back', async () => {
    const repo = new InMemorySettingsRepository();
    await repo.upsertIdentityFields('t1', { businessName: 'Acme' });
    expect(await applyDerivedGoogleReviewUrl(repo, 't1', OLD_DERIVED)).toBe('set');
    // An unrelated save that sends the same link keeps the marker.
    await repo.update('t1', { googleReviewUrl: OLD_DERIVED, yelpReviewUrl: 'https://yelp.com/biz/acme' });
    expect((await repo.findByTenant('t1'))?.googleReviewUrlDerived).toBe(OLD_DERIVED);
    await repo.update('t1', { googleReviewUrl: 'https://g.page/r/typed' });
    await repo.update('t1', { googleReviewUrl: OLD_DERIVED });
    expect(await applyDerivedGoogleReviewUrl(repo, 't1', DERIVED)).toBe('kept');
    expect((await repo.findByTenant('t1'))?.googleReviewUrl).toBe(OLD_DERIVED);
  });

  it('clears an app-filled link when the owner switches to a listing with no review link', async () => {
    const repo = new InMemorySettingsRepository();
    await repo.upsertIdentityFields('t1', { businessName: 'Acme' });
    await applyDerivedGoogleReviewUrl(repo, 't1', 'https://g.page/r/old');
    expect(await applyDerivedGoogleReviewUrl(repo, 't1', null)).toBe('cleared');
    expect((await repo.findByTenant('t1'))?.googleReviewUrl ?? null).toBeNull();
  });

  it('a retry after a failed settings write still replaces the old listing link', async () => {
    const repo = new InMemorySettingsRepository();
    await repo.upsertIdentityFields('t1', { businessName: 'Acme' });
    await applyDerivedGoogleReviewUrl(repo, 't1', 'https://g.page/r/a');
    // The integration already moved to B, but the settings write for B
    // failed: the marker still says A, so A is replaced on the retry.
    expect(
      await applyDerivedGoogleReviewUrl(repo, 't1', 'https://g.page/r/b'),
    ).toBe('set');
    expect((await repo.findByTenant('t1'))?.googleReviewUrl).toBe('https://g.page/r/b');
  });
});
