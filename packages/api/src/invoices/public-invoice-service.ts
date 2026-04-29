import { Invoice, InvoiceRepository } from './invoice';
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
}

export interface PublicInvoiceServiceDeps {
  invoiceRepo: InvoiceRepository;
  jobRepo: JobRepository;
  customerRepo: CustomerRepository;
  settingsRepo: SettingsRepository;
  stripeConfig?: StripeConfig;
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

    const data = (await res.json()) as { id: string; url: string };
    await this.deps.invoiceRepo.update(invoice.tenantId, invoice.id, {
      stripePaymentLinkId: data.id,
      stripePaymentLinkUrl: data.url,
      updatedAt: new Date(),
    });

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

    return {
      id: invoice.id,
      invoiceNumber: invoice.invoiceNumber,
      status: invoice.status,
      customerName: customer?.displayName ?? 'Customer',
      businessName: settings?.businessName ?? 'Service team',
      businessPhone: settings?.businessPhone,
      businessEmail: settings?.businessEmail,
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
    };
  }
}
