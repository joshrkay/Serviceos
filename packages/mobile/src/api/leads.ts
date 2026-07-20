import { decodeError } from '../lib/appError';
import type { AuthedFetch } from './me';

export interface ConvertLeadAddress {
  street1: string;
  street2?: string;
  city: string;
  state: string;
  postalCode: string;
  country?: string;
  accessNotes?: string;
  label?: string;
}

/**
 * POST /api/leads/:id/convert — turn a lead into a customer + service location.
 * The address is optional: when omitted the server uses the lead's own address,
 * but a lead with no complete address 400s `SERVICE_LOCATION_REQUIRED`, so the
 * screen supplies one when the lead's is incomplete. Returns the new customer id
 * (from the `{ lead, customer, location }` result) for navigation.
 */
export async function convertLead(
  client: AuthedFetch,
  id: string,
  address?: ConvertLeadAddress,
): Promise<{ customerId: string }> {
  const res = await client(`/api/leads/${id}/convert`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(address ?? {}),
  });
  if (!res.ok) throw new Error((await decodeError(res)).message);
  const body = (await res.json()) as { customer?: { id?: string } };
  return { customerId: body.customer?.id ?? '' };
}

/**
 * POST /api/leads/:id/lose — mark a lead lost with a required reason (1–500
 * chars), which the server stores as `lostReason` and stages the lead `lost`.
 */
export async function loseLead(client: AuthedFetch, id: string, reason: string): Promise<void> {
  const res = await client(`/api/leads/${id}/lose`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reason }),
  });
  if (!res.ok) throw new Error((await decodeError(res)).message);
}
