import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { recordPayment, InMemoryPaymentRepository } from '../../src/invoices/payment';
import {
  createInvoice,
  issueInvoice,
  InMemoryInvoiceRepository,
} from '../../src/invoices/invoice';
import { buildLineItem } from '../../src/shared/billing-engine';
import { OwnerNotificationService } from '../../src/notifications/owner-notification-service';
import { InMemoryPushDeliveryProvider } from '../../src/notifications/push-delivery-provider';
import { InMemoryDeviceTokenRepository } from '../../src/push/device-token-service';
import { setOwnerNotifications } from '../../src/notifications/owner-notifications-instance';
import { setOwnerNotificationNameResolvers } from '../../src/notifications/owner-notification-name-resolver';

const TENANT = 'tenant-pay-1';

describe('payment owner push (U6 payment_received)', () => {
  let invoiceRepo: InMemoryInvoiceRepository;
  let paymentRepo: InMemoryPaymentRepository;
  let provider: InMemoryPushDeliveryProvider;
  let invoiceId: string;

  beforeEach(async () => {
    invoiceRepo = new InMemoryInvoiceRepository();
    paymentRepo = new InMemoryPaymentRepository();

    const invoice = await createInvoice(
      {
        tenantId: TENANT,
        jobId: 'job-1',
        invoiceNumber: 'INV-0001',
        // $100.50 in integer cents — exercises the cents formatter's decimal path.
        lineItems: [buildLineItem('1', 'Service', 1, 10050, 0, false)],
        createdBy: 'u-1',
      },
      invoiceRepo,
    );
    await issueInvoice(TENANT, invoice.id, 30, invoiceRepo);
    invoiceId = invoice.id;

    const tokenRepo = new InMemoryDeviceTokenRepository();
    await tokenRepo.register({
      tenantId: TENANT,
      userId: 'owner-1',
      expoPushToken: 'ExponentPushToken[pay-owner]',
      platform: 'ios',
    });
    provider = new InMemoryPushDeliveryProvider();
    setOwnerNotifications(
      new OwnerNotificationService({ deviceTokenRepo: tokenRepo, provider }),
    );
  });

  afterEach(() => {
    setOwnerNotifications(undefined);
    setOwnerNotificationNameResolvers({});
  });

  it('uses the process-wide name resolver when no explicit resolver is passed', async () => {
    setOwnerNotificationNameResolvers({
      invoiceCustomerName: async (_t, id) => (id === invoiceId ? 'Globally Resolved Co' : undefined),
    });

    await recordPayment(
      { tenantId: TENANT, invoiceId, amountCents: 5000, method: 'cash', processedBy: 'u-1' },
      invoiceRepo,
      paymentRepo,
    );

    expect(provider.sent).toHaveLength(1);
    expect(provider.sent[0].body).toContain('Globally Resolved Co');
    expect(provider.sent[0].body).not.toContain('A customer');
  });

  it('fires payment_received with a cents-formatted amount and the resolved customer name', async () => {
    await recordPayment(
      { tenantId: TENANT, invoiceId, amountCents: 10050, method: 'credit_card', processedBy: 'u-1' },
      invoiceRepo,
      paymentRepo,
      undefined,
      undefined,
      undefined,
      undefined,
      async () => 'Dana Cole',
    );

    expect(provider.sent).toHaveLength(1);
    const msg = provider.sent[0];
    expect(msg.data?.type).toBe('payment_received');
    expect(msg.data?.entityId).toBe(invoiceId);
    expect(msg.body).toContain('Dana Cole');
    // Integer-cents formatting via the shared money formatter — never a float.
    expect(msg.body).toContain('$100.50');
  });

  it('falls back to a generic label when no resolver is wired (still best-effort)', async () => {
    await recordPayment(
      { tenantId: TENANT, invoiceId, amountCents: 5000, method: 'cash', processedBy: 'u-1' },
      invoiceRepo,
      paymentRepo,
    );

    expect(provider.sent).toHaveLength(1);
    expect(provider.sent[0].body).toContain('$50');
    expect(provider.sent[0].body).toContain('A customer');
  });

  it('records the payment even if the resolver throws (push is failure-isolated)', async () => {
    const { payment } = await recordPayment(
      { tenantId: TENANT, invoiceId, amountCents: 5000, method: 'cash', processedBy: 'u-1' },
      invoiceRepo,
      paymentRepo,
      undefined,
      undefined,
      undefined,
      undefined,
      async () => {
        throw new Error('lookup boom');
      },
    );

    expect(payment.amountCents).toBe(5000);
    expect(provider.sent).toHaveLength(0);
  });

  it('does not push when no notifier is registered', async () => {
    setOwnerNotifications(undefined);
    const { payment } = await recordPayment(
      { tenantId: TENANT, invoiceId, amountCents: 5000, method: 'cash', processedBy: 'u-1' },
      invoiceRepo,
      paymentRepo,
    );
    expect(payment.amountCents).toBe(5000);
    expect(provider.sent).toHaveLength(0);
  });
});
