import { describe, it, expect, beforeEach } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { CreateInvoiceScheduleExecutionHandler } from '../../src/proposals/execution/invoice-schedule-handler';
import { actionClassForProposalType, Proposal } from '../../src/proposals/proposal';
import { validateProposalPayload } from '../../src/proposals/contracts';
import { createInvoiceSchedulePayloadSchema } from '../../src/proposals/contracts/create-invoice-schedule';
import { InMemoryInvoiceRepository } from '../../src/invoices/invoice';
import { InMemoryInvoiceScheduleRepository } from '../../src/invoices/invoice-schedule';
import { InMemorySettingsRepository, TenantSettings } from '../../src/settings/settings';
import { InMemoryEstimateRepository, createEstimate } from '../../src/estimates/estimate';
import { buildLineItem } from '../../src/shared/billing-engine';

const TENANT = 'tenant-sched';

const milestones5050 = [
  { label: 'Deposit', type: 'percent', value: 5000, trigger: 'on_accept' },
  { label: 'Balance', type: 'remainder', value: 0, trigger: 'on_completion' },
];

const twoRemainders = [
  { label: 'A', type: 'remainder', value: 0, trigger: 'on_accept' },
  { label: 'B', type: 'remainder', value: 0, trigger: 'on_completion' },
];

function makeSettings(): TenantSettings {
  return {
    id: `settings-${TENANT}`,
    tenantId: TENANT,
    businessName: 'Rivera HVAC',
    timezone: 'UTC',
    estimatePrefix: 'EST-',
    invoicePrefix: 'INV-',
    nextEstimateNumber: 1,
    nextInvoiceNumber: 1,
    defaultPaymentTermDays: 30,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function makeProposal(payload: Record<string, unknown>, overrides: Partial<Proposal> = {}): Proposal {
  return {
    id: 'p1',
    tenantId: TENANT,
    proposalType: 'create_invoice_schedule',
    status: 'approved',
    payload,
    summary: 'Milestone billing plan',
    createdBy: 'u1',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe('P21-002 — create_invoice_schedule', () => {
  it('is classified capture-class (never auto-approves money/comms)', () => {
    expect(actionClassForProposalType('create_invoice_schedule')).toBe('capture');
  });

  describe('Zod contract', () => {
    it('accepts a valid plan', () => {
      expect(
        createInvoiceSchedulePayloadSchema.safeParse({ jobId: uuidv4(), milestones: milestones5050 }).success,
      ).toBe(true);
    });

    it('rejects two remainder milestones', () => {
      expect(
        createInvoiceSchedulePayloadSchema.safeParse({ jobId: uuidv4(), milestones: twoRemainders }).success,
      ).toBe(false);
    });

    it('rejects a percent milestone over 10000 bps', () => {
      expect(
        createInvoiceSchedulePayloadSchema.safeParse({
          jobId: uuidv4(),
          milestones: [
            { label: 'Too big', type: 'percent', value: 10001, trigger: 'on_accept' },
            { label: 'Rest', type: 'remainder', value: 0, trigger: 'on_completion' },
          ],
        }).success,
      ).toBe(false);
    });

    it('is reachable through validateProposalPayload (registered in PROPOSAL_TYPE_SCHEMAS)', () => {
      expect(validateProposalPayload('create_invoice_schedule', { jobId: uuidv4(), milestones: milestones5050 }).valid).toBe(true);
      expect(validateProposalPayload('create_invoice_schedule', { jobId: uuidv4(), milestones: twoRemainders }).valid).toBe(false);
    });
  });

  describe('execution', () => {
    let scheduleRepo: InMemoryInvoiceScheduleRepository;
    let invoiceRepo: InMemoryInvoiceRepository;
    let settingsRepo: InMemorySettingsRepository;
    let estimateRepo: InMemoryEstimateRepository;
    let handler: CreateInvoiceScheduleExecutionHandler;

    beforeEach(async () => {
      scheduleRepo = new InMemoryInvoiceScheduleRepository();
      invoiceRepo = new InMemoryInvoiceRepository();
      settingsRepo = new InMemorySettingsRepository();
      estimateRepo = new InMemoryEstimateRepository();
      await settingsRepo.create(makeSettings());
      handler = new CreateInvoiceScheduleExecutionHandler(scheduleRepo, invoiceRepo, settingsRepo, estimateRepo);
    });

    it('writes the schedule and mints the first milestone invoice (explicit total)', async () => {
      const jobId = uuidv4();
      const result = await handler.execute(
        makeProposal({ jobId, totalAmountCents: 20000, milestones: milestones5050 }),
        { tenantId: TENANT, executedBy: 'u1' },
      );
      expect(result.success).toBe(true);

      const schedules = await scheduleRepo.findByJob(TENANT, jobId);
      expect(schedules).toHaveLength(1);
      expect(schedules[0].totalAmountCents).toBe(20000);
      expect(result.resultEntityId).toBe(schedules[0].id);

      const invoices = await invoiceRepo.findByJob(TENANT, jobId);
      expect(invoices).toHaveLength(1);
      expect(invoices[0].scheduleId).toBe(schedules[0].id);
      expect(invoices[0].milestoneIndex).toBe(0);
      // First milestone = 50% of 20000 = 10000.
      expect(invoices[0].totals.totalCents).toBe(10000);
    });

    it('derives the total from the estimate when totalAmountCents is omitted', async () => {
      const jobId = uuidv4();
      const est = await createEstimate(
        { tenantId: TENANT, jobId, estimateNumber: 'EST-1', lineItems: [buildLineItem('i1', 'Repair', 1, 40000, 0, true)], createdBy: 'u1' },
        estimateRepo,
      );
      const result = await handler.execute(
        makeProposal({ jobId, estimateId: est.id, milestones: milestones5050 }),
        { tenantId: TENANT, executedBy: 'u1' },
      );
      expect(result.success).toBe(true);
      const invoices = await invoiceRepo.findByJob(TENANT, jobId);
      expect(invoices[0].totals.totalCents).toBe(20000); // 50% of 40000
    });

    it('derives the total from the estimate persisted totals (tax included)', async () => {
      const jobId = uuidv4();
      const est = await createEstimate(
        {
          tenantId: TENANT,
          jobId,
          estimateNumber: 'EST-1',
          lineItems: [buildLineItem('i1', 'Repair', 1, 40000, 0, true)],
          taxRateBps: 1000, // 10% → total 44000
          createdBy: 'u1',
        },
        estimateRepo,
      );
      await estimateRepo.update(TENANT, est.id, { status: 'accepted' });

      await handler.execute(
        makeProposal({ jobId, estimateId: est.id, milestones: milestones5050 }),
        { tenantId: TENANT, executedBy: 'u1' },
      );
      const invoices = await invoiceRepo.findByJob(TENANT, jobId);
      // 50% of the TAXED total (44000), not the raw line sum (40000).
      expect(invoices[0].totals.totalCents).toBe(22000);
    });

    it('does not mint an invoice up front when no milestone is on_accept', async () => {
      const jobId = uuidv4();
      const result = await handler.execute(
        makeProposal({
          jobId,
          totalAmountCents: 20000,
          milestones: [
            { label: 'Progress', type: 'percent', value: 5000, trigger: 'on_completion' },
            { label: 'Final', type: 'remainder', value: 0, trigger: 'on_completion' },
          ],
        }),
        { tenantId: TENANT, executedBy: 'u1' },
      );
      expect(result.success).toBe(true);
      // Schedule is written, but nothing bills until a trigger fires.
      expect(await scheduleRepo.findByJob(TENANT, jobId)).toHaveLength(1);
      expect(await invoiceRepo.findByJob(TENANT, jobId)).toHaveLength(0);
    });

    it('errors when no total can be determined', async () => {
      const result = await handler.execute(
        makeProposal({ jobId: uuidv4(), milestones: milestones5050 }),
        { tenantId: TENANT, executedBy: 'u1' },
      );
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/determine schedule total/i);
    });

    it('is idempotent on a prior resultEntityId', async () => {
      const result = await handler.execute(
        makeProposal({ jobId: uuidv4(), totalAmountCents: 20000, milestones: milestones5050 }, { resultEntityId: 'existing-sched' }),
        { tenantId: TENANT, executedBy: 'u1' },
      );
      expect(result.resultEntityId).toBe('existing-sched');
      // No new schedule written on the short-circuit path.
      expect(await scheduleRepo.findById(TENANT, 'existing-sched')).toBeNull();
    });
  });

  it('degrades to a synthetic-id passthrough when persistence deps are absent', async () => {
    const bare = new CreateInvoiceScheduleExecutionHandler();
    const result = await bare.execute(
      makeProposal({ jobId: uuidv4(), totalAmountCents: 20000, milestones: milestones5050 }),
      { tenantId: TENANT, executedBy: 'u1' },
    );
    expect(result.success).toBe(true);
    expect(result.resultEntityId).toBeTruthy();
  });
});
