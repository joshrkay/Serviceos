import type { LineItem } from '../components/LineItemSheet';
import { toServerLineItems } from './lineItems';
import type { AuthedFetch } from './me';

export interface CreateInvoiceInput {
  jobId: string;
  lineItems: LineItem[];
  discountCents?: number;
  taxRateBps?: number;
  processingFeeBps?: number;
  customerMessage?: string;
}

export async function createInvoice(client: AuthedFetch, input: CreateInvoiceInput): Promise<{ id: string }> {
  const res = await client('/api/invoices', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jobId: input.jobId,
      lineItems: toServerLineItems(input.lineItems),
      discountCents: input.discountCents,
      taxRateBps: input.taxRateBps,
      processingFeeBps: input.processingFeeBps,
      customerMessage: input.customerMessage,
    }),
  });
  if (!res.ok) throw new Error(`createInvoice: ${res.status}`);
  return (await res.json()) as { id: string };
}

export async function sendInvoice(client: AuthedFetch, id: string): Promise<void> {
  const res = await client(`/api/invoices/${id}/send`, { method: 'POST' });
  if (!res.ok) throw new Error(`sendInvoice: ${res.status}`);
}
