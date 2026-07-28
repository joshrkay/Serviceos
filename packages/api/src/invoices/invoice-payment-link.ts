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

  // P0-9 (mint leg) — the Stripe call above is slow; a void, a credit, or a
  // competing mint can land between the read at the top and this persist.
  // The guarded write only attaches the link while the invoice is still
  // payable at EXACTLY the balance the link was priced at and carries no
  // other link; when it loses, the link we just minted must die (it prices
  // a state that no longer exists) and the caller re-resolves.
  const persisted = await invoiceRepo.setPaymentLinkIfPayable(
    tenantId,
    invoice.id,
    { linkId: link.linkId, linkUrl: link.linkUrl },
    invoice.amountDueCents,
    new Date(),
  );
  if (!persisted) {
    await provider.deactivateLink(link.linkId, stripeAccountId).catch(() => undefined);
    const fresh = await invoiceRepo.findById(tenantId, invoice.id);
    // A competing mint won and the invoice is still payable → serve the
    // winner's link. Anything else → the invoice changed underneath us.
    if (fresh && PAYABLE_STATUSES.has(fresh.status) && fresh.stripePaymentLinkUrl) {
      return { url: fresh.stripePaymentLinkUrl, expiresAt: null };
    }
    throw new ConflictError(
      `Invoice changed while the payment link was being created (status: ${fresh?.status ?? 'missing'})`,
    );
  }

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
  const linkId = invoice.stripePaymentLinkId;
  if (!linkId) return { deactivated: false };

  // A link is scoped to the account it was MINTED under, and nothing persists
  // which account that was — the tenant's Connect state can have changed
  // since (onboarded after a platform mint, or charges later disabled after a
  // Connect mint). Resolving only the CURRENT scope would then fail forever,
  // leaving the stale link live. So try the current resolution first, and on
  // failure fall back to the other scope; Stripe's deactivate is idempotent,
  // so hitting the wrong scope is a clean error, never a double effect.
  const connect = connectAccountResolver
    ? await connectAccountResolver.resolveTenantConnectAccount(tenantId).catch(() => null)
    : null;
  const primaryScope = connect && connect.chargesEnabled ? connect.accountId : undefined;
  const scopes: Array<string | undefined> = [primaryScope];
  if (primaryScope !== undefined) scopes.push(undefined);
  else if (connect?.accountId) scopes.push(connect.accountId);

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

  let lastError: unknown;
  let deactivated = false;
  for (const scope of scopes) {
    try {
      await provider.deactivateLink(linkId, scope);
      deactivated = true;
      break;
    } catch (err) {
      lastError = err;
    }
  }
  if (!deactivated) {
    await emit('invoice.payment_link_deactivation_failed', {
      stripePaymentLinkId: linkId,
      reason,
      error: lastError instanceof Error ? lastError.message : String(lastError),
    });
    return { deactivated: false };
  }

  // Clear ONLY if the column still holds the link we just deactivated. The
  // caller's invoice may be a snapshot from before a concurrent
  // deactivate-and-re-mint; a blind clear would then wipe the NEW link's
  // columns while it stays live at Stripe (exactly the invisible-charge-
  // vector state this helper exists to prevent). Prefer the repo's CAS;
  // fall back to read-compare-clear for repos that don't implement it.
  //
  // A clear FAILURE is NOT cosmetic on a still-payable invoice: the pay-now
  // flows return any stored URL without consulting Stripe, so a surviving
  // column would serve the now-dead link on every subsequent Pay Now until
  // something re-triggers this helper. Surface it as its own actionable
  // audit event (never folded into the success event) so operators can see
  // and retry; the link IS dead at Stripe, so `deactivated` stays true.
  let clearError: unknown;
  try {
    if (invoiceRepo.clearPaymentLinkIfMatches) {
      await invoiceRepo.clearPaymentLinkIfMatches(tenantId, invoice.id, linkId);
    } else {
      const fresh = await invoiceRepo.findById(tenantId, invoice.id);
      if (fresh?.stripePaymentLinkId === linkId) {
        await invoiceRepo.update(tenantId, invoice.id, {
          stripePaymentLinkId: null,
          stripePaymentLinkUrl: null,
          updatedAt: new Date(),
        });
      }
    }
  } catch (err) {
    clearError = err;
  }

  if (clearError !== undefined) {
    await emit('invoice.payment_link_clear_failed', {
      stripePaymentLinkId: linkId,
      reason,
      error: clearError instanceof Error ? clearError.message : String(clearError),
    });
  } else {
    await emit('invoice.payment_link_deactivated', {
      stripePaymentLinkId: linkId,
      reason,
    });
  }
  return { deactivated: true };
}
