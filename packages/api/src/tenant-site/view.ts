/**
 * D-044 / #1768 — builds the tenant site's view from tenant settings, so the
 * page follows the settings with nothing to re-publish.
 */
import type { Pool } from 'pg';
import type { SettingsRepository } from '../settings/settings';
import type { VerticalPackRegistry } from '../shared/vertical-pack-registry';
import { formatBusinessHoursSummary } from '../public-intake/format-business-hours';
import { resolvePublicBusinessPhone, resolvePublicServiceTypes } from '../public-intake/public-business-info';
import type { TenantSiteView } from './render';

export interface TenantSiteViewDeps {
  settingsRepo: Pick<SettingsRepository, 'findByTenant'>;
  packRegistry: VerticalPackRegistry;
  pool?: Pool | undefined;
  /** Where the SPA (and so the public lead / booking pages) lives. */
  webOrigin: string;
}

/** The existing public pages the site links to; both take the tenant as `?t=`. */
export function publicFormUrls(webOrigin: string, tenantId: string): { requestUrl: string; bookUrl: string } {
  const t = encodeURIComponent(tenantId);
  return { requestUrl: `${webOrigin}/intake?t=${t}`, bookUrl: `${webOrigin}/book?t=${t}` };
}

/** Null when the tenant has no settings row (no business name to show). */
export async function loadTenantSiteView(
  deps: TenantSiteViewDeps,
  tenantId: string,
  aboutText: string | null,
): Promise<TenantSiteView | null> {
  const settings = await deps.settingsRepo.findByTenant(tenantId);
  if (!settings?.businessName?.trim()) return null;

  const [serviceTypes, phone] = await Promise.all([
    resolvePublicServiceTypes(settings, deps.packRegistry),
    resolvePublicBusinessPhone(settings, tenantId, deps.pool),
  ]);

  return {
    businessName: settings.businessName.trim(),
    services: serviceTypes.map((s) => s.displayName),
    serviceArea: settings.serviceAreaText?.trim() || null,
    hoursSummary: formatBusinessHoursSummary(settings.businessHours, settings.timezone),
    phone,
    aboutText,
    ...publicFormUrls(deps.webOrigin, tenantId),
  };
}
