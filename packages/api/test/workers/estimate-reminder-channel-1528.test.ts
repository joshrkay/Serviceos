/**
 * #1528 — the automatic estimate-reminder sweep nudges through the same
 * dispatchEstimateNudge as the send_estimate_nudge proposal, so it follows the
 * same channel rule: the customer's email when one is on file, else a text.
 * Before this the sweep always texted, so an email-only customer's reminder
 * failed every sweep ("no primary phone") and was never delivered.
 *
 * Seam: runEstimateReminderSweep over a real SendService + in-memory delivery.
 */
import { describe, it, expect } from 'vitest';
import { runEstimateReminderSweep } from '../../src/workers/estimate-reminder-worker';
import { InMemoryCustomerRepository } from '../../src/customers/customer';
import { InMemoryInvoiceRepository } from '../../src/invoices/invoice';
import { InMemoryJobRepository } from '../../src/jobs/job';
import { InMemoryEstimateRepository } from '../../src/estimates/estimate';
import { buildCustomer } from '../factories/customer.factory';
import { buildJob } from '../factories/job.factory';
import { buildEstimate } from '../factories/estimate.factory';
import { SendService } from '../../src/notifications/send-service';
import { InMemoryDeliveryProvider } from '../../src/notifications/delivery-provider';
import { GatedMessageDelivery } from '../../src/notifications/gated-message-delivery';
import { InMemoryDispatchRepository } from '../../src/notifications/dispatch-repository';
import { InMemorySettingsRepository } from '../../src/settings/settings';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { InMemoryDncRepository } from '../../src/compliance/dnc';
import { createLogger } from '../../src/logging/logger';

const TENANT = '11111111-1111-4111-8111-111111115282';
const CUSTOMER = '33333333-3333-4333-8333-333333335282';
const JOB = '44444444-4444-4444-8444-444444445282';
const ESTIMATE = '55555555-5555-4555-8555-555555555282';
const NOW = new Date('2026-09-30T12:00:00Z');
const FIVE_DAYS_AGO = new Date(NOW.getTime() - 5 * 24 * 60 * 60 * 1000);

async function sweepFor(customer: { email?: string; primaryPhone?: string; smsConsent?: boolean }) {
  const customerRepo = new InMemoryCustomerRepository();
  const jobRepo = new InMemoryJobRepository();
  const estimateRepo = new InMemoryEstimateRepository();
  await customerRepo.create(buildCustomer({ id: CUSTOMER, tenantId: TENANT, displayName: 'Sam Sweep', ...customer }));
  await jobRepo.create(buildJob({ id: JOB, tenantId: TENANT, customerId: CUSTOMER }));
  await estimateRepo.create(
    buildEstimate({
      id: ESTIMATE,
      tenantId: TENANT,
      jobId: JOB,
      estimateNumber: 'EST-5282',
      status: 'sent',
      sentAt: FIVE_DAYS_AGO,
    }),
  );
  const settingsRepo = new InMemorySettingsRepository();
  await settingsRepo.create({
    id: '66666666-6666-4666-8666-666666665282',
    tenantId: TENANT,
    businessName: 'Acme HVAC',
    timezone: 'America/Phoenix',
    estimatePrefix: 'EST',
    invoicePrefix: 'INV',
    nextEstimateNumber: 1000,
    nextInvoiceNumber: 2000,
    defaultPaymentTermDays: 30,
    createdAt: NOW,
    updatedAt: NOW,
  });
  const delivery = new InMemoryDeliveryProvider();
  const sendService = new SendService({
    delivery: new GatedMessageDelivery({
      base: delivery,
      dnc: new InMemoryDncRepository(),
      auditRepo: new InMemoryAuditRepository(),
      enforcement: 'block',
    }),
    estimateRepo,
    invoiceRepo: new InMemoryInvoiceRepository(),
    jobRepo,
    customerRepo,
    settingsRepo,
    dispatchRepo: new InMemoryDispatchRepository(),
    publicBaseUrl: 'https://app.example.com',
  });
  const auditRepo = new InMemoryAuditRepository();
  const result = await runEstimateReminderSweep({
    estimateRepo,
    sendService,
    auditRepo,
    pool: null,
    listTenantIds: async () => [TENANT],
    logger: createLogger({ service: 'test', environment: 'test', level: 'error' }),
    now: () => NOW,
  });
  return { result, delivery, auditRepo };
}

describe('#1528 — estimate-reminder sweep channel', () => {
  it('emails the reminder to an email-only customer', async () => {
    const { result, delivery } = await sweepFor({ email: 'sam@example.com', primaryPhone: undefined });

    expect(result).toEqual({ tenants: 1, reminders: 1, failed: 0 });
    expect(delivery.sentSms).toHaveLength(0);
    expect(delivery.sentEmails.map((m) => m.to)).toEqual(['sam@example.com']);
  });

  it("records the channel the reminder actually went out on, not 'auto'", async () => {
    const { auditRepo } = await sweepFor({ email: 'sam@example.com', primaryPhone: undefined });

    const events = await auditRepo.findByEntity(TENANT, 'estimate', ESTIMATE);
    const reminder = events.find((e) => e.eventType === 'estimate.reminder_sent');
    expect(reminder?.metadata).toMatchObject({ channel: 'email', reminderCount: 1 });
  });
});
