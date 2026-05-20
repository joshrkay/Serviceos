/**
 * Public intake API client — UNAUTHENTICATED.
 *
 * The /intake page is a public, shareable marketing link; there is no
 * Clerk session. These calls use plain `fetch`, not `apiFetch`. The
 * tenant id comes from the `?t=<uuid>` query param on the landing URL
 * (resolved by the caller, not this module).
 */

export interface IntakeServiceType {
  verticalType: string;
  displayName: string;
}

export interface IntakeTenantInfo {
  businessName: string;
  businessPhone: string | null;
  serviceTypes: IntakeServiceType[];
  businessHoursSummary?: string | null;
  intakeTagline?: string | null;
}

export interface SubmitIntakeLeadPayload {
  firstName: string;
  lastName?: string;
  primaryPhone?: string;
  email?: string;
  serviceType?: string;
  urgency?: string;
  description?: string;
  preferredDates?: string;
  address?: string;
  utmSource?: string;
  utmMedium?: string;
  utmCampaign?: string;
  attribution?: Record<string, string>;
  /** Honeypot — always sent empty; bots that fill every field trip it. */
  _company_url: string;
}

/** Load the tenant's public-facing branding + service types for the intake form. */
export async function fetchIntakeTenantInfo(tenantId: string): Promise<IntakeTenantInfo> {
  const res = await fetch(`/public/intake/${encodeURIComponent(tenantId)}`, {
    method: 'GET',
    headers: { accept: 'application/json' },
  });
  if (!res.ok) {
    throw new Error(`Could not load intake form (${res.status})`);
  }
  return (await res.json()) as IntakeTenantInfo;
}

/** Submit a public intake lead. Resolves with the created lead id on success. */
export async function submitIntakeLead(
  tenantId: string,
  payload: SubmitIntakeLeadPayload,
): Promise<{ ok?: boolean; leadId?: string }> {
  const res = await fetch(`/public/intake/${encodeURIComponent(tenantId)}/leads`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    throw new Error(`Submission failed (${res.status})`);
  }
  return (await res.json()) as { ok?: boolean; leadId?: string };
}
