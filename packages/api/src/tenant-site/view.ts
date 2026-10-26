/**
 * D-044 / #1768 — builds the tenant site's view from tenant settings, so the
 * page follows the settings with nothing to re-publish.
 */
import type { Pool } from 'pg';
import { withTenantScope } from '../db/tenant-transaction';
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

/**
 * Null when the tenant has no settings row (no business name to show).
 *
 * The settings row and the phone fallback are read in one tenant transaction
 * under the RLS runtime role (withTenantScope): the request's on
 * /api/tenant-site/preview and /publish, one session of its own on the public
 * host page. The service list comes after it, never beside it: the pack
 * catalog is a global table read on a checkout of its own.
 */
export async function loadTenantSiteView(
  deps: TenantSiteViewDeps,
  tenantId: string,
): Promise<TenantSiteView | null> {
  const readTenantRows = async () => {
    const found = await deps.settingsRepo.findByTenant(tenantId);
    const businessName = found?.businessName?.trim();
    if (!found || !businessName) return null;
    return { settings: found, businessName, phone: await resolvePublicBusinessPhone(found, tenantId, deps.pool) };
  };
  const rows = deps.pool ? await withTenantScope(deps.pool, tenantId, readTenantRows) : await readTenantRows();
  if (!rows) return null;
  const { settings, businessName, phone } = rows;

  const serviceTypes = await resolvePublicServiceTypes(settings, deps.packRegistry);

  return {
    businessName,
    services: serviceTypes.map((s) => s.displayName),
    serviceArea: settings.serviceAreaText?.trim() || null,
    hoursSummary: formatBusinessHoursSummary(settings.businessHours, settings.timezone),
    phone,
    // The owner-approved about copy (#1769); none until they approve a draft.
    aboutText: settings.siteAboutText?.trim() || null,
    ...publicFormUrls(deps.webOrigin, tenantId),
  };
}
