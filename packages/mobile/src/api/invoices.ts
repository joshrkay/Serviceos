import type { LineItem } from '../components/LineItemSheet';
import type { AuthedFetch } from './me';

export interface CreateInvoiceInput {
  jobId?: string;
  customerId: string;
  lineItems: LineItem[];
}

export async function createInvoice(client: AuthedFetch, input: CreateInvoiceInput): Promise<{ id: string }> {
  const res = await client('/api/invoices', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      customerId: input.customerId,
      jobId: input.jobId,
      lineItems: input.lineItems.map((li) => ({
        description: li.description,
        quantity: li.quantity,
        unitPriceCents: li.unitPriceCents,
        catalogItemId: li.catalogItemId,
      })),
    }),
  });
  if (!res.ok) throw new Error(`createInvoice: ${res.status}`);
  return (await res.json()) as { id: string };
}

export async function sendInvoice(client: AuthedFetch, id: string): Promise<void> {
  const res = await client(`/api/invoices/${id}/send`, { method: 'POST' });
  if (!res.ok) throw new Error(`sendInvoice: ${res.status}`);
}
