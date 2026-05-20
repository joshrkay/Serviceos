/**
 * Resolves on-call rotation userIds to E.164 phones for `<Dial>` escalation.
 *
 * v1: uses tenant `business_phone` from settings for every rotation entry
 * until per-user mobile numbers land (Wave C B4).
 */
import type { SettingsRepository } from '../settings/settings';
import type { DispatcherPhoneResolver } from '../ai/skills/escalate-to-human';

export function createBusinessPhoneDispatcherResolver(
  settingsRepo: SettingsRepository,
): DispatcherPhoneResolver {
  return async (tenantId: string, _userId: string): Promise<string | null> => {
    const settings = await settingsRepo.findByTenant(tenantId);
    const phone = settings?.businessPhone?.trim();
    return phone && phone.length > 0 ? phone : null;
  };
}
