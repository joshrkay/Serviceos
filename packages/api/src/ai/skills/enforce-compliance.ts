/**
 * enforce_compliance skill
 *
 * Checks two compliance gates before connecting an inbound caller:
 *   1. Is the caller on the tenant's DNC list?
 *   2. Is the current time within configured business hours?
 *
 * Design notes
 * ─────────────
 * - In-app channel bypasses all checks (used for internal/agent calls).
 * - We fail open on unavailable settings or DNC service errors to
 *   preserve caller availability.
 * - DNC hit is a hard block; after-hours is a soft flag that routes the
 *   caller to an after-hours greeting branch rather than rejecting them.
 * - Business hours config is derived from TenantSettings. Because
 *   TenantSettings does not (yet) carry a schedule, a null config causes
 *   checkBusinessHours to return `no_schedule_configured` (treat as open).
 */

import { SettingsRepository } from '../../settings/settings';
import { DncRepository, normalizePhone } from '../../compliance/dnc';
import {
  BusinessHoursConfig,
  checkBusinessHours,
} from '../../compliance/business-hours';

export { DncRepository, normalizePhone } from '../../compliance/dnc';
export { BusinessHoursConfig, BusinessHoursResult, checkBusinessHours } from '../../compliance/business-hours';

export interface ComplianceCheckInput {
  tenantId: string;
  callerPhone?: string;
  channel: 'telephony' | 'inapp';
  currentTime: Date;
  settingsRepo: SettingsRepository;
  dncRepo: DncRepository;
}

export interface ComplianceCheckResult {
  allowed: boolean;
  reasons: Array<'dnc_blocked' | 'after_hours' | 'open'>;
  isAfterHours: boolean;
}

export async function enforceCompliance(
  input: ComplianceCheckInput
): Promise<ComplianceCheckResult> {
  const { tenantId, callerPhone, channel, currentTime, settingsRepo, dncRepo } = input;

  // In-app calls bypass all compliance checks
  if (channel === 'inapp') {
    return { allowed: true, reasons: ['open'], isAfterHours: false };
  }

  // ── DNC check ────────────────────────────────────────────────────────────
  let isOnDnc = false;
  if (callerPhone) {
    const normalized = normalizePhone(callerPhone);
    if (normalized.length > 0) {
      try {
        isOnDnc = await dncRepo.isOnDnc(tenantId, normalized);
      } catch {
        // Fail open — do not block caller if DNC service is unavailable
        isOnDnc = false;
      }
    }
  }

  if (isOnDnc) {
    return { allowed: false, reasons: ['dnc_blocked'], isAfterHours: false };
  }

  // ── Business hours check ─────────────────────────────────────────────────
  let hoursConfig: BusinessHoursConfig | null = null;
  try {
    const settings = await settingsRepo.findByTenant(tenantId);
    if (settings) {
      // TenantSettings carries timezone; schedule will be added by a future
      // story. Until then, no schedule ⇒ checkBusinessHours returns
      // `no_schedule_configured` which is treated as open.
      hoursConfig = {
        timezone: settings.timezone,
        schedule: (settings as unknown as { businessHoursSchedule?: BusinessHoursConfig['schedule'] })
          .businessHoursSchedule ?? [],
      };
    }
  } catch {
    // Fail open — treat as open if settings unavailable
    hoursConfig = null;
  }

  const hoursResult = checkBusinessHours(hoursConfig, currentTime);
  const isAfterHours = !hoursResult.isOpen;

  if (isAfterHours) {
    // After-hours: caller is accepted but routed to an after-hours branch
    return { allowed: true, reasons: ['after_hours'], isAfterHours: true };
  }

  return { allowed: true, reasons: ['open'], isAfterHours: false };
}
