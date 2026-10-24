import type { Pool } from 'pg';
import type { BusinessHoursConfig } from '../compliance/business-hours';
import { checkBusinessHours } from '../compliance/business-hours';
import { withTenantClient } from '../db/tenant-transaction';

const DAY_TO_ISO: Record<string, number> = {
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
  sun: 7,
};

/** Onboarding `business_hours` JSONB → compliance schedule. */
export function parseOnboardingBusinessHours(
  raw: unknown,
  timezone: string,
): BusinessHoursConfig | null {
  if (!raw || typeof raw !== 'object') return null;
  const schedule: BusinessHoursConfig['schedule'] = [];
  for (const [day, value] of Object.entries(raw as Record<string, unknown>)) {
    const iso = DAY_TO_ISO[day];
    if (!iso) continue;
    if (!value || typeof value !== 'object') continue;
    const open = (value as { open?: string }).open;
    const close = (value as { close?: string }).close;
    if (typeof open === 'string' && typeof close === 'string') {
      schedule.push({ dayOfWeek: iso, openTime: open, closeTime: close });
    }
  }
  if (schedule.length === 0) return null;
  return { timezone, schedule };
}

/**
 * The tenant's business hours, read under that tenant's context
 * (`rls_app_runtime`, raw-pg audit §4 P1.3): the request client when one is
 * ambient for the tenant (/api/analytics/voice-roi), otherwise one short
 * tenant transaction (the inbound /voice after-hours fork).
 */
export async function loadTenantBusinessHours(
  pool: Pool,
  tenantId: string,
): Promise<BusinessHoursConfig | null> {
  const result = await withTenantClient(pool, tenantId, (client) =>
    client.query<{ business_hours: unknown; timezone: string }>(
      `SELECT business_hours, timezone FROM tenant_settings WHERE tenant_id = $1 LIMIT 1`,
      [tenantId],
    ),
  );
  if (result.rows.length === 0) return null;
  const row = result.rows[0];
  return parseOnboardingBusinessHours(
    row.business_hours,
    row.timezone || 'America/New_York',
  );
}

export async function isTenantAfterHours(
  pool: Pool,
  tenantId: string,
  now = new Date(),
): Promise<boolean> {
  const config = await loadTenantBusinessHours(pool, tenantId);
  if (!config) return false;
  const { isOpen } = checkBusinessHours(config, now);
  return !isOpen;
}
