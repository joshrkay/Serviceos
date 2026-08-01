/**
 * FIN (Jobber parity) — consumer financing web client.
 *
 * Talks to /api/financing: offer financing on an invoice and read offers.
 */
import { apiFetch } from '../utils/api-fetch';

export type FinancingStatus =
  | 'offered'
  | 'prequalified'
  | 'approved'
  | 'declined'
  | 'funded'
  | 'expired'
  | 'canceled';

export interface FinancingApplication {
  id: string;
  tenantId: string;
  invoiceId: string;
  customerId: string | null;
  amountCents: number;
  provider: 'wisetack' | 'manual';
  externalId: string | null;
  applicationUrl: string | null;
  status: FinancingStatus;
  statusReason: string | null;
  createdAt: string;
  updatedAt: string;
}

async function readJsonOrThrow<T>(res: Response, action: string): Promise<T> {
  if (!res.ok) {
    const json = (await res.json().catch(() => ({}))) as { message?: string };
    throw new Error(json?.message ?? `Failed to ${action}: ${res.status}`);
  }
  return (await res.json()) as T;
}

export async function listFinancing(invoiceId: string): Promise<FinancingApplication[]> {
  const res = await apiFetch(`/api/financing/invoices/${encodeURIComponent(invoiceId)}`);
  const data = await readJsonOrThrow<unknown>(res, 'load financing');
  return Array.isArray(data) ? (data as FinancingApplication[]) : [];
}

export async function offerFinancing(
  invoiceId: string,
  body: { amountCents?: number } = {},
): Promise<FinancingApplication> {
  const res = await apiFetch(`/api/financing/invoices/${encodeURIComponent(invoiceId)}/offer`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
  return readJsonOrThrow<FinancingApplication>(res, 'offer financing');
}
