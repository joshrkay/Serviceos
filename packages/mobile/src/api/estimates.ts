import type { LineItem } from '../components/LineItemSheet';
import { toServerLineItems } from './lineItems';
import { decodeError } from '../lib/appError';
import type { AuthedFetch } from './me';

export interface CreateEstimateInput {
  jobId: string;
  lineItems: LineItem[];
  discountCents?: number;
  taxRateBps?: number;
  customerMessage?: string;
}

/**
 * Shape of `GET /api/estimates/:id`. The server returns the base estimate
 * record: it carries `jobId` and document `totals` (integer cents) but NOT a
 * `customerId` — estimates only reference the job, which owns the customer.
 * `customer` is included defensively in case an enriched read ever ships it,
 * but the hydration path resolves the customer from the job when it's absent.
 * Money values stay integer cents end to end (never float).
 */
export interface EstimateResponse {
  id: string;
  jobId: string;
  status?: string;
  version: number;
  lineItems: Array<{
    catalogItemId?: string;
    description: string;
    quantity: number;
    unitPriceCents: number;
    totalCents?: number;
  }>;
  totals?: {
    discountCents?: number;
    taxRateBps?: number;
  };
  customerMessage?: string;
  customer?: { id?: string };
}

export async function getEstimate(client: AuthedFetch, id: string): Promise<EstimateResponse> {
  const res = await client(`/api/estimates/${id}`);
  if (!res.ok) throw new Error(`getEstimate: ${res.status}`);
  return (await res.json()) as EstimateResponse;
}

export interface UpdateEstimateInput {
  lineItems: LineItem[];
  discountCents?: number;
  taxRateBps?: number;
  customerMessage?: string;
  /** Optimistic-lock guard: must match the estimate's current `version`. */
  expectedVersion: number;
}

export async function updateEstimate(
  client: AuthedFetch,
  id: string,
  input: UpdateEstimateInput,
): Promise<{ id: string }> {
  const res = await client(`/api/estimates/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      lineItems: toServerLineItems(input.lineItems),
      discountCents: input.discountCents,
      taxRateBps: input.taxRateBps,
      customerMessage: input.customerMessage,
      expectedVersion: input.expectedVersion,
    }),
  });
  if (!res.ok) {
    // Surface the server's reason (e.g. the deposit-paid / accepted edit
    // lock returns a 409 ConflictError) so the caller can show it verbatim.
    let detail = '';
    try {
      const body = (await res.json()) as { message?: string; error?: string };
      detail = body.message || body.error || '';
    } catch {
      // non-JSON body; fall back to the status code below
    }
    throw new Error(detail || `updateEstimate: ${res.status}`);
  }
  return (await res.json()) as { id: string };
}

export async function createEstimate(client: AuthedFetch, input: CreateEstimateInput): Promise<{ id: string }> {
  const res = await client('/api/estimates', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jobId: input.jobId,
      lineItems: toServerLineItems(input.lineItems),
      discountCents: input.discountCents,
      taxRateBps: input.taxRateBps,
      customerMessage: input.customerMessage,
    }),
  });
  if (!res.ok) throw new Error(`createEstimate: ${res.status}`);
  return (await res.json()) as { id: string };
}

export async function sendEstimate(client: AuthedFetch, id: string): Promise<void> {
  const res = await client(`/api/estimates/${id}/send`, { method: 'POST' });
  // Surface the server's reason (e.g. "no contact on file", a state conflict)
  // verbatim so the Send button can show why instead of a bare status code.
  if (!res.ok) throw new Error((await decodeError(res)).message);
}
