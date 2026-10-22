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
    expect(await applyDerivedGoogleReviewUrl(repo, 't1', null, DERIVED)).toBe('set');
    expect((await repo.findByTenant('t1'))?.googleReviewUrl).toBe(DERIVED);
  });

  it('leaves a tenant with no settings row alone', async () => {
    const repo = new InMemorySettingsRepository();
    expect(await applyDerivedGoogleReviewUrl(repo, 'nobody', null, DERIVED)).toBe('kept');
    expect(await repo.findByTenant('nobody')).toBeNull();
  });

  it('replaces the old listing link after a disconnect and reconnect to another listing', async () => {
    const repo = new InMemorySettingsRepository();
    await repo.upsertIdentityFields('t1', { businessName: 'Acme' });
    await applyDerivedGoogleReviewUrl(repo, 't1', null, 'https://g.page/r/old');
    // Disconnect deleted the integration row, so the caller knows no previous link.
    expect(await applyDerivedGoogleReviewUrl(repo, 't1', null, 'https://g.page/r/new')).toBe('set');
    expect((await repo.findByTenant('t1'))?.googleReviewUrl).toBe('https://g.page/r/new');
  });

  it('still never replaces a link the owner typed after the app filled one in', async () => {
    const repo = new InMemorySettingsRepository();
    await repo.upsertIdentityFields('t1', { businessName: 'Acme' });
    await applyDerivedGoogleReviewUrl(repo, 't1', null, 'https://g.page/r/old');
    await repo.update('t1', { googleReviewUrl: 'https://g.page/r/typed' });
    expect(await applyDerivedGoogleReviewUrl(repo, 't1', null, 'https://g.page/r/new')).toBe('kept');
    expect((await repo.findByTenant('t1'))?.googleReviewUrl).toBe('https://g.page/r/typed');
  });

  it('adopts a pasted link that matches the listing, so the next listing can replace it', async () => {
    const repo = new InMemorySettingsRepository();
    await repo.upsertIdentityFields('t1', { businessName: 'Acme' });
    await repo.update('t1', { googleReviewUrl: 'https://g.page/r/old' });
    expect(await applyDerivedGoogleReviewUrl(repo, 't1', null, 'https://g.page/r/old')).toBe('kept');
    expect(await applyDerivedGoogleReviewUrl(repo, 't1', null, 'https://g.page/r/new')).toBe('set');
  });

  it('clears an app-filled link when the owner switches to a listing with no review link', async () => {
    const repo = new InMemorySettingsRepository();
    await repo.upsertIdentityFields('t1', { businessName: 'Acme' });
    await applyDerivedGoogleReviewUrl(repo, 't1', null, 'https://g.page/r/old');
    expect(await applyDerivedGoogleReviewUrl(repo, 't1', null, null)).toBe('cleared');
    expect((await repo.findByTenant('t1'))?.googleReviewUrl ?? null).toBeNull();
  });

  it('a retry after a failed settings write still replaces the old listing link', async () => {
    const repo = new InMemorySettingsRepository();
    await repo.upsertIdentityFields('t1', { businessName: 'Acme' });
    await applyDerivedGoogleReviewUrl(repo, 't1', null, 'https://g.page/r/a');
    // The integration already moved to B, but the settings write for B failed:
    // the caller now reports B as the previous link.
    expect(
      await applyDerivedGoogleReviewUrl(repo, 't1', 'https://g.page/r/b', 'https://g.page/r/b'),
    ).toBe('set');
    expect((await repo.findByTenant('t1'))?.googleReviewUrl).toBe('https://g.page/r/b');
  });
});
