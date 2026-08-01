/**
 * Typed wrappers for the lead lifecycle surface (U8 / C4, C5). They take the
 * `fetch`-shaped client from `useApiClient` (Clerk JWT attached) and call no
 * hooks themselves.
 *
 * Both paths are DIRECT, audited HUMAN routes — NOT proposal mints. convert_lead
 * and mark_lead_lost are NOT on the `POST /api/proposals` whitelist (which only
 * accepts the four scheduling types: reschedule/reassign/add-crew/remove-crew),
 * so they go straight to the leads router:
 *   - POST /api/leads/:id/convert   convert a lead → customer (+ service location)
 *   - POST /api/leads/:id/lose      mark a lead lost with a reason
 */
import { decodeError } from '../lib/appError';
import type { AuthedFetch } from './me';

/**
 * Optional service-address override for conversion. The server's
 * `convertLeadAddressSchema` requires street1/city/state/postalCode TOGETHER
 * (same completeness gate as a service location); omit the whole object to
 * convert against the address already on the lead.
 */
export interface ConvertLeadAddress {
  street1: string;
  city: string;
  state: string;
  postalCode: string;
  street2?: string;
  country?: string;
  accessNotes?: string;
  label?: string;
}

export interface ConvertLeadResult {
  lead: { id: string; stage?: string; convertedCustomerId?: string };
  customer: { id: string; displayName?: string };
  location: { id: string };
}

/**
 * C4 — convert a lead to a customer. Capture-class (materializes a CRM record
 * from a lead the owner already owns), so the caller gates it behind the U1
 * capture confirm, not a comms/money gate. An already-converted lead 400s with
 * "Lead has already been converted" — surfaced verbatim via `decodeError`.
 */
export async function convertLead(
  client: AuthedFetch,
  leadId: string,
  address?: ConvertLeadAddress,
): Promise<ConvertLeadResult> {
  const res = await client(`/api/leads/${leadId}/convert`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // Empty object is fine — the server converts against the lead's own address.
    body: JSON.stringify(address ?? {}),
  });
  if (!res.ok) throw await decodeError(res);
  return (await res.json()) as ConvertLeadResult;
}

/**
 * C5 — mark a lead lost. Mirrors the reject-reason form: a non-empty `reason`
 * is required (the server rejects an empty string). Capture-class (updates the
 * lead's own stage → 'lost'), so a simple reason confirm, not a comms gate.
 */
export async function markLeadLost(
  client: AuthedFetch,
  leadId: string,
  reason: string,
): Promise<void> {
  const res = await client(`/api/leads/${leadId}/lose`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reason }),
  });
  if (!res.ok) throw await decodeError(res);
}
