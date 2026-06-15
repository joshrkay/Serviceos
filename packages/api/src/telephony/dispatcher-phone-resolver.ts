/**
 * Resolves on-call rotation userIds to E.164 phones for `<Dial>` escalation.
 *
 * `createUserPhoneDispatcherResolver` returns the on-call user's OWN mobile
 * number (`users.mobile_number`) or `null` when they have none on file —
 * `escalateToHuman`'s rotation walk treats `null` as "advance to the next
 * on-call user", so a tradesperson who has set their number gets dialed even
 * when an earlier entry has not.
 *
 * The tenant-level `business_phone` last resort is DELIBERATELY a separate
 * helper (`createBusinessPhoneFallback`), consulted by `escalateToHuman` only
 * after the rotation is exhausted. It must NOT live inside the per-user
 * resolver: returning `business_phone` for a numberless user would make every
 * rotation entry resolve non-null, pinning every call to entry 0 and silently
 * defeating per-user selection.
 */
import type { SettingsRepository } from '../settings/settings';
import type { UserRepository } from '../users/user';
import type { DispatcherPhoneResolver } from '../ai/skills/escalate-to-human';

/** Per-user resolver: the rotation user's own mobile, or null to advance. */
export function createUserPhoneDispatcherResolver(
  userRepo: UserRepository,
): DispatcherPhoneResolver {
  return async (tenantId: string, userId: string): Promise<string | null> => {
    const user = await userRepo.findById(tenantId, userId);
    const phone = user?.mobileNumber?.trim();
    return phone && phone.length > 0 ? phone : null;
  };
}

/**
 * Tenant-level last resort: the shared `business_phone`, dialed only when the
 * ENTIRE on-call rotation has no per-user mobile on file — so a tenant that
 * hasn't adopted per-user numbers never loses escalation.
 */
export function createBusinessPhoneFallback(
  settingsRepo: SettingsRepository,
): (tenantId: string) => Promise<string | null> {
  return async (tenantId: string): Promise<string | null> => {
    const settings = await settingsRepo.findByTenant(tenantId);
    const phone = settings?.businessPhone?.trim();
    return phone && phone.length > 0 ? phone : null;
  };
}
