import { Invoice, InvoiceStatus } from './invoice';

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
