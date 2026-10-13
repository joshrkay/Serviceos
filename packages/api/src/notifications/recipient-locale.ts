/**
 * What the quiet-hours window knows about a customer text's recipient: the
 * tenant's zone and business number (`tenant_settings`), the customer's
 * service-location states and the recipient's number. `recipientQuietHours`
 * requires the window to be open in ALL of their zones, so a tenant zone left
 * at a pre-migration-263 default cannot open the window early for a recipient
 * placed elsewhere, and whatever cannot be placed counts as anywhere in the US.
 */
import type { RecipientLocale } from '../compliance/jurisdiction';
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
    return {
      // Unknown stays unknown: the window then requires every US zone.
      tenantTimezone: zone && isValidIanaTimezone(zone) ? zone : null,
      serviceStates: locations.map((l) => l.state),
      phone: to || null,
      tenantPhone: settings?.businessPhone ?? null,
    };
  };
}
