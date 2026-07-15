import { ConflictError, NotFoundError, ValidationError } from '../shared/errors';
import { PaymentLinkProvider } from '../payments/payment-link-provider';
import { ConnectAccountResolver } from './public-invoice-service';
import { Invoice, InvoiceRepository } from './invoice';

const PAYABLE_STATUSES = new Set(['open', 'partially_paid']);

export interface InvoicePaymentLinkResult {
  url: string;
  expiresAt: string | null;
}

/**
 * INV-04 — mint or return a hosted checkout link for an invoice.
 * When Connect charges are enabled, the link is a direct charge on the
 * tenant's Express account (same routing as public invoice checkout).
 */
export async function createInvoicePaymentLink(
  tenantId: string,
  invoiceId: string,
  invoiceRepo: InvoiceRepository,
  provider: PaymentLinkProvider,
  connectAccountResolver?: ConnectAccountResolver,
): Promise<InvoicePaymentLinkResult> {
  const invoice = await invoiceRepo.findById(tenantId, invoiceId);
  if (!invoice) {
    throw new NotFoundError('Invoice', invoiceId);
  }

  if (!PAYABLE_STATUSES.has(invoice.status)) {
    throw new ConflictError(
      `Payment link only available for open or partially_paid invoices (status: ${invoice.status})`,
    );
  }

  if (invoice.amountDueCents <= 0) {
    throw new ValidationError('Invoice has no outstanding balance');
  }

  if (invoice.stripePaymentLinkUrl) {
    return {
      url: invoice.stripePaymentLinkUrl,
      expiresAt: null,
    };
  }

  const connect = connectAccountResolver
    ? await connectAccountResolver.resolveTenantConnectAccount(tenantId).catch(() => null)
    : null;
  const stripeAccountId =
    connect && connect.chargesEnabled ? connect.accountId : undefined;

  const link = await provider.generateLink({
    tenantId,
    invoiceId: invoice.id,
    amountCents: invoice.amountDueCents,
    currency: 'usd',
    description: `Invoice ${invoice.invoiceNumber}`,
    metadata: { tenant_id: tenantId, invoice_id: invoice.id },
    ...(stripeAccountId ? { stripeAccountId } : {}),
  });

  await invoiceRepo.update(tenantId, invoice.id, {
    stripePaymentLinkId: link.linkId,
    stripePaymentLinkUrl: link.linkUrl,
    updatedAt: new Date(),
  });

  return {
    url: link.linkUrl,
    expiresAt: link.expiresAt ? link.expiresAt.toISOString() : null,
  };
}

export function isPayableInvoice(invoice: Invoice): boolean {
  return PAYABLE_STATUSES.has(invoice.status) && invoice.amountDueCents > 0;
}
