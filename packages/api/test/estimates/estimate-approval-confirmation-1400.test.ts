/**
 * #1400 (QA 2026-09-26 §4) — after a customer approved on the public page,
 * nothing confirmed it to them (`public-estimate-service.ts` approve only
 * wrote the audit row). Approval now asks the transactional comms layer to
 * send the customer a confirmation — once, best-effort (a delivery hiccup
 * never fails the customer's already-committed approval).
 */
import { describe, it, expect, vi } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { PublicEstimateService } from '../../src/estimates/public-estimate-service';
import { InMemoryEstimateRepository, type Estimate } from '../../src/estimates/estimate';
import { InMemoryCustomerRepository } from '../../src/customers/customer';
import { InMemoryJobRepository } from '../../src/jobs/job';
import { InMemorySettingsRepository } from '../../src/settings/settings';
import { TransactionalCommsService } from '../../src/notifications/transactional-comms-service';
import { InMemoryDeliveryProvider } from '../../src/notifications/delivery-provider';
import { InMemoryDispatchRepository } from '../../src/notifications/dispatch-repository';
import { InMemoryAppointmentRepository } from '../../src/appointments/appointment';
import { InMemoryInvoiceRepository } from '../../src/invoices/invoice';
import { createLogger } from '../../src/logging/logger';

const TENANT = 'tenant-approve-confirm';
const TOKEN = 'a-very-long-and-unguessable-token-1400';

async function harness() {
  const estimateRepo = new InMemoryEstimateRepository();
  const customerRepo = new InMemoryCustomerRepository();
  const jobRepo = new InMemoryJobRepository();
  const settingsRepo = new InMemorySettingsRepository();
  await settingsRepo.create({
    id: uuidv4(), tenantId: TENANT, businessName: 'Acme HVAC', timezone: 'America/Chicago',
    estimatePrefix: 'EST', invoicePrefix: 'INV',
  } as Parameters<InMemorySettingsRepository['create']>[0]);
  const customer = await customerRepo.create({
    id: uuidv4(), tenantId: TENANT, firstName: 'Sarah', lastName: 'Johnson', displayName: 'Sarah Johnson',
    primaryPhone: '+15555550199', email: 'sarah@example.test', preferredChannel: 'sms', smsConsent: true,
    isArchived: false, createdBy: 'user-1', createdAt: new Date(), updatedAt: new Date(),
  });
  const job = await jobRepo.create({
    id: uuidv4(), tenantId: TENANT, customerId: customer.id, locationId: 'loc-1', jobNumber: 'JOB-1',
    summary: 'AC tune-up', status: 'scheduled', priority: 'normal', createdBy: 'user-1',
    createdAt: new Date(), updatedAt: new Date(),
  });
  const estimate: Estimate = {
    id: uuidv4(), tenantId: TENANT, jobId: job.id, estimateNumber: 'EST-0030', status: 'sent',
    lineItems: [{ id: uuidv4(), description: 'Labor hour', quantity: 2, unitPriceCents: 12550, totalCents: 25100, sortOrder: 0, taxable: true }],
    totals: { subtotalCents: 25100, taxableSubtotalCents: 25100, discountCents: 0, taxRateBps: 825, taxCents: 2071, totalCents: 27171 },
    viewToken: TOKEN, sentAt: new Date(), version: 1, createdBy: 'user-1', createdAt: new Date(), updatedAt: new Date(),
  };
  await estimateRepo.create(estimate);
  return { estimateRepo, customerRepo, jobRepo, settingsRepo, estimate };
}

describe('customer confirmation after public approval (#1400)', () => {
  it('approve() asks the notifier to confirm to the customer exactly once (a double-click does not re-send)', async () => {
    const h = await harness();
    const approvalNotifier = { notifyEstimateApproved: vi.fn().mockResolvedValue(undefined) };
    const service = new PublicEstimateService({
      estimateRepo: h.estimateRepo, customerRepo: h.customerRepo, jobRepo: h.jobRepo, settingsRepo: h.settingsRepo,
      approvalNotifier,
    });

    await service.approve({ token: TOKEN, acceptedByName: 'Sarah Johnson' });
    await service.approve({ token: TOKEN, acceptedByName: 'Sarah Johnson' });

    expect(approvalNotifier.notifyEstimateApproved).toHaveBeenCalledTimes(1);
    expect(approvalNotifier.notifyEstimateApproved).toHaveBeenCalledWith(TENANT, h.estimate.id);
  });

  it('TransactionalCommsService.notifyEstimateApproved texts the customer the approved estimate number and total', async () => {
    const h = await harness();
    const delivery = new InMemoryDeliveryProvider();
    const comms = new TransactionalCommsService({
      appointmentRepo: new InMemoryAppointmentRepository(),
      jobRepo: h.jobRepo, customerRepo: h.customerRepo, settingsRepo: h.settingsRepo,
      invoiceRepo: new InMemoryInvoiceRepository(), estimateRepo: h.estimateRepo,
      delivery, dispatchRepo: new InMemoryDispatchRepository(), pool: null,
      logger: createLogger({ service: 'test', environment: 'test' }),
    });

    // The notifier runs after approve() has committed the acceptance.
    await h.estimateRepo.update(TENANT, h.estimate.id, { status: 'accepted', acceptedAt: new Date() });
    await comms.notifyEstimateApproved(TENANT, h.estimate.id);

    expect(delivery.sentSms).toHaveLength(1);
    expect(delivery.sentSms[0].to).toBe('+15555550199');
    expect(delivery.sentSms[0].body).toContain('EST-0030');
    expect(delivery.sentSms[0].body).toContain('$271.71');
    expect(delivery.sentSms[0].body).toContain('Acme HVAC');
  });
});
