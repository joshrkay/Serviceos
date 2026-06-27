import type { LineItem } from '../components/LineItemSheet';
import { toServerLineItems } from './lineItems';
import type { AuthedFetch } from './me';

export interface CreateEstimateInput {
  jobId: string;
  lineItems: LineItem[];
  discountCents?: number;
  taxRateBps?: number;
  customerMessage?: string;
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
  if (!res.ok) throw new Error(`sendEstimate: ${res.status}`);
}
