import {
  hasConfiguredWeeklyHours,
  isWithinBusinessHours,
  WeeklyBusinessHours,
} from '../scheduling/booking-availability';
import type { SettingsRepository } from '../settings/settings';

export const OUTSIDE_BUSINESS_HOURS_WARNING = 'Appointment is outside business hours';

/**
 * #1402 §3/§15 — non-blocking scheduling warnings for an operator write.
 *
 * Outside the tenant's configured business hours is a WARNING, never a
 * block (owners do take evening/weekend calls). A tenant with no business
 * hours configured gets no warning — the product default hours are a
 * booking-offer heuristic, not something the operator told us.
 */
export async function appointmentHoursWarnings(
  settingsRepo: Pick<SettingsRepository, 'findByTenant'> | undefined,
  tenantId: string,
  window: { start: Date; end: Date; timezone: string },
): Promise<string[]> {
  if (!settingsRepo) return [];
  const settings = await settingsRepo.findByTenant(tenantId);
  const weekly = (settings?.businessHours ?? null) as WeeklyBusinessHours | null;
  if (!hasConfiguredWeeklyHours(weekly)) return [];
  const tz = settings?.timezone || window.timezone;
  return isWithinBusinessHours(window.start, window.end, tz, weekly)
    ? []
    : [OUTSIDE_BUSINESS_HOURS_WARNING];
}
