import { v4 as uuidv4 } from 'uuid';
import { Invoice, InvoiceStatus } from './invoice';

export type PaymentLinkStatus = 'none' | 'pending' | 'active' | 'expired';

export interface PaymentReadiness {
  id: string;
  tenantId: string;
  invoiceId: string;
  eligibleForPaymentLink: boolean;
  paymentLinkStatus: PaymentLinkStatus;
  paymentLinkId?: string;
  paymentLinkUrl?: string;
  paymentLinkCreatedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface PaymentReadinessRepository {
  create(readiness: PaymentReadiness): Promise<PaymentReadiness>;
  findByInvoice(tenantId: string, invoiceId: string): Promise<PaymentReadiness | null>;
  update(tenantId: string, invoiceId: string, updates: Partial<PaymentReadiness>): Promise<PaymentReadiness | null>;
}

const ELIGIBLE_STATUSES: InvoiceStatus[] = ['open', 'partially_paid'];

export function assessPaymentReadiness(invoice: Invoice): { eligible: boolean; reasons: string[] } {
  const reasons: string[] = [];

  if (!ELIGIBLE_STATUSES.includes(invoice.status)) {
    reasons.push(`Invoice status '${invoice.status}' is not eligible for payment link`);
  }

  if (invoice.amountDueCents <= 0) {
    reasons.push('No amount due on invoice');
  }

  return {
    eligible: reasons.length === 0,
    reasons,
  };
}

export function validatePaymentReadinessInput(tenantId: string, invoiceId: string): string[] {
  const errors: string[] = [];
  if (!tenantId) errors.push('tenantId is required');
  if (!invoiceId) errors.push('invoiceId is required');
  return errors;
}

export async function createPaymentReadiness(
  tenantId: string,
  invoiceId: string,
  eligible: boolean,
  repository: PaymentReadinessRepository
): Promise<PaymentReadiness> {
  const now = new Date();
  const readiness: PaymentReadiness = {
    id: uuidv4(),
    tenantId,
    invoiceId,
    eligibleForPaymentLink: eligible,
    paymentLinkStatus: 'none',
    createdAt: now,
    updatedAt: now,
  };

  return repository.create(readiness);
}

export class InMemoryPaymentReadinessRepository implements PaymentReadinessRepository {
  private records: Map<string, PaymentReadiness> = new Map();

  async create(readiness: PaymentReadiness): Promise<PaymentReadiness> {
    this.records.set(readiness.invoiceId, { ...readiness });
    return { ...readiness };
  }

  async findByInvoice(tenantId: string, invoiceId: string): Promise<PaymentReadiness | null> {
    const r = this.records.get(invoiceId);
    if (!r || r.tenantId !== tenantId) return null;
    return { ...r };
  }

  async update(tenantId: string, invoiceId: string, updates: Partial<PaymentReadiness>): Promise<PaymentReadiness | null> {
    const r = this.records.get(invoiceId);
    if (!r || r.tenantId !== tenantId) return null;
    const updated = { ...r, ...updates, updatedAt: new Date() };
    this.records.set(invoiceId, updated);
    return { ...updated };
  }
}
