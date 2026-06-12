import { createHash } from 'crypto';
import type { Invoice } from '../../invoices/invoice';
import type { Customer } from '../../customers/customer';

function stableStringify(value: unknown): string {
  return JSON.stringify(value);
}

/** Dedup key for invoice pushes — changes when totals/lines change. */
export function hashInvoicePayload(invoice: Invoice): string {
  const canonical = {
    id: invoice.id,
    status: invoice.status,
    totalCents: invoice.totals.totalCents,
    amountPaidCents: invoice.amountPaidCents,
    lineItems: invoice.lineItems.map((li) => ({
      description: li.description,
      quantity: li.quantity,
      unitPriceCents: li.unitPriceCents,
    })),
  };
  return createHash('sha256').update(stableStringify(canonical)).digest('hex');
}

export function hashCustomerPayload(customer: Customer): string {
  const canonical = {
    id: customer.id,
    displayName: customer.displayName,
    email: customer.email ?? null,
    primaryPhone: customer.primaryPhone ?? null,
  };
  return createHash('sha256').update(stableStringify(canonical)).digest('hex');
}
