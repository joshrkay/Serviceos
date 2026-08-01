import type { LineItem } from '../components/LineItemSheet';
import { decodeError } from '../lib/appError';
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

/**
 * A2 — issue a draft invoice (draft → open). The server stamps `issued_at` and
 * `due_at` (= issued_at + `paymentTermDays`, tenant-tz aware) and starts the
 * dunning clock. `paymentTermDays` is an integer 0–365; omit it to take the
 * server default (30). The route validates the term manually (no Zod schema),
 * so out-of-range values 400 server-side — we surface the decoded reason.
 */
export async function issueInvoice(
  client: AuthedFetch,
  id: string,
  paymentTermDays?: number,
): Promise<void> {
  const res = await client(`/api/invoices/${id}/issue`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(paymentTermDays === undefined ? {} : { paymentTermDays }),
  });
  if (!res.ok) throw await decodeError(res);
}

export async function sendInvoice(client: AuthedFetch, id: string): Promise<void> {
  const res = await client(`/api/invoices/${id}/send`, { method: 'POST' });
  if (!res.ok) throw new Error(`sendInvoice: ${res.status}`);
}
