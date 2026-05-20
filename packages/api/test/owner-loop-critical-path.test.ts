/**
 * §11 critical-path smoke — owner loop (Layer A comms).
 *
 * Synthetic path (no Twilio audio): held slot → create_booking approval →
 * booking confirmation dispatched → optional estimate → invoice → payment receipt.
 *
 * Gates deploys alongside voice-smoke.synthetic.test.ts.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { CreateBookingExecutionHandler } from '../src/proposals/execution/create-booking-handler';
import { CreateAppointmentExecutionHandler } from '../src/proposals/execution/handlers';
import { RecordPaymentExecutionHandler } from '../src/proposals/execution/voice-extended-handlers';
import { InMemoryAppointmentRepository } from '../src/appointments/in-memory-appointment';
import { InMemoryAuditRepository } from '../src/audit/audit';
import { InMemoryCustomerRepository, Customer } from '../src/customers/customer';
import { InMemoryJobRepository, Job } from '../src/jobs/job';
import { InMemorySettingsRepository } from '../src/settings/settings';
import { InMemoryDeliveryProvider } from '../src/notifications/delivery-provider';
import { InMemoryDispatchRepository } from '../src/notifications/dispatch-repository';
import { InMemoryDncRepository } from '../src/compliance/dnc';
import { TransactionalCommsService } from '../src/notifications/transactional-comms-service';
import { createAppointment } from '../src/appointments/appointment';
import { createProposal } from '../src/proposals/proposal';
import { transitionProposal } from '../src/proposals/lifecycle';
import { InMemoryInvoiceRepository } from '../src/invoices/invoice';
import { InMemoryPaymentRepository } from '../src/invoices/payment';
import { InMemoryEstimateRepository } from '../src/estimates/estimate';
import { createInvoice, issueInvoice } from '../src/invoices/invoice';
import { createEstimate } from '../src/estimates/estimate';
import { buildLineItem } from '../src/shared/billing-engine';

const TENANT = '00000000-0000-4000-8000-00000000000a';

function makeCustomer(): Customer {
  return {
    id: uuidv4(),
    tenantId: TENANT,
    firstName: 'Pat',
    lastName: 'Rivera',
    displayName: 'Pat Rivera',
    primaryPhone: '+15551234567',
    email: 'pat@example.com',
    preferredChannel: 'sms',
    smsConsent: true,
    isArchived: false,
    createdBy: 'owner-1',
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function makeJob(customerId: string): Job {
  return {
    id: uuidv4(),
    tenantId: TENANT,
    customerId,
    locationId: uuidv4(),
    jobNumber: 'JOB-900',
    summary: 'Water heater',
    status: 'scheduled',
    priority: 'normal',
    moneyState: 'no_estimate',
    createdBy: 'owner-1',
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

describe('owner loop critical path — §11 smoke', () => {
  let appointmentRepo: InMemoryAppointmentRepository;
  let auditRepo: InMemoryAuditRepository;
  let customerRepo: InMemoryCustomerRepository;
  let jobRepo: InMemoryJobRepository;
  let settingsRepo: InMemorySettingsRepository;
  let delivery: InMemoryDeliveryProvider;
  let dispatch: InMemoryDispatchRepository;
  let transactionalComms: TransactionalCommsService;

  beforeEach(async () => {
    appointmentRepo = new InMemoryAppointmentRepository();
    auditRepo = new InMemoryAuditRepository();
    customerRepo = new InMemoryCustomerRepository();
    jobRepo = new InMemoryJobRepository();
    settingsRepo = new InMemorySettingsRepository();
    delivery = new InMemoryDeliveryProvider();
    dispatch = new InMemoryDispatchRepository();

    await settingsRepo.create({
      id: uuidv4(),
      tenantId: TENANT,
      businessName: 'Loop HVAC',
      timezone: 'UTC',
      estimatePrefix: 'EST-',
      invoicePrefix: 'INV-',
      nextEstimateNumber: 1,
      nextInvoiceNumber: 1,
      defaultPaymentTermDays: 30,
      autoSendAppointmentReminders: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    transactionalComms = new TransactionalCommsService({
      delivery,
      dispatchRepo: dispatch,
      dncRepo: new InMemoryDncRepository(),
      appointmentRepo,
      jobRepo,
      customerRepo,
      settingsRepo,
      invoiceRepo: new InMemoryInvoiceRepository(),
    });
  });

  it('create_booking approval dispatches booking confirmation within 5s', async () => {
    const customer = makeCustomer();
    await customerRepo.create(customer);
    const job = makeJob(customer.id);
    await jobRepo.create(job);

    const appt = await createAppointment(
      {
        tenantId: TENANT,
        jobId: job.id,
        scheduledStart: new Date('2026-06-10T17:00:00Z'),
        scheduledEnd: new Date('2026-06-10T18:00:00Z'),
        timezone: 'UTC',
        createdBy: 'agent-1',
        holdPendingApproval: true,
        holdExpiryAt: new Date('2099-01-01T00:00:00Z'),
      },
      appointmentRepo,
    );

    const started = Date.now();
    const handler = new CreateBookingExecutionHandler(
      appointmentRepo,
      auditRepo,
      transactionalComms,
    );
    const proposal = createProposal({
      tenantId: TENANT,
      proposalType: 'create_booking',
      payload: { appointmentId: appt.id },
      summary: 'Confirm held booking',
      createdBy: 'owner-1',
    });

    const result = await handler.execute(proposal, {
      tenantId: TENANT,
      executedBy: 'owner-1',
    });

    expect(result.success).toBe(true);
    expect(Date.now() - started).toBeLessThan(5000);

    const dispatches = await dispatch.findByEntity(
      TENANT,
      'appointment_confirmation',
      appt.id,
    );
    expect(dispatches.length).toBeGreaterThan(0);
    expect(delivery.sentSms.length).toBeGreaterThan(0);
    expect(delivery.sentSms[0].body).toMatch(/confirmed/i);
  });

  it('record_payment proposal sends payment receipt when wired', async () => {
    const customer = makeCustomer();
    await customerRepo.create(customer);
    const job = makeJob(customer.id);
    await jobRepo.create(job);

    const estimateRepo = new InMemoryEstimateRepository();
    const invoiceRepo = new InMemoryInvoiceRepository();
    const paymentRepo = new InMemoryPaymentRepository();

    const lineItems = [buildLineItem('1', 'Labor', 1, 10_000, 1, true)];
    const estimate = await createEstimate(
      {
        tenantId: TENANT,
        jobId: job.id,
        estimateNumber: 'EST-0001',
        lineItems,
        createdBy: 'owner-1',
      },
      estimateRepo,
    );

    const invoice = await createInvoice(
      {
        tenantId: TENANT,
        jobId: job.id,
        estimateId: estimate.id,
        invoiceNumber: 'INV-0001',
        lineItems,
        createdBy: 'owner-1',
      },
      invoiceRepo,
    );
    await issueInvoice(TENANT, invoice.id, 30, invoiceRepo);

    const comms = new TransactionalCommsService({
      delivery,
      dispatchRepo: dispatch,
      dncRepo: new InMemoryDncRepository(),
      appointmentRepo,
      jobRepo,
      customerRepo,
      settingsRepo,
      invoiceRepo,
    });

    const handler = new RecordPaymentExecutionHandler(
      paymentRepo,
      invoiceRepo,
      {
        jobRepo,
        estimateRepo,
        invoiceRepo,
        auditRepo,
      },
      comms,
    );

    const proposal = createProposal({
      tenantId: TENANT,
      proposalType: 'record_payment',
      payload: {
        invoiceId: invoice.id,
        amountCents: invoice.amountDueCents,
        paymentMethod: 'cash',
      },
      summary: 'Record cash payment',
      createdBy: 'owner-1',
    });
    let approved = transitionProposal(proposal, 'ready_for_review', 'owner-1');
    approved = transitionProposal(approved, 'approved', 'owner-1');

    const result = await handler.execute(approved, {
      tenantId: TENANT,
      executedBy: 'owner-1',
    });
    expect(result.success).toBe(true);

    const receipts = await dispatch.findByEntity(TENANT, 'payment_receipt', invoice.id);
    expect(receipts.length).toBeGreaterThan(0);
    expect(delivery.sentSms.some((m) => m.body.includes('received your payment'))).toBe(true);
  });

  it('create_appointment execution still dispatches confirmation (regression)', async () => {
    const customer = makeCustomer();
    await customerRepo.create(customer);
    const job = makeJob(customer.id);
    await jobRepo.create(job);

    const handler = new CreateAppointmentExecutionHandler(
      appointmentRepo,
      undefined,
      transactionalComms,
    );
    const proposal = createProposal({
      tenantId: TENANT,
      proposalType: 'create_appointment',
      payload: {
        jobId: job.id,
        scheduledStart: '2026-06-11T14:00:00Z',
        scheduledEnd: '2026-06-11T15:00:00Z',
        timezone: 'UTC',
      },
      summary: 'Book visit',
      createdBy: 'owner-1',
    });

    const result = await handler.execute(proposal, {
      tenantId: TENANT,
      executedBy: 'owner-1',
    });
    expect(result.success).toBe(true);
    expect(delivery.sentSms.length).toBeGreaterThan(0);
  });
});
