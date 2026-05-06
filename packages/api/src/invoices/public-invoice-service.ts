import { Invoice, InvoiceRepository } from './invoice';
import { PaymentRepository } from './payment';
import { CustomerRepository } from '../customers/customer';
import { JobRepository } from '../jobs/job';
import { SettingsRepository } from '../settings/settings';
import { ValidationError, NotFoundError } from '../shared/errors';

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
  lineItems: Array<{
    description: string;
    quantity: number;
    unitPriceCents: number;
    totalCents: number;
  }>;
  totalCents: number;
  subtotalCents: number;
  taxCents: number;
  discountCents: number;
  amountPaidCents: number;
  amountDueCents: number;
  dueDate?: string;
  customerMessage?: string;
  isPaid: boolean;
  viewCount: number;
  /** Stripe-hosted checkout URL, populated once the customer requests checkout. */
  stripePaymentLinkUrl?: string;
  /**
   * Tier 4 (Deposit rules — PR 3c). Total deposit credit applied to
   * this invoice (in cents). Surfaced so the customer page can render
   * a "Deposit credit -$X" line and the math reconciles. 0 when no
   * deposit was credited (job had no deposit, or this isn't the first
   * invoice for the job).
   */
  depositCreditCents: number;
}

export interface PublicInvoiceServiceDeps {
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
}

export class PublicInvoiceService {
  constructor(private readonly deps: PublicInvoiceServiceDeps) {}

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

    if (!this.deps.stripeConfig?.apiKey) {
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

    const job = await this.deps.jobRepo.findById(invoice.tenantId, invoice.jobId);
    const customer = job
      ? await this.deps.customerRepo.findById(invoice.tenantId, job.customerId)
      : null;

    const description = `Invoice ${invoice.invoiceNumber}${customer ? ` — ${customer.displayName}` : ''}`;

    const res = await fetch('https://api.stripe.com/v1/payment_links', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.deps.stripeConfig.apiKey}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        'line_items[0][price_data][currency]': 'usd',
        'line_items[0][price_data][product_data][name]': description,
        'line_items[0][price_data][unit_amount]': String(invoice.amountDueCents),
        'line_items[0][quantity]': '1',
        'metadata[tenant_id]': invoice.tenantId,
        'metadata[invoice_id]': invoice.id,
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

    try {
      await this.deps.invoiceRepo.update(invoice.tenantId, invoice.id, {
        stripePaymentLinkId: data.id,
        stripePaymentLinkUrl: data.url,
        updatedAt: new Date(),
      });
    } catch (dbErr) {
      // The Stripe link was created but we can't persist the URL. Deactivate
      // it (best-effort) so it isn't an orphaned charge vector, then re-throw.
      // The link ID is included in the error message so it can be recovered
      // manually if deactivation also fails.
      await fetch(`https://api.stripe.com/v1/payment_links/${data.id}`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.deps.stripeConfig!.apiKey}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ active: 'false' }),
      }).catch(() => undefined); // deactivation is best-effort; don't mask the original error

      const msg = dbErr instanceof Error ? dbErr.message : String(dbErr);
      throw new Error(`Failed to persist Stripe payment link ${data.id}: ${msg}`);
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
    const settings = await this.deps.settingsRepo.findByTenant(invoice.tenantId);

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
      lineItems: invoice.lineItems.map((li) => ({
        description: li.description,
        quantity: li.quantity,
        unitPriceCents: li.unitPriceCents,
        totalCents: li.totalCents,
      })),
      totalCents: invoice.totals.totalCents,
      subtotalCents: invoice.totals.subtotalCents,
      taxCents: invoice.totals.taxCents,
      discountCents: invoice.totals.discountCents,
      amountPaidCents: invoice.amountPaidCents,
      amountDueCents: invoice.amountDueCents,
      dueDate: invoice.dueDate?.toISOString(),
      customerMessage: invoice.customerMessage,
      isPaid: invoice.status === 'paid' || invoice.amountDueCents <= 0,
      viewCount: invoice.viewCount ?? 0,
      stripePaymentLinkUrl: invoice.stripePaymentLinkUrl,
      depositCreditCents,
    };
  }
}
