import { draftInvoicePayloadSchema } from '../proposals/contracts';
import { InvoiceProposalPayload } from './invoice-proposal';

export interface ValidationResult {
  valid: boolean;
  payload?: InvoiceProposalPayload;
  errors?: string[];
}

export function validateInvoiceProposal(raw: unknown): ValidationResult {
  if (!raw || typeof raw !== 'object') {
    return { valid: false, errors: ['Input must be a non-null object'] };
  }

  const coerced = coerceNumericFields(raw as Record<string, unknown>);
  const result = draftInvoicePayloadSchema.safeParse(coerced);

  if (!result.success) {
    const errors = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
    return { valid: false, errors };
  }

  return { valid: true, payload: result.data as InvoiceProposalPayload };
}

function coerceNumericFields(raw: Record<string, unknown>): Record<string, unknown> {
  const result = { ...raw };

  if (typeof result.discountCents === 'string') {
    const n = Number(result.discountCents);
    if (!isNaN(n)) result.discountCents = n;
  }
  if (typeof result.taxRateBps === 'string') {
    const n = Number(result.taxRateBps);
    if (!isNaN(n)) result.taxRateBps = n;
  }

  if (Array.isArray(result.lineItems)) {
    result.lineItems = result.lineItems.map((item: unknown) => {
      if (!item || typeof item !== 'object') return item;
      const li = { ...(item as Record<string, unknown>) };
      if (typeof li.quantity === 'string') {
        const n = Number(li.quantity);
        if (!isNaN(n)) li.quantity = n;
      }
      if (typeof li.unitPrice === 'string') {
        const n = Number(li.unitPrice);
        if (!isNaN(n)) li.unitPrice = n;
      }
      return li;
    });
  }

  return result;
}

export { coerceNumericFields };
