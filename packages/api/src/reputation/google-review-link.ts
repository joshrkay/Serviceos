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

/** The value to write, or null when the setting must stay as it is. */
export function nextGoogleReviewUrl(input: ReviewUrlInputs): string | null {
  const { derived } = input;
  if (!derived) return null;
  const current = input.current?.trim() ?? '';
  if (current === derived) return null;
  if (current === '') return derived;
  if (input.previousDerived && current === input.previousDerived) return derived;
  return null;
}

/**
 * Apply {@link nextGoogleReviewUrl} to the tenant's settings. Returns true
 * when the setting was written. A tenant without a settings row is left
 * alone (onboarding creates the row).
 */
export async function applyDerivedGoogleReviewUrl(
  settingsRepo: Pick<SettingsRepository, 'findByTenant' | 'update'>,
  tenantId: string,
  previousDerived: string | null,
  derived: string | null,
): Promise<boolean> {
  const settings = await settingsRepo.findByTenant(tenantId);
  if (!settings) return false;
  const next = nextGoogleReviewUrl({
    current: settings.googleReviewUrl,
    previousDerived,
    derived,
  });
  if (next === null) return false;
  await settingsRepo.update(tenantId, { googleReviewUrl: next });
  return true;
}
