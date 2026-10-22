/**
 * D-044 — the tenant's Google review link follows the connected Google
 * listing, so the post-job rating page sends 4★+ customers to the right
 * place without the owner pasting a URL. A link the owner typed by hand
 * always wins: the derived link only fills an empty setting, or replaces
 * the link a previous listing derived.
 */
import type { SettingsRepository } from '../settings/settings';

export interface ReviewUrlInputs {
  /** `tenant_settings.google_review_url` today. */
  current: string | null | undefined;
  /** The link the previously connected listing derived, if any. */
  previousDerived: string | null;
  /** The link the newly connected listing derives. */
  derived: string | null;
}

/**
 * What to do with the setting: write a new link, clear an app-filled link
 * the new listing can't replace (a listing with no review link yet), or
 * keep it (null). A link the owner typed is always kept.
 */
export type ReviewUrlChange = { kind: 'set'; url: string } | { kind: 'clear' } | null;

export function nextGoogleReviewUrl(input: ReviewUrlInputs): ReviewUrlChange {
  const { derived } = input;
  const current = input.current?.trim() ?? '';
  const ours = current !== '' && !!input.previousDerived && current === input.previousDerived;
  if (!derived) return ours ? { kind: 'clear' } : null;
  if (current === derived) return null;
  if (current === '' || ours) return { kind: 'set', url: derived };
  return null;
}

/**
 * Apply {@link nextGoogleReviewUrl} to the tenant's settings and say what
 * happened to the link. A tenant without a settings row is left
 * alone (onboarding creates the row).
 *
 * The link the app last filled in is remembered on the settings row
 * (`googleReviewUrlDerived`) and is the only proof a link is ours: it
 * survives a disconnect, and an owner's own edit of the link drops it.
 */
export async function applyDerivedGoogleReviewUrl(
  settingsRepo: Pick<SettingsRepository, 'findByTenant' | 'update'>,
  tenantId: string,
  derived: string | null,
): Promise<'set' | 'cleared' | 'kept'> {
  const settings = await settingsRepo.findByTenant(tenantId);
  if (!settings) return 'kept';
  const next = nextGoogleReviewUrl({
    current: settings.googleReviewUrl,
    previousDerived: settings.googleReviewUrlDerived ?? null,
    derived,
  });
  if (next?.kind === 'set') {
    await settingsRepo.update(tenantId, { googleReviewUrl: next.url, googleReviewUrlDerived: next.url });
    return 'set';
  }
  if (next?.kind === 'clear') {
    // The old listing's link would send customers to the wrong business;
    // an empty link reopens the checklist item instead.
    await settingsRepo.update(tenantId, { googleReviewUrl: null, googleReviewUrlDerived: null });
    return 'cleared';
  }
  // A link the owner typed stays theirs, even when it matches the listing's.
  return 'kept';
}
