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

describe('nextGoogleReviewUrl', () => {
  it('fills an empty setting', () => {
    expect(nextGoogleReviewUrl({ current: null, previousDerived: null, derived: DERIVED })).toBe(DERIVED);
    expect(nextGoogleReviewUrl({ current: '  ', previousDerived: null, derived: DERIVED })).toBe(DERIVED);
  });

  it('replaces the link a previous listing derived', () => {
    expect(
      nextGoogleReviewUrl({ current: OLD_DERIVED, previousDerived: OLD_DERIVED, derived: DERIVED }),
    ).toBe(DERIVED);
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
    expect(await applyDerivedGoogleReviewUrl(repo, 't1', null, DERIVED)).toBe(true);
    expect((await repo.findByTenant('t1'))?.googleReviewUrl).toBe(DERIVED);
  });

  it('leaves a tenant with no settings row alone', async () => {
    const repo = new InMemorySettingsRepository();
    expect(await applyDerivedGoogleReviewUrl(repo, 'nobody', null, DERIVED)).toBe(false);
    expect(await repo.findByTenant('nobody')).toBeNull();
  });

  it('replaces the old listing link after a disconnect and reconnect to another listing', async () => {
    const repo = new InMemorySettingsRepository();
    await repo.upsertIdentityFields('t1', { businessName: 'Acme' });
    await applyDerivedGoogleReviewUrl(repo, 't1', null, 'https://g.page/r/old');
    // Disconnect deleted the integration row, so the caller knows no previous link.
    expect(await applyDerivedGoogleReviewUrl(repo, 't1', null, 'https://g.page/r/new')).toBe(true);
    expect((await repo.findByTenant('t1'))?.googleReviewUrl).toBe('https://g.page/r/new');
  });

  it('still never replaces a link the owner typed after the app filled one in', async () => {
    const repo = new InMemorySettingsRepository();
    await repo.upsertIdentityFields('t1', { businessName: 'Acme' });
    await applyDerivedGoogleReviewUrl(repo, 't1', null, 'https://g.page/r/old');
    await repo.update('t1', { googleReviewUrl: 'https://g.page/r/typed' });
    expect(await applyDerivedGoogleReviewUrl(repo, 't1', null, 'https://g.page/r/new')).toBe(false);
    expect((await repo.findByTenant('t1'))?.googleReviewUrl).toBe('https://g.page/r/typed');
  });

  it('adopts a pasted link that matches the listing, so the next listing can replace it', async () => {
    const repo = new InMemorySettingsRepository();
    await repo.upsertIdentityFields('t1', { businessName: 'Acme' });
    await repo.update('t1', { googleReviewUrl: 'https://g.page/r/old' });
    expect(await applyDerivedGoogleReviewUrl(repo, 't1', null, 'https://g.page/r/old')).toBe(false);
    expect(await applyDerivedGoogleReviewUrl(repo, 't1', null, 'https://g.page/r/new')).toBe(true);
  });
});
