import { LineItem } from '../shared/billing-engine';

export interface InvoiceProposalPayload {
  customerId: string;
  jobId: string;
  estimateId?: string;
  invoiceNumber?: string;
  lineItems: Array<{
    description: string;
    quantity: number;
    unitPrice: number;
    category?: string;
  }>;
  discountCents?: number;
  taxRateBps?: number;
  customerMessage?: string;
  internalNotes?: string;
}

export function isValidInvoiceProposalPayload(payload: unknown): payload is InvoiceProposalPayload {
  if (!payload || typeof payload !== 'object') return false;
  const p = payload as Record<string, unknown>;
  if (typeof p.customerId !== 'string') return false;
  if (typeof p.jobId !== 'string') return false;
  if (!Array.isArray(p.lineItems) || p.lineItems.length === 0) return false;
  return true;
}
