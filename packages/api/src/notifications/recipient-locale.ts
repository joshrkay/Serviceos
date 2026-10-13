/**
 * Where a customer text's quiet-hours window gets its timezone and state.
 *
 * Customers and service locations carry no zone, so the zone is the tenant's
 * (`tenant_settings.timezone` — a service business texts its own area). The
 * states are the customer's service-location states plus the early-close
 * state of the phone's area code. Unknown stays unknown — a null zone, an
 * empty state list — and `recipientQuietHours` answers that conservatively.
 */
import { earlyCloseStateForPhone, type RecipientLocale } from '../compliance/jurisdiction';
import { isValidIanaTimezone, type SettingsRepository } from '../settings/settings';
import type { LocationRepository } from '../locations/location';

export interface RecipientLocaleResolverDeps {
  settingsRepo: Pick<SettingsRepository, 'findByTenant'>;
  locationRepo: Pick<LocationRepository, 'findByCustomer'>;
}

export type RecipientLocaleResolver = (input: {
  tenantId: string | undefined;
  customerId: string | undefined;
  to: string;
}) => Promise<RecipientLocale>;

export function createRecipientLocaleResolver(
  deps: RecipientLocaleResolverDeps,
): RecipientLocaleResolver {
  return async ({ tenantId, customerId, to }) => {
    const settings = tenantId ? await deps.settingsRepo.findByTenant(tenantId) : null;
    const locations =
      tenantId && customerId ? await deps.locationRepo.findByCustomer(tenantId, customerId) : [];
    const zone = settings?.timezone;
    const areaCodeState = earlyCloseStateForPhone(to);
    return {
      // Unknown stays unknown: the window then requires every US zone.
      timezone: zone && isValidIanaTimezone(zone) ? zone : null,
      states: [...locations.map((l) => l.state), ...(areaCodeState ? [areaCodeState] : [])],
    };
  };
}
