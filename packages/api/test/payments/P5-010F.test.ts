import { processStripePaymentEvent, InvoiceUpdateResult } from '../../src/payments/stripe-invoice-updater';
import { StripeWebhookResult } from '../../src/payments/stripe-webhook-handler';
import { InMemoryInvoiceRepository, Invoice } from '../../src/invoices/invoice';
import { InMemoryPaymentRepository } from '../../src/invoices/payment';
import { buildLineItem } from '../../src/shared/billing-engine';
import { calculateDocumentTotals } from '../../src/shared/billing-engine';

describe('P5-010F: Invoice state updates from Stripe payments', () => {
  let invoiceRepo: InMemoryInvoiceRepository;
  let paymentRepo: InMemoryPaymentRepository;
  const tenantId = 'tenant-1';

  function makeInvoice(overrides: Partial<Invoice> = {}): Invoice {
    const lineItems = [buildLineItem('li-1', 'Service', 1, 10000, 1, false)];
    const totals = calculateDocumentTotals(lineItems, 0, 0);
    return {
      id: 'inv-001',
      tenantId,
      jobId: 'job-001',
      invoiceNumber: 'INV-001',
      status: 'open',
      lineItems,
      totals,
      amountPaidCents: 0,
      amountDueCents: totals.totalCents,
      createdBy: 'user-1',
      createdAt: new Date(),
      updatedAt: new Date(),
      ...overrides,
    };
  }

  function makeEvent(overrides: Partial<StripeWebhookResult> = {}): StripeWebhookResult {
    return {
      eventId: 'evt-001',
      eventType: 'payment_intent.succeeded',
      invoiceId: 'inv-001',
      amountCents: 10000,
      currency: 'usd',
      paymentIntentId: 'pi_abc123',
      duplicate: false,
      ...overrides,
    };
  }

  beforeEach(async () => {
    invoiceRepo = new InMemoryInvoiceRepository();
    paymentRepo = new InMemoryPaymentRepository();
    await invoiceRepo.create(makeInvoice());
  });

  describe('Happy path: successful payment updates invoice to paid', () => {
    it('should update invoice status to paid when full amount is received', async () => {
      const event = makeEvent({ amountCents: 10000 });
      const result = await processStripePaymentEvent(event, invoiceRepo, paymentRepo, tenantId);

      expect(result.success).toBe(true);
      expect(result.invoiceId).toBe('inv-001');
      expect(result.newStatus).toBe('paid');
    });

    it('should work with checkout.session.completed event type', async () => {
      const event = makeEvent({ eventType: 'checkout.session.completed', amountCents: 10000 });
      const result = await processStripePaymentEvent(event, invoiceRepo, paymentRepo, tenantId);

      expect(result.success).toBe(true);
      expect(result.newStatus).toBe('paid');
    });
  });

  describe('Partial payment: invoice stays partially_paid', () => {
    it('should update invoice to partially_paid when partial amount is received', async () => {
      const event = makeEvent({ amountCents: 5000 });
      const result = await processStripePaymentEvent(event, invoiceRepo, paymentRepo, tenantId);

      expect(result.success).toBe(true);
      expect(result.newStatus).toBe('partially_paid');
    });

    it('should update amount due correctly after partial payment', async () => {
      const event = makeEvent({ amountCents: 3000 });
      await processStripePaymentEvent(event, invoiceRepo, paymentRepo, tenantId);

      const invoice = await invoiceRepo.findById(tenantId, 'inv-001');
      expect(invoice!.amountDueCents).toBe(7000);
      expect(invoice!.amountPaidCents).toBe(3000);
    });
  });

  describe('Tenant isolation: wrong tenant returns error', () => {
    it('should return error when invoice not found for different tenant', async () => {
      const event = makeEvent();
      const result = await processStripePaymentEvent(event, invoiceRepo, paymentRepo, 'tenant-other');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Invoice not found');
    });
  });

  describe('Zero amount: rejected', () => {
    it('should reject event with zero amount', async () => {
      const event = makeEvent({ amountCents: 0 });
      const result = await processStripePaymentEvent(event, invoiceRepo, paymentRepo, tenantId);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Invalid amount');
    });

    it('should reject event with negative amount', async () => {
      const event = makeEvent({ amountCents: -100 });
      const result = await processStripePaymentEvent(event, invoiceRepo, paymentRepo, tenantId);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Invalid amount');
    });
  });

  describe('Invalid event type: returns error', () => {
    it('should return error for payment_intent.payment_failed', async () => {
      const event = makeEvent({ eventType: 'payment_intent.payment_failed' });
      const result = await processStripePaymentEvent(event, invoiceRepo, paymentRepo, tenantId);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Unhandled event type');
    });
  });

  describe('Missing invoiceId: returns error', () => {
    it('should return error when event has no invoiceId', async () => {
      const event = makeEvent({ invoiceId: undefined });
      const result = await processStripePaymentEvent(event, invoiceRepo, paymentRepo, tenantId);

      expect(result.success).toBe(false);
      expect(result.error).toBe('No invoiceId in event');
    });
  });

  describe('Rounding: payment capped at amountDue', () => {
    it('should cap payment at amountDue when event amount exceeds it', async () => {
      const event = makeEvent({ amountCents: 15000 }); // exceeds 10000 due
      const result = await processStripePaymentEvent(event, invoiceRepo, paymentRepo, tenantId);

      expect(result.success).toBe(true);
      expect(result.newStatus).toBe('paid');

      const invoice = await invoiceRepo.findById(tenantId, 'inv-001');
      expect(invoice!.amountDueCents).toBe(0);
      expect(invoice!.amountPaidCents).toBe(10000);
    });
  });
});
