/**
 * Service-area enforcement (foundation gate F2 term 5 —
 * spec/RIVET_FOUNDATION_SPEC.md §4).
 *
 * The tenant's service area is modeled as a ZIP allowlist
 * (`tenant_settings.service_area_zips`, migration 148) captured during
 * onboarding. Enforcement follows the foundation principle for every
 * availability term: enforce exactly what the tenant configured, degrade
 * explicitly when unconfigured. An empty list means the tenant has not
 * bounded their area — every address is accepted, and the caller can
 * surface that as a config note (V18), never as a silent guess.
 */

export type ServiceAreaVerdict =
  | { inArea: true; reason: 'not_configured' | 'zip_match' }
  | { inArea: false; reason: 'zip_mismatch' };

/** First 5 digits of a US postal code ("85001-1234" → "85001"). */
function normalizeZip(postalCode: string): string {
  return postalCode.trim().slice(0, 5);
}

export function checkServiceArea(
  serviceAreaZips: string[] | null | undefined,
  postalCode: string,
): ServiceAreaVerdict {
  if (!serviceAreaZips || serviceAreaZips.length === 0) {
    return { inArea: true, reason: 'not_configured' };
  }
  const zip = normalizeZip(postalCode);
  const allowed = new Set(serviceAreaZips.map(normalizeZip));
  return allowed.has(zip)
    ? { inArea: true, reason: 'zip_match' }
    : { inArea: false, reason: 'zip_mismatch' };
}
