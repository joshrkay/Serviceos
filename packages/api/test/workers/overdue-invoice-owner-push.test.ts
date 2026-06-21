import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { createJob, InMemoryJobRepository } from '../../src/jobs/job';
import { InMemoryEstimateRepository } from '../../src/estimates/estimate';
import { InMemoryInvoiceRepository, Invoice, InvoiceStatus } from '../../src/invoices/invoice';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { InMemoryCustomerRepository } from '../../src/customers/customer';
import { createLogger } from '../../src/logging/logger';
import {
  runOverdueInvoiceSweep,
  OverdueInvoiceWorkerDeps,
} from '../../src/workers/overdue-invoice-worker';
import type { DocumentTotals } from '../../src/shared/billing-engine';
import { OwnerNotificationService } from '../../src/notifications/owner-notification-service';
import { InMemoryPushDeliveryProvider } from '../../src/notifications/push-delivery-provider';
import { InMemoryDeviceTokenRepository } from '../../src/push/device-token-service';
import { setOwnerNotifications } from '../../src/notifications/owner-notifications-instance';

const logger = createLogger({ service: 'test', environment: 'test', level: 'error' });
const NOW = new Date('2026-05-14T12:00:00Z');
const PAST = new Date('2026-05-01T00:00:00Z');

const TOTALS: DocumentTotals = {
  subtotalCents: 0,
  discountCents: 0,
  taxRateBps: 0,
  taxableSubtotalCents: 0,
  taxCents: 0,
  totalCents: 12345,
};

function makeInvoice(jobId: string, status: InvoiceStatus, dueDate: Date): Invoice {
  return {
    id: uuidv4(),
    tenantId: 't1',
    jobId,
    invoiceNumber: 'INV-0001',
    status,
    lineItems: [],
    totals: TOTALS,
    amountPaidCents: 0,
    amountDueCents: 12345,
    dueDate,
    createdBy: 'u1',
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

describe('overdue-invoice owner push (U6 invoice_overdue)', () => {
  let jobRepo: InMemoryJobRepository;
  let estimateRepo: InMemoryEstimateRepository;
  let invoiceRepo: InMemoryInvoiceRepository;
  let auditRepo: InMemoryAuditRepository;
  let customerRepo: InMemoryCustomerRepository;
  let provider: InMemoryPushDeliveryProvider;

  beforeEach(async () => {
    jobRepo = new InMemoryJobRepository();
    estimateRepo = new InMemoryEstimateRepository();
    invoiceRepo = new InMemoryInvoiceRepository();
    auditRepo = new InMemoryAuditRepository();
    customerRepo = new InMemoryCustomerRepository();

    const tokenRepo = new InMemoryDeviceTokenRepository();
    await tokenRepo.register({
      tenantId: 't1',
      userId: 'owner-1',
      expoPushToken: 'ExponentPushToken[overdue-owner]',
      platform: 'ios',
    });
    provider = new InMemoryPushDeliveryProvider();
    setOwnerNotifications(
      new OwnerNotificationService({ deviceTokenRepo: tokenRepo, provider }),
    );
  });

  afterEach(() => {
    setOwnerNotifications(undefined);
  });

  function deps(): OverdueInvoiceWorkerDeps {
    return {
      jobRepo,
      estimateRepo,
      invoiceRepo,
      auditRepo,
      customerRepo,
      listTenantIds: async () => ['t1'],
      logger,
      now: () => NOW,
    };
  }

  async function seedOverdue(): Promise<{ jobId: string; invoiceId: string }> {
    const customerId = uuidv4();
    await customerRepo.create({
      id: customerId,
      tenantId: 't1',
      firstName: 'Lee',
      lastName: 'Park',
      displayName: 'Lee Park',
      preferredChannel: 'sms',
      smsConsent: false,
      isArchived: false,
      createdBy: 'u1',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const job = await createJob(
      { tenantId: 't1', customerId, locationId: 'l1', summary: 'Job', createdBy: 'u1' },
      jobRepo,
    );
    const invoice = await invoiceRepo.create(makeInvoice(job.id, 'open', PAST));
    return { jobId: job.id, invoiceId: invoice.id };
  }

  it('fires invoice_overdue on the transition into overdue, with a cents-formatted amount', async () => {
    const { invoiceId } = await seedOverdue();

    await runOverdueInvoiceSweep(deps());

    expect(provider.sent).toHaveLength(1);
    const msg = provider.sent[0];
    expect(msg.data?.type).toBe('invoice_overdue');
    expect(msg.data?.entityId).toBe(invoiceId);
    expect(msg.body).toContain('Lee Park');
    expect(msg.body).toContain('$123.45');
  });

  it('does not re-push on a second sweep (transition-guard idempotency)', async () => {
    await seedOverdue();

    await runOverdueInvoiceSweep(deps());
    await runOverdueInvoiceSweep(deps());

    expect(provider.sent).toHaveLength(1);
  });

  it('skips the push when no customerRepo is wired (sweep unaffected)', async () => {
    await seedOverdue();

    const result = await runOverdueInvoiceSweep({
      jobRepo,
      estimateRepo,
      invoiceRepo,
      auditRepo,
      // customerRepo omitted → no owner push.
      listTenantIds: async () => ['t1'],
      logger,
      now: () => NOW,
    });

    expect(result.overdue).toBe(1);
    expect(provider.sent).toHaveLength(0);
  });
});
