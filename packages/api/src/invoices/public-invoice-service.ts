import type { AttachPaymentLinkResult, Invoice, InvoiceRepository } from './invoice';
import type { PaymentLinkProvider } from '../payments/payment-link-provider';
import { PaymentRepository } from './payment';
import { CustomerRepository } from '../customers/customer';
import { JobRepository } from '../jobs/job';
import { SettingsRepository, TenantSettings } from '../settings/settings';
import { ValidationError, NotFoundError } from '../shared/errors';
import { AuditRepository, createAuditEvent } from '../audit/audit';
import { publicActorFromToken } from '../feedback/feedback-response';
import { timedFetch } from '../shared/timed-fetch';
import type { CatalogUnitValue } from '@ai-service-os/shared';
import { retireCheckoutLink } from './invoice-payment-link';
import {
  auditPaymentModeUnavailable,
  CollectOnSiteError,
  PaymentModeUnavailableError,
  readPaymentCollectionMode,
  type PaymentCollectionModeView,
} from './payment-collection-mode';

export interface StripeConfig {
  apiKey: string;
}

export interface PublicInvoiceView {
  id: string;
  invoiceNumber: string;
  status: Invoice['status'];
  customerName: string;
  businessName: string;
  businessPhone?: string;
  businessEmail?: string;
  /** #1402 §13 — tenant mailing address, newline-separated; printed under the name. */
  businessAddress?: string;
  lineItems: Array<{
    description: string;
    quantity: number;
    /**
     * B7.5 — descriptive unit of measure ('each' | 'hour' | 'sq ft' | ...)
     * so the customer can tell what the quantity and rate measure ("2 hour"
     * vs "2 each"). Absent on legacy lines and any path that states no unit.
     * DESCRIPTIVE ONLY: no total on this view is derived from it — the money
     * stays quantity × unitPriceCents in integer cents.
     */
    unit?: CatalogUnitValue;
    unitPriceCents: number;
    totalCents: number;
  }>;
  totalCents: number;
  subtotalCents: number;
  taxCents: number;
  discountCents: number;
  /** Processing-fee surcharge folded into totalCents/amountDueCents (0 if none). */
  processingFeeCents: number;
  amountPaidCents: number;
  amountDueCents: number;
  dueDate?: string;
  customerMessage?: string;
  isPaid: boolean;
  viewCount: number;
  /**
   * Stripe-hosted checkout URL, populated once the customer requests checkout.
   * S5a-1 (U8): present only when `paymentCollectionMode` is `pay_link`.
   */
  stripePaymentLinkUrl?: string;
  /**
   * S5a-1 (U8) — the payment policy the page must honour: `pay_link` renders
   * the payment form; `collect_on_site` renders the in-person note; and
   * `unavailable` (the policy could not be read) renders no payment at all —
   * the API already made the fail-closed decision, the page only shows it.
   */
  paymentCollectionMode: PaymentCollectionModeView;
  /**
   * Tier 4 (Deposit rules — PR 3c). Total deposit credit applied to
   * this invoice (in cents). Surfaced so the customer page can render
   * a "Deposit credit -$X" line and the math reconciles. 0 when no
   * deposit was credited (job had no deposit, or this isn't the first
   * invoice for the job).
   */
  depositCreditCents: number;
}

/**
 * Tier 4 (Payment methods — PR 2). Resolves the connected Stripe
 * Account id to route the tenant's customer payment through. When
 * the tenant hasn't onboarded yet, returns null and the service
 * falls back to a platform-level charge (legacy ServiceOS-Stripe
 * path). Implementations can hit Pg directly or pull from a service
 * cache; the service stays decoupled.
 */
export interface ConnectAccountResolver {
  resolveTenantConnectAccount(tenantId: string): Promise<{
    accountId: string;
    chargesEnabled: boolean;
  } | null>;
}

const boundedStripeFetch: typeof fetch = timedFetch();

export interface PublicInvoiceServiceDeps {
  /**
   * QA-2026-06-05 (PORT-02): dev-grade fallback. When Stripe isn't
   * configured (no STRIPE_SECRET_KEY) the checkout leg used to 400 —
   * route through the PaymentLinkProvider abstraction instead, which is
   * the mock on dev and Stripe-backed in prod. The direct Stripe +
   * Connect-account path below remains primary whenever apiKey exists.
   */
  paymentLinkProvider?: PaymentLinkProvider;
  invoiceRepo: InvoiceRepository;
  jobRepo: JobRepository;
  customerRepo: CustomerRepository;
  settingsRepo: SettingsRepository;
  stripeConfig?: StripeConfig;
  /**
   * Tier 4 (Deposit rules — PR 3c). Optional: when wired, the public
   * view sums up payments with providerReference='deposit_credit' to
   * surface depositCreditCents. Without it the field reads as 0.
   */
  paymentRepo?: PaymentRepository;
  /**
   * Tier 4 (Payment methods — PR 2). When wired, customer-facing
   * Payment Links are minted via the tenant's Connect Account
   * (Stripe-Account header) so funds flow directly to the tenant's
   * bank. Falls back to platform charge when the resolver returns
   * null (tenant hasn't onboarded yet) or the account isn't
   * charges-enabled. Optional so legacy harnesses don't need it.
   */
  connectAccountResolver?: ConnectAccountResolver;
  /** Override-able fetch for unit tests. Defaults to the global fetch
   *  bounded at 10 s (see shared/timed-fetch). */
  stripeFetch?: typeof fetch;
  /**
   * D2-1d — audit logging for the first-mint checkout link creation.
   * Optional so older harnesses still build. Subsequent calls that
   * return the cached URL DO NOT re-emit the event.
   */
  auditRepo?: AuditRepository;
}

export class PublicInvoiceService {
  constructor(private readonly deps: PublicInvoiceServiceDeps) {}

  /**
   * A loser link from a lost mint-guard is still LIVE at Stripe and its id
   * exists nowhere else (it was never persisted) — when its cleanup ALSO
   * fails, the id must land on the audit trail so an operator can
   * deactivate it manually. Best-effort: never blocks the caller.
   */
  private async auditLoserLinkCleanupFailure(
    invoice: Invoice,
    linkId: string,
    err: unknown,
  ): Promise<void> {
    if (!this.deps.auditRepo) return;
    await this.deps.auditRepo
      .create(
        createAuditEvent({
          tenantId: invoice.tenantId,
          actorId: 'system',
          actorRole: 'system',
          eventType: 'invoice.payment_link_deactivation_failed',
          entityType: 'invoice',
          entityId: invoice.id,
          metadata: {
            stripePaymentLinkId: linkId,
            reason: 'mint_guard_lost',
            error: err instanceof Error ? err.message : String(err),
          },
        }),
      )
      .catch(() => undefined);
  }

  /**
   * S5a-4 (U8) — the direct-Stripe path's version of `retireCheckoutLink`:
   * that path mints with a raw fetch and has no provider, so it keeps its
   * own deactivation call (same Stripe-Account scope as the mint) and here
   * emits the same audit events with the same reason, and on success runs
   * the CAS clear so an attach whose acknowledgement was lost never leaves a
   * dead link stored. Best-effort: never throws.
   */
  private async auditLinkDeactivation(
    invoice: Invoice,
    linkId: string,
    deactivated: boolean,
  ): Promise<void> {
    if (deactivated) {
      await this.deps.invoiceRepo.clearPaymentLinkIfMatches?.(invoice.tenantId, invoice.id, linkId).catch(() => false);
    }
    if (!this.deps.auditRepo) return;
    await this.deps.auditRepo
      .create(
        createAuditEvent({
          tenantId: invoice.tenantId,
          actorId: 'system',
          actorRole: 'system',
          eventType: deactivated ? 'invoice.payment_link_deactivated' : 'invoice.payment_link_deactivation_failed',
          entityType: 'invoice',
          entityId: invoice.id,
          metadata: {
            stripePaymentLinkId: linkId,
            reason: 'payment_mode_changed_during_checkout',
            ...(deactivated ? {} : { error: 'Stripe deactivation failed for a link minted across a payment-mode change' }),
          },
        }),
      )
      .catch(() => undefined);
  }

  /** S5a-4 — an attach that threw is an unreadable mode: audit it and answer 503. */
  private async failClosedOnUnreadableAttach(invoice: Invoice, error: unknown): Promise<never> {
    await auditPaymentModeUnavailable(this.deps.auditRepo, {
      tenantId: invoice.tenantId,
      invoiceId: invoice.id,
      surface: 'checkout',
      error,
    });
    throw new PaymentModeUnavailableError();
  }

  async getByToken(token: string): Promise<PublicInvoiceView> {
    const invoice = await this.lookupByToken(token);
    return this.toView(invoice);
  }

  async recordView(token: string): Promise<{ recorded: boolean }> {
    const invoice = await this.lookupByToken(token);
    // Use atomic increment when available (avoids lost-update race when two
    // requests arrive simultaneously). Falls back to read-modify-write for
    // the InMemory repo used in tests.
    if (this.deps.invoiceRepo.incrementViewCount) {
      await this.deps.invoiceRepo.incrementViewCount(invoice.tenantId, invoice.id);
    } else {
      const now = new Date();
      await this.deps.invoiceRepo.update(invoice.tenantId, invoice.id, {
        firstViewedAt: invoice.firstViewedAt ?? now,
        viewCount: (invoice.viewCount ?? 0) + 1,
        updatedAt: now,
      });
    }
    return { recorded: true };
  }

  /**
   * Returns the Stripe Payment Link URL for this invoice, creating one if it
   * doesn't already exist. Idempotent: a second call returns the stored URL.
   */
  async getOrCreateCheckoutUrl(token: string): Promise<{ url: string }> {
    const invoice = await this.lookupByToken(token);

    // S5a-1 (U8) — policy before state, and before the stored-URL early
    // return: a collect-on-site tenant serves no link even while the switch
    // cleanup (S5a-5) has not yet retired a stored one, and an unreadable
    // policy is a retryable 503, never a mint.
    const mode = await readPaymentCollectionMode(this.deps.settingsRepo, invoice.tenantId);
    if (!mode.ok) {
      await auditPaymentModeUnavailable(this.deps.auditRepo, {
        tenantId: invoice.tenantId,
        invoiceId: invoice.id,
        surface: 'checkout',
        error: mode.error,
      });
      throw new PaymentModeUnavailableError();
    }
    if (mode.mode === 'collect_on_site') {
      throw new CollectOnSiteError();
    }

    if (!this.deps.stripeConfig?.apiKey && !this.deps.paymentLinkProvider) {
      throw new ValidationError('Payment processing is not configured');
    }

    const PAYABLE = ['open', 'partially_paid'];
    if (!PAYABLE.includes(invoice.status)) {
      throw new ValidationError(
        `Invoice cannot be paid from status: ${invoice.status}`
      );
    }

    if (invoice.amountDueCents <= 0) {
      throw new ValidationError('Invoice has no outstanding balance');
    }

    // Return existing link if already created.
    if (invoice.stripePaymentLinkUrl) {
      return { url: invoice.stripePaymentLinkUrl };
    }

    // Provider fallback (no direct Stripe key): mint via the abstraction —
    // mock URLs on dev, Stripe-backed where the provider is configured.
    if (!this.deps.stripeConfig?.apiKey && this.deps.paymentLinkProvider) {
      const link = await this.deps.paymentLinkProvider.generateLink({
        tenantId: invoice.tenantId,
        invoiceId: invoice.id,
        amountCents: invoice.amountDueCents,
        currency: 'usd',
        description: `Invoice ${invoice.invoiceNumber}`,
      });
      // P0-9 (mint leg) — persist only while the invoice still prices this
      // link; a void/credit landing during the mint wins and the fresh link
      // is deactivated instead of attached (see attachPaymentLink). S5a-4 —
      // and only while the mode is still pay_link: a switch to collect on
      // site during the mint (or an unreadable mode) retires the link.
      const provider = this.deps.paymentLinkProvider;
      const retire = () =>
        retireCheckoutLink({
          tenantId: invoice.tenantId,
          invoice,
          linkId: link.linkId,
          invoiceRepo: this.deps.invoiceRepo,
          provider,
          connectAccountResolver: this.deps.connectAccountResolver,
          auditRepo: this.deps.auditRepo,
        });
      let attached: AttachPaymentLinkResult;
      try {
        attached = await this.deps.invoiceRepo.attachPaymentLink(
          invoice.tenantId,
          invoice.id,
          { linkId: link.linkId, linkUrl: link.linkUrl },
          invoice.amountDueCents,
          new Date(),
        );
      } catch (error) {
        await retire();
        return await this.failClosedOnUnreadableAttach(invoice, error);
      }
      if (!attached.ok && attached.reason === 'mode_not_pay_link') {
        await retire();
        throw new CollectOnSiteError();
      }
      if (!attached.ok) {
        try {
          await provider.deactivateLink(link.linkId);
        } catch (err) {
          await this.auditLoserLinkCleanupFailure(invoice, link.linkId, err);
        }
        const fresh = await this.deps.invoiceRepo.findById(invoice.tenantId, invoice.id);
        if (fresh && PAYABLE.includes(fresh.status) && fresh.stripePaymentLinkUrl) {
          return { url: fresh.stripePaymentLinkUrl };
        }
        throw new ValidationError(
          'Invoice changed while the payment link was being created — refresh and retry',
        );
      }
      return { url: link.linkUrl };
    }

    const job = await this.deps.jobRepo.findById(invoice.tenantId, invoice.jobId);
    const customer = job
      ? await this.deps.customerRepo.findById(invoice.tenantId, job.customerId)
      : null;

    const description = `Invoice ${invoice.invoiceNumber}${customer ? ` — ${customer.displayName}` : ''}`;

    // Tier 4 (Payment methods — PR 2). When the tenant has an active
    // Connect Account with charges enabled, mint the Payment Link as
    // a Direct Charge against THEIR account — funds flow into their
    // bank, not the ServiceOS platform's. The Stripe-Account header
    // is the only API delta; the rest of the payload is identical.
    //
    // Falls back to platform-level charge when the resolver returns
    // null (tenant hasn't onboarded yet, charges not enabled, or the
    // resolver is unwired). This keeps existing tenants on the path
    // they're already on until they explicitly onboard.
    const connect = this.deps.connectAccountResolver
      ? await this.deps.connectAccountResolver
          .resolveTenantConnectAccount(invoice.tenantId)
          .catch(() => null)
      : null;
    const useConnect = connect && connect.chargesEnabled;

    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.deps.stripeConfig!.apiKey}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    };
    if (useConnect && connect) {
      headers['Stripe-Account'] = connect.accountId;
    }

    const fetchFn = this.deps.stripeFetch ?? boundedStripeFetch;
    const res = await fetchFn('https://api.stripe.com/v1/payment_links', {
      method: 'POST',
      headers,
      body: new URLSearchParams({
        'line_items[0][price_data][currency]': 'usd',
        'line_items[0][price_data][product_data][name]': description,
        'line_items[0][price_data][unit_amount]': String(invoice.amountDueCents),
        'line_items[0][quantity]': '1',
        'metadata[tenant_id]': invoice.tenantId,
        'metadata[invoice_id]': invoice.id,
        // Single completed checkout only (see stripe-payment-link.ts) — prevents
        // a replayed link from double-charging after the invoice is settled.
        'restrictions[completed_sessions][limit]': '1',
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Stripe API error (${res.status}): ${body}`);
    }

    const data = (await res.json()) as { id?: string; url?: string };
    if (!data.id || !data.url) {
      throw new Error('Stripe API returned incomplete payment link (missing id or url)');
    }

    // Best-effort kill for a link that must not survive: persist failed or
    // the payable/balance guard lost. PR 2: when minted via Connect, the
    // deactivation must carry the same Stripe-Account header — Stripe scopes
    // the link to that account.
    const deactivateMintedLink = async (): Promise<boolean> => {
      const deactivateHeaders: Record<string, string> = {
        Authorization: `Bearer ${this.deps.stripeConfig!.apiKey}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      };
      if (useConnect && connect) {
        deactivateHeaders['Stripe-Account'] = connect.accountId;
      }
      try {
        const res = await fetchFn(`https://api.stripe.com/v1/payment_links/${data.id}`, {
          method: 'POST',
          headers: deactivateHeaders,
          body: new URLSearchParams({ active: 'false' }),
        });
        return res.ok;
      } catch {
        return false; // best-effort; callers decide how to surface a miss
      }
    };

    let attached: AttachPaymentLinkResult;
    try {
      // P0-9 (mint leg) — the Stripe mint above is slow; a void, a credit, or
      // a competing mint can land after the payable read at the top. The
      // guarded persist attaches the link only while the invoice still owes
      // exactly what the link charges and carries no other link, and
      // (S5a-4) while the mode, re-read under the payment-mode lock, is
      // still pay_link.
      attached = await this.deps.invoiceRepo.attachPaymentLink(
        invoice.tenantId,
        invoice.id,
        { linkId: data.id, linkUrl: data.url },
        invoice.amountDueCents,
        new Date(),
      );
    } catch (error) {
      // The Stripe link was created but the attach threw: the mode is
      // unreadable, so fail closed. The link dies (audited with its id, so a
      // failed deactivation can still be finished by hand) and the customer
      // gets a retryable 503 — never a stored or served link.
      await this.auditLinkDeactivation(invoice, data.id, await deactivateMintedLink());
      return await this.failClosedOnUnreadableAttach(invoice, error);
    }
    if (!attached.ok && attached.reason === 'mode_not_pay_link') {
      // The owner switched to "Collect on the spot" while Stripe was minting.
      // Not a lost mint race: no "invoice changed", no competing link.
      await this.auditLinkDeactivation(invoice, data.id, await deactivateMintedLink());
      throw new CollectOnSiteError();
    }
    if (!attached.ok) {
      // Guard lost: the invoice was voided, repriced, or another mint won
      // while Stripe was creating this link. The fresh link prices a state
      // that no longer exists — kill it, then either serve the winner's link
      // or surface the change. A cleanup miss is audited: the loser's id is
      // persisted nowhere else, and it is still live at Stripe.
      const cleanedUp = await deactivateMintedLink();
      if (!cleanedUp) {
        await this.auditLoserLinkCleanupFailure(
          invoice,
          data.id,
          new Error('Stripe deactivation failed for mint-guard loser link'),
        );
      }
      const fresh = await this.deps.invoiceRepo.findById(invoice.tenantId, invoice.id);
      if (fresh && PAYABLE.includes(fresh.status) && fresh.stripePaymentLinkUrl) {
        return { url: fresh.stripePaymentLinkUrl };
      }
      throw new ValidationError(
        'Invoice changed while the payment link was being created — refresh and retry',
      );
    }

    if (this.deps.auditRepo) {
      // D2-1d — first-mint only (the early-return above short-circuits
      // when a link already exists, so we never re-emit on idempotent
      // repeats). Token is hashed into the synthetic actor — raw token
      // is never persisted.
      await this.deps.auditRepo.create(
        createAuditEvent({
          tenantId: invoice.tenantId,
          actorId: publicActorFromToken(token),
          actorRole: 'customer',
          eventType: 'public_invoice.checkout_created',
          entityType: 'invoice',
          entityId: invoice.id,
          metadata: {
            invoiceNumber: invoice.invoiceNumber,
            amountDueCents: invoice.amountDueCents,
            stripePaymentLinkId: data.id,
            viaConnect: Boolean(useConnect),
          },
        }),
      );
    }

    return { url: data.url };
  }

  private async lookupByToken(token: string): Promise<Invoice> {
    if (!token || token.length < 16 || token.length > 512) {
      throw new ValidationError('Invalid token');
    }
    if (!this.deps.invoiceRepo.findByViewToken) {
      throw new ValidationError('Token lookup not supported by this repository');
    }
    const found = await this.deps.invoiceRepo.findByViewToken(token);
    if (!found) {
      throw new NotFoundError('Invoice', 'token');
    }
    if (found.viewTokenExpiresAt && found.viewTokenExpiresAt < new Date()) {
      throw new NotFoundError('Invoice', 'token');
    }
    return found;
  }

  private async toView(invoice: Invoice): Promise<PublicInvoiceView> {
    const job = await this.deps.jobRepo.findById(invoice.tenantId, invoice.jobId);
    const customer = job
      ? await this.deps.customerRepo.findById(invoice.tenantId, job.customerId)
      : null;
    // S5a-1 (U8) — one settings read gives the business context AND the
    // payment policy. A read that throws no longer fails the page: the
    // customer still sees their invoice, with no payment facts and
    // `paymentCollectionMode: 'unavailable'`, and the occurrence is audited.
    const modeRead = await readPaymentCollectionMode(this.deps.settingsRepo, invoice.tenantId);
    let paymentCollectionMode: PaymentCollectionModeView;
    let settings: TenantSettings | null;
    if (modeRead.ok) {
      paymentCollectionMode = modeRead.mode;
      settings = modeRead.settings;
    } else {
      paymentCollectionMode = 'unavailable';
      settings = null;
      await auditPaymentModeUnavailable(this.deps.auditRepo, {
        tenantId: invoice.tenantId,
        invoiceId: invoice.id,
        surface: 'public_page',
        error: modeRead.error,
      });
    }

    // Tier 4 (Deposit rules — PR 3c). Sum payments tagged
    // providerReference='deposit_credit' for this invoice. The credit
    // also flows through amountPaidCents (so amountDue is correct
    // without any extra client-side math), but the field surfaced
    // here lets the customer page render an explicit "Deposit credit"
    // row so the math is transparent to the customer.
    let depositCreditCents = 0;
    if (this.deps.paymentRepo) {
      const payments = await this.deps.paymentRepo.findByInvoice(
        invoice.tenantId,
        invoice.id,
      );
      depositCreditCents = payments
        .filter((p) => p.providerReference === 'deposit_credit')
        .reduce((sum, p) => sum + p.amountCents, 0);
    }

    return {
      id: invoice.id,
      invoiceNumber: invoice.invoiceNumber,
      status: invoice.status,
      customerName: customer?.displayName ?? 'Customer',
      businessName: settings?.businessName ?? 'Service team',
      // Codex P2 PR #316: settings types allow null on optional
      // string columns; coalesce to undefined for the wire shape.
      businessPhone: settings?.businessPhone ?? undefined,
      businessEmail: settings?.businessEmail ?? undefined,
      businessAddress: settings?.businessAddress ?? undefined,
      lineItems: invoice.lineItems.map((li) => ({
        description: li.description,
        quantity: li.quantity,
        // B7.5 — carry the descriptive unit to the customer-facing view.
        // `?? undefined` because a persisted row with no unit arrives as
        // null from the row mapper, and the DTO field is optional.
        unit: li.unit ?? undefined,
        unitPriceCents: li.unitPriceCents,
        totalCents: li.totalCents,
      })),
      totalCents: invoice.totals.totalCents,
      subtotalCents: invoice.totals.subtotalCents,
      taxCents: invoice.totals.taxCents,
      discountCents: invoice.totals.discountCents,
      processingFeeCents: invoice.totals.processingFeeCents ?? 0,
      amountPaidCents: invoice.amountPaidCents,
      amountDueCents: invoice.amountDueCents,
      dueDate: invoice.dueDate?.toISOString(),
      customerMessage: invoice.customerMessage,
      isPaid: invoice.status === 'paid' || invoice.amountDueCents <= 0,
      viewCount: invoice.viewCount ?? 0,
      // A leftover link on a collect-on-site (or unreadable) tenant is never
      // shown — the policy holds for old URLs as well as new ones.
      stripePaymentLinkUrl:
        paymentCollectionMode === 'pay_link' ? invoice.stripePaymentLinkUrl : undefined,
      paymentCollectionMode,
      depositCreditCents,
    };
  }
}
