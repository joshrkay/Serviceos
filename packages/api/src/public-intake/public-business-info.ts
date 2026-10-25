/**
 * What a business shows the public — the service list and a dialable phone —
 * resolved once for the intake form header (routes/public-intake.ts) and the
 * hosted tenant site (tenant-site/).
 */
import type { Pool } from 'pg';
import { withTenantClient } from '../db/tenant-transaction';
import type { TenantSettings } from '../settings/settings';
import type { VerticalPackRegistry } from '../shared/vertical-pack-registry';
import { isValidVerticalType } from '../shared/vertical-types';
import { isTwilioTestNumber } from '../telephony/phone-policy';

export interface PublicServiceType {
  verticalType: string;
  displayName: string;
}

export async function resolvePublicServiceTypes(
  settings: Pick<TenantSettings, 'activeVerticalPacks'> | null | undefined,
  packRegistry: VerticalPackRegistry,
): Promise<PublicServiceType[]> {
  const serviceTypes: PublicServiceType[] = [];
  const seenVerticals = new Set<string>();
  for (const packId of settings?.activeVerticalPacks ?? []) {
    let pack = await packRegistry.getByPackId(packId);
    if (!pack && isValidVerticalType(packId)) {
      const candidates = await packRegistry.findByVertical(packId);
      pack =
        candidates
          .filter((p) => p.status === 'active')
          .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())[0] ?? null;
    }
    if (pack && !seenVerticals.has(pack.verticalType)) {
      seenVerticals.add(pack.verticalType);
      serviceTypes.push({ verticalType: pack.verticalType, displayName: pack.displayName });
    }
  }
  return serviceTypes;
}

/**
 * The number a customer should dial, or null.
 *
 * #880 — never surface a Twilio test magic number publicly. The dev-stub
 * provisioning path writes {phoneE164: '+15005550006', stub: true} so
 * onboarding completes without Twilio creds; if such a row reaches a
 * deployed DB (mis-set NODE_ENV at provisioning time, or a row predating
 * the env gate), this fallback used to display the non-dialable magic
 * number to customers. Suppress stub/magic values and return null — every
 * render site guards on a phone being present, so the honest empty state
 * falls out for free.
 *
 * The fallback reads tenant_integrations under the RLS runtime role
 * (withTenantClient): on the caller's tenant transaction when it holds one
 * for this tenant — the intake header's and the tenant site's withTenantScope
 * session, or the /api request transaction on /api/tenant-site/preview and
 * /publish — and otherwise in one tenant session of its own.
 */
export async function resolvePublicBusinessPhone(
  settings: Pick<TenantSettings, 'businessPhone'> | null | undefined,
  tenantId: string,
  pool?: Pool,
): Promise<string | null> {
  let businessPhone = settings?.businessPhone?.trim() || null;
  if (businessPhone && isTwilioTestNumber(businessPhone)) {
    businessPhone = null;
  }
  if (!businessPhone && pool) {
    const twilioRow = await withTenantClient(pool, tenantId, (client) =>
      client.query<{ phone: string | null; stub: string | null }>(
        `SELECT provider_data->>'phoneE164' AS phone,
                provider_data->>'stub' AS stub
         FROM tenant_integrations
         WHERE tenant_id = $1 AND provider = 'twilio'
         LIMIT 1`,
        [tenantId],
      ),
    );
    const fallbackPhone = twilioRow.rows[0]?.phone?.trim() || null;
    const isStubRow = twilioRow.rows[0]?.stub === 'true';
    businessPhone =
      fallbackPhone && !isStubRow && !isTwilioTestNumber(fallbackPhone) ? fallbackPhone : null;
  }
  return businessPhone;
}
