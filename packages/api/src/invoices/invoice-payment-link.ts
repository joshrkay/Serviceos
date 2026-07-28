import { ConflictError, NotFoundError, ValidationError } from '../shared/errors';
import { PaymentLinkProvider } from '../payments/payment-link-provider';
import { AuditRepository, createAuditEvent } from '../audit/audit';
// Type-only: `invoice.ts` calls back into this module at runtime
// (transitionInvoiceStatus → deactivateInvoicePaymentLink), so a value
// import from './invoice' here would create a require cycle.
import type { ConnectAccountResolver } from './public-invoice-service';
import type { Invoice, InvoiceRepository } from './invoice';

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

/**
 * P0-1 / P0-9 — kill an invoice's hosted payment link so it can no longer
 * capture money. Called when the invoice leaves the payable world (void /
 * cancel) and when it settles in full: a link is priced at mint time and
 * never re-priced, so any live link on a non-payable or zero-due invoice is
 * a stale charge vector — the customer pays it, Stripe captures, and the
 * webhook can only refuse the credit.
 *
 * Best-effort but never silent: on success the link columns are cleared and
 * an `invoice.payment_link_deactivated` audit event is emitted; on a Stripe
 * failure the columns are KEPT (a cleared column with a live link would hide
 * the exposure) and an `invoice.payment_link_deactivation_failed` event is
 * emitted instead. Never throws — the caller's transition/settlement must
 * not be blocked.
 */
export async function deactivateInvoicePaymentLink(params: {
  tenantId: string;
  invoice: Invoice;
  /**
   * voided/canceled — the invoice left the payable world (P0-1);
   * settled — the balance reached zero;
   * repriced — a credit changed the balance the link was priced against
   * (P0-9): the link's mint-time amount no longer matches what is owed, so
   * letting it live invites a capture whose excess has nowhere to go. A
   * fresh link at the current balance is minted on demand by the pay-now
   * flows once the columns are cleared.
   */
  reason: 'voided' | 'canceled' | 'settled' | 'repriced';
  invoiceRepo: InvoiceRepository;
  provider: PaymentLinkProvider;
  connectAccountResolver?: ConnectAccountResolver;
  auditRepo?: AuditRepository;
  actor?: { actorId: string; actorRole: string };
}): Promise<{ deactivated: boolean }> {
  const { tenantId, invoice, reason, invoiceRepo, provider, connectAccountResolver, auditRepo, actor } = params;
  if (!invoice.stripePaymentLinkId) return { deactivated: false };

  // Same Connect resolution the mint used: a direct-charge link is scoped to
  // the tenant's account and can only be deactivated with that header.
  const connect = connectAccountResolver
    ? await connectAccountResolver.resolveTenantConnectAccount(tenantId).catch(() => null)
    : null;
  const stripeAccountId = connect && connect.chargesEnabled ? connect.accountId : undefined;

  const emit = async (eventType: string, metadata: Record<string, unknown>) => {
    if (!auditRepo) return;
    await auditRepo
      .create(
        createAuditEvent({
          tenantId,
          actorId: actor?.actorId ?? 'system',
          actorRole: actor?.actorRole ?? 'system',
          eventType,
          entityType: 'invoice',
          entityId: invoice.id,
          metadata,
        }),
      )
      .catch(() => undefined);
  };

  try {
    await provider.deactivateLink(invoice.stripePaymentLinkId, stripeAccountId);
  } catch (err) {
    await emit('invoice.payment_link_deactivation_failed', {
      stripePaymentLinkId: invoice.stripePaymentLinkId,
      reason,
      error: err instanceof Error ? err.message : String(err),
    });
    return { deactivated: false };
  }

  await invoiceRepo
    .update(tenantId, invoice.id, {
      stripePaymentLinkId: null,
      stripePaymentLinkUrl: null,
      updatedAt: new Date(),
    })
    .catch(() => undefined); // the link is dead at Stripe — the stale column is cosmetic
  await emit('invoice.payment_link_deactivated', {
    stripePaymentLinkId: invoice.stripePaymentLinkId,
    reason,
  });
  return { deactivated: true };
}
