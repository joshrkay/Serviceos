/**
 * Owner-loop critical path — deploy gate.
 *
 * Synthetic booking → approve → confirmation dispatch → optional
 * estimate / invoice / payment money path with Layer A comms.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { CreateAppointmentAITaskHandler } from '../src/ai/tasks/create-appointment-task';
import type { LLMGateway } from '../src/ai/gateway/gateway';
import type { TaskContext } from '../src/ai/tasks/task-handlers';
import { approveProposal } from '../src/proposals/actions';
import {
  createProposal,
  InMemoryProposalRepository,
} from '../src/proposals/proposal';
import { transitionProposal, UNDO_WINDOW_MS } from '../src/proposals/lifecycle';
import { ProposalExecutor } from '../src/proposals/execution/executor';
import { IdempotencyGuard } from '../src/proposals/execution/idempotency';
import { InMemoryProposalExecutionRepository } from '../src/proposals/proposal-execution';
import { createExecutionHandlerRegistry } from '../src/proposals/execution/handlers';
import { runExecutionSweep } from '../src/workers/execution-worker';
import { createLogger } from '../src/logging/logger';
import { InMemoryAppointmentRepository } from '../src/appointments/in-memory-appointment';
import { InMemoryAuditRepository } from '../src/audit/audit';
import { InMemoryJobRepository, createJob } from '../src/jobs/job';
import { InMemoryCustomerRepository } from '../src/customers/customer';
import { InMemorySettingsRepository } from '../src/settings/settings';
import { InMemoryDispatchRepository } from '../src/notifications/dispatch-repository';
import { InMemoryDeliveryProvider } from '../src/notifications/delivery-provider';
import { InMemoryDncRepository } from '../src/compliance/dnc';
import { AppointmentConfirmationNotifier } from '../src/notifications/appointment-confirmation-notifier';
import { TransactionalCommsListener } from '../src/notifications/transactional-comms-listener';
import { InMemoryEstimateRepository } from '../src/estimates/estimate';
import { InMemoryInvoiceRepository } from '../src/invoices/invoice';
import { InMemoryPaymentRepository } from '../src/invoices/payment';
import { SendService } from '../src/notifications/send-service';
import { runOverdueInvoiceSweep } from '../src/workers/overdue-invoice-worker';
import { recordPayment } from '../src/invoices/payment';
import { refreshJobMoneyStateSafe } from '../src/jobs/job-money-state';
import type { Estimate } from '../src/estimates/estimate';
import type { Invoice } from '../src/invoices/invoice';
import type { DocumentTotals } from '../src/shared/billing-engine';

const TENANT = '00000000-0000-4000-8000-00000000000a';
const logger = createLogger({ service: 'owner-loop', environment: 'test', level: 'error' });

const ZERO_TOTALS: DocumentTotals = {
  subtotalCents: 10000,
  discountCents: 0,
  taxRateBps: 0,
  taxableSubtotalCents: 10000,
  taxCents: 0,
  totalCents: 10000,
};

function fakeGateway(json: Record<string, unknown>): LLMGateway {
  return {
    complete: async () => ({ content: JSON.stringify(json) }),
  } as unknown as LLMGateway;
}

interface OwnerLoopHarness {
  jobId: string;
  appointmentRepo: InMemoryAppointmentRepository;
  proposalRepo: InMemoryProposalRepository;
  jobRepo: InMemoryJobRepository;
  customerRepo: InMemoryCustomerRepository;
  settingsRepo: InMemorySettingsRepository;
  dispatchRepo: InMemoryDispatchRepository;
  auditRepo: InMemoryAuditRepository;
  estimateRepo: InMemoryEstimateRepository;
  invoiceRepo: InMemoryInvoiceRepository;
  paymentRepo: InMemoryPaymentRepository;
  transactionalComms: TransactionalCommsListener;
  executor: ProposalExecutor;
}

async function buildHarness(): Promise<OwnerLoopHarness> {
  const appointmentRepo = new InMemoryAppointmentRepository();
  const proposalRepo = new InMemoryProposalRepository();
  const jobRepo = new InMemoryJobRepository();
  const customerRepo = new InMemoryCustomerRepository();
  const settingsRepo = new InMemorySettingsRepository();
  const dispatchRepo = new InMemoryDispatchRepository();
  const delivery = new InMemoryDeliveryProvider();
  const dncRepo = new InMemoryDncRepository();
  const auditRepo = new InMemoryAuditRepository();
  const estimateRepo = new InMemoryEstimateRepository();
  const invoiceRepo = new InMemoryInvoiceRepository();
  const paymentRepo = new InMemoryPaymentRepository();

  await settingsRepo.create({
    id: uuidv4(),
    tenantId: TENANT,
    businessName: 'Acme HVAC',
    timezone: 'America/Los_Angeles',
    estimatePrefix: 'EST',
    invoicePrefix: 'INV',
    nextEstimateNumber: 1000,
    nextInvoiceNumber: 2000,
    defaultPaymentTermDays: 30,
    autoSendAppointmentReminders: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  const customerId = uuidv4();
  await customerRepo.create({
    id: customerId,
    tenantId: TENANT,
    firstName: 'Alex',
    lastName: 'Park',
    displayName: 'Alex Park',
    primaryPhone: '+15557654321',
    email: 'alex@example.com',
    preferredChannel: 'sms',
    smsConsent: true,
    isArchived: false,
    createdBy: 'owner-1',
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  const job = await createJob(
    {
      tenantId: TENANT,
      customerId,
      locationId: uuidv4(),
      summary: 'AC repair',
      createdBy: 'owner-1',
    },
    jobRepo,
  );

  const confirmationNotifier = new AppointmentConfirmationNotifier({
    delivery,
    appointmentRepo,
    jobRepo,
    customerRepo,
    settingsRepo,
    dispatchRepo,
    dncRepo,
  });

  const transactionalComms = new TransactionalCommsListener({
    delivery,
    appointmentRepo,
    jobRepo,
    customerRepo,
    settingsRepo,
    dispatchRepo,
    dncRepo,
    invoiceRepo,
    confirmationNotifier,
    publicBaseUrl: 'http://localhost:5173',
  });

  const handlers = createExecutionHandlerRegistry({
    appointmentRepo,
    jobRepo,
    customerRepo,
    settingsRepo,
    auditRepo,
    estimateRepo,
    invoiceRepo,
    paymentRepo,
    schedulingNotifier: confirmationNotifier,
    transactionalComms,
  });

  const guard = new IdempotencyGuard(
    new InMemoryProposalExecutionRepository(),
    proposalRepo,
  );
  const executor = new ProposalExecutor(handlers, proposalRepo, guard);

  return {
    jobId: job.id,
    appointmentRepo,
    proposalRepo,
    jobRepo,
    customerRepo,
    settingsRepo,
    dispatchRepo,
    auditRepo,
    estimateRepo,
    invoiceRepo,
    paymentRepo,
    transactionalComms,
    executor,
  };
}

describe('owner-loop critical path', () => {
  let h: OwnerLoopHarness;

  beforeEach(async () => {
    h = await buildHarness();
  });

  it('synthetic call → create_booking → approve → confirmation dispatched', async () => {
    const handler = new CreateAppointmentAITaskHandler(
      fakeGateway({
        jobId: h.jobId,
        scheduledStart: '2026-06-02T21:00:00Z',
        scheduledEnd: '2026-06-02T22:00:00Z',
        summary: 'AC repair',
        confidence_score: 0.9,
      }),
      undefined,
      undefined,
      h.appointmentRepo,
    );

    const taskResult = await handler.handle({
      tenantId: TENANT,
      userId: 'agent-1',
      message: 'Book Tuesday at 2pm',
    } as TaskContext);

    expect(taskResult.proposal.proposalType).toBe('create_booking');
    const stored = await h.proposalRepo.create(taskResult.proposal);
    await h.proposalRepo.updateStatus(TENANT, stored.id, 'ready_for_review');

    await approveProposal(
      h.proposalRepo,
      TENANT,
      stored.id,
      'owner-1',
      'owner',
      h.auditRepo,
    );

    await h.proposalRepo.updateStatus(TENANT, stored.id, 'approved', {
      approvedAt: new Date(Date.now() - UNDO_WINDOW_MS - 100),
    });

    const { executed } = await runExecutionSweep({
      proposalRepo: h.proposalRepo,
      executor: h.executor,
      logger,
    });
    expect(executed).toBe(1);

    const appointmentId = taskResult.proposal.payload.appointmentId as string;
    const dispatches = await h.dispatchRepo.findByEntity(
      TENANT,
      'appointment_confirmation',
      appointmentId,
    );
    expect(dispatches.length).toBeGreaterThan(0);
  });

  it('money path: estimate sent → overdue nudge → payment receipt', async () => {
    const delivery = new InMemoryDeliveryProvider();
    const dncRepo = new InMemoryDncRepository();
    const sendService = new SendService({
      delivery,
      estimateRepo: h.estimateRepo,
      invoiceRepo: h.invoiceRepo,
      jobRepo: h.jobRepo,
      customerRepo: h.customerRepo,
      settingsRepo: h.settingsRepo,
      dispatchRepo: h.dispatchRepo,
      dncRepo,
      publicBaseUrl: 'http://localhost:5173',
    });

    const estimate: Estimate = {
      id: uuidv4(),
      tenantId: TENANT,
      jobId: h.jobId,
      estimateNumber: 'EST-1001',
      status: 'draft',
      lineItems: [],
      totals: ZERO_TOTALS,
      createdBy: 'owner-1',
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    await h.estimateRepo.create(estimate);

    await sendService.sendEstimate({
      tenantId: TENANT,
      estimateId: estimate.id,
      channel: 'sms',
    });

    await refreshJobMoneyStateSafe(TENANT, h.jobId, 'owner-1', {
      jobRepo: h.jobRepo,
      estimateRepo: h.estimateRepo,
      invoiceRepo: h.invoiceRepo,
      auditRepo: h.auditRepo,
    });

    const jobAfterEstimate = await h.jobRepo.findById(TENANT, h.jobId);
    expect(jobAfterEstimate?.moneyState).toBe('estimate_sent');

    const estimateDispatches = await h.dispatchRepo.findByEntity(
      TENANT,
      'estimate',
      estimate.id,
    );
    expect(estimateDispatches.length).toBeGreaterThan(0);

    const NOW = new Date('2026-05-14T12:00:00Z');
    const PAST = new Date('2026-05-01T00:00:00Z');

    const invoice: Invoice = {
      id: uuidv4(),
      tenantId: TENANT,
      jobId: h.jobId,
      invoiceNumber: 'INV-2001',
      status: 'open',
      lineItems: [],
      totals: ZERO_TOTALS,
      amountPaidCents: 0,
      amountDueCents: 10000,
      dueDate: PAST,
      createdBy: 'owner-1',
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    await h.invoiceRepo.create(invoice);

    await runOverdueInvoiceSweep({
      jobRepo: h.jobRepo,
      estimateRepo: h.estimateRepo,
      invoiceRepo: h.invoiceRepo,
      auditRepo: h.auditRepo,
      transactionalComms: h.transactionalComms,
      listTenantIds: async () => [TENANT],
      logger,
      now: () => NOW,
    });

    const jobOverdue = await h.jobRepo.findById(TENANT, h.jobId);
    expect(jobOverdue?.moneyState).toBe('overdue');

    const overdueDispatches = await h.dispatchRepo.findByEntity(
      TENANT,
      'invoice_overdue_nudge',
      invoice.id,
    );
    expect(overdueDispatches.length).toBeGreaterThan(0);

    await recordPayment(
      {
        tenantId: TENANT,
        invoiceId: invoice.id,
        amountCents: 10000,
        method: 'cash',
        processedBy: 'owner-1',
      },
      h.invoiceRepo,
      h.paymentRepo,
      {
        jobRepo: h.jobRepo,
        estimateRepo: h.estimateRepo,
        invoiceRepo: h.invoiceRepo,
        auditRepo: h.auditRepo,
        transactionalComms: h.transactionalComms,
      },
    );

    const jobPaid = await h.jobRepo.findById(TENANT, h.jobId);
    expect(jobPaid?.moneyState).toBe('paid');

    const receiptDispatches = await h.dispatchRepo.listByTenant(TENANT, {
      entityType: 'payment_receipt',
    });
    expect(receiptDispatches.dispatches.length).toBeGreaterThan(0);
  });
});
