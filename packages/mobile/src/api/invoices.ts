import type { LineItem } from '../components/LineItemSheet';
import { decodeError } from '../lib/appError';
import { toServerLineItems } from './lineItems';
import { decodeError } from '../lib/appError';
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
  // Surface the server's reason verbatim (matches issue/payment-link below).
  if (!res.ok) throw new Error((await decodeError(res)).message);
}

/**
 * POST /api/invoices/:id/issue — transition a draft invoice to `open`, stamping
 * `issuedAt` and a `dueDate` `paymentTermDays` out (server default 30). Only
 * `draft → open` is valid; issuing a non-draft 400s. On failure we surface the
 * server's human message (e.g. the invalid-transition reason) verbatim so the
 * action button can show why, instead of a bare status code.
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
  if (!res.ok) throw new Error((await decodeError(res)).message);
}

/**
 * POST /api/invoices/:id/payment-link — create (or return the existing) Stripe
 * payment link for an `open`/`partially_paid` invoice. Idempotent server-side.
 * A `draft` invoice (or one with no balance) 409/400s — surfaced verbatim.
 */
export async function createInvoicePaymentLink(
  client: AuthedFetch,
  id: string,
): Promise<{ url: string; expiresAt: string | null }> {
  const res = await client(`/api/invoices/${id}/payment-link`, { method: 'POST' });
  if (!res.ok) throw new Error((await decodeError(res)).message);
  return (await res.json()) as { url: string; expiresAt: string | null };
}

export type InvoicePaymentMethod =
  | 'cash'
  | 'check'
  | 'credit_card'
  | 'bank_transfer'
  | 'other';

export interface RecordPaymentInput {
  amountCents: number;
  method: InvoicePaymentMethod;
  providerReference?: string;
  note?: string;
}

/**
 * POST /api/invoices/:id/payment — record a manual (off-Stripe) payment. The
 * server credits atomically and flips the invoice to `paid`/`partially_paid`.
 * Rejects amounts over `amountDueCents` and non-payable statuses (surfaced
 * verbatim). Money is integer cents end to end — no float math on the client.
 */
export async function recordInvoicePayment(
  client: AuthedFetch,
  id: string,
  input: RecordPaymentInput,
): Promise<void> {
  const res = await client(`/api/invoices/${id}/payment`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      amountCents: input.amountCents,
      method: input.method,
      providerReference: input.providerReference,
      note: input.note,
    }),
  });
  if (!res.ok) throw new Error((await decodeError(res)).message);
}
