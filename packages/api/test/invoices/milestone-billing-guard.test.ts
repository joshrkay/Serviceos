/**
 * #1203 — unit tests for the milestone-billing guard and the four seams that
 * use it: plan-then-convert, plan-then-draft_invoice, auto-invoice yielding to
 * a plan (only when completion will mint it, C4), and completion holding
 * milestones for the owner instead of dropping them (C1).
 *
 * The real product paths at Postgres are in
 * test/integration/milestone-billing-recorded-estimate.test.ts.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import {
  completionWillMintPlan,
  formatCentsUsd,
  heldMilestonesSummary,
  invoiceStillBills,
  milestonePlanBillingEstimate,
  planBilledEstimateId,
  wholeInvoiceBillingEstimate,
  wholeInvoiceRefusalReason,
  wholeInvoiceRefusedByPlanReason,
} from '../../src/invoices/milestone-billing-guard';
import {
  InMemoryInvoiceScheduleRepository,
  InvoiceMilestone,
  InvoiceSchedule,
  buildInvoiceSchedule,
} from '../../src/invoices/invoice-schedule';
import { Invoice, InMemoryInvoiceRepository, createInvoice } from '../../src/invoices/invoice';
import { InMemorySettingsRepository, TenantSettings } from '../../src/settings/settings';
import { InMemoryEstimateRepository, createEstimate, Estimate } from '../../src/estimates/estimate';
import { InMemoryJobRepository, Job } from '../../src/jobs/job';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { InMemoryProposalRepository, Proposal } from '../../src/proposals/proposal';
import { convertEstimateToInvoice } from '../../src/invoices/convert-estimate';
import { maybeAutoInvoiceOnCompletion } from '../../src/invoices/auto-invoice-on-completion';
import { mintCompletionMilestones, heldMilestonesIdempotencyKey } from '../../src/invoices/schedule-completion';
import { CreateInvoiceExecutionHandler } from '../../src/proposals/execution/invoice-execution-handler';
import { buildLineItem } from '../../src/shared/billing-engine';
import { ConflictError } from '../../src/shared/errors';

const TENANT = 'tenant-1203';

const DEPOSIT_BALANCE: InvoiceMilestone[] = [
  { label: 'Deposit', type: 'percent', value: 5000, trigger: 'on_accept' },
  { label: 'Balance', type: 'remainder', value: 0, trigger: 'on_completion' },
];
const BOTH_ON_COMPLETION: InvoiceMilestone[] = [
  { label: 'Half', type: 'percent', value: 5000, trigger: 'on_completion' },
  { label: 'Rest', type: 'remainder', value: 0, trigger: 'on_completion' },
];

function settings(overrides: Partial<TenantSettings> = {}): TenantSettings {
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
    milestoneBillingEnabled: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function job(overrides: Partial<Job> = {}): Job {
  return {
    id: uuidv4(),
    tenantId: TENANT,
    customerId: uuidv4(),
    locationId: uuidv4(),
    jobNumber: 'JOB-1',
    summary: 'Water heater',
    status: 'in_progress',
    priority: 'normal',
    depositRequiredCents: 0,
    depositPaidCents: 0,
    depositStatus: 'not_required',
    moneyState: 'estimate_accepted',
    createdBy: 'u1',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe('#1203 milestone-billing guard', () => {
  let scheduleRepo: InMemoryInvoiceScheduleRepository;
  let invoiceRepo: InMemoryInvoiceRepository;
  let settingsRepo: InMemorySettingsRepository;
  let estimateRepo: InMemoryEstimateRepository;
  let jobRepo: InMemoryJobRepository;
  let auditRepo: InMemoryAuditRepository;
  let proposalRepo: InMemoryProposalRepository;

  beforeEach(() => {
    scheduleRepo = new InMemoryInvoiceScheduleRepository();
    invoiceRepo = new InMemoryInvoiceRepository();
    settingsRepo = new InMemorySettingsRepository();
    estimateRepo = new InMemoryEstimateRepository();
    jobRepo = new InMemoryJobRepository();
    auditRepo = new InMemoryAuditRepository();
    proposalRepo = new InMemoryProposalRepository();
  });

  async function seedJob(overrides: Partial<Job> = {}, settingsOverrides: Partial<TenantSettings> = {}) {
    await settingsRepo.create(settings(settingsOverrides));
    const j = await jobRepo.create(job(overrides));
    const created = await createEstimate(
      { tenantId: TENANT, jobId: j.id, estimateNumber: 'EST-1', lineItems: [buildLineItem('e1', 'Water heater', 1, 100000, 0, true)], createdBy: 'u1' },
      estimateRepo,
    );
    const estimate = (await estimateRepo.update(TENANT, created.id, { status: 'accepted' })) as Estimate;
    return { job: j, estimate };
  }

  async function plan(j: Job, estimateId: string | undefined, milestones: InvoiceMilestone[]): Promise<InvoiceSchedule> {
    return scheduleRepo.create(
      buildInvoiceSchedule({ tenantId: TENANT, jobId: j.id, estimateId, totalAmountCents: 100000, milestones, createdBy: 'u1' }),
    );
  }

  async function invoice(
    j: Job,
    number: string,
    totalCents: number,
    extra: { estimateId?: string; scheduleId?: string; milestoneIndex?: number; status?: Invoice['status']; amountPaidCents?: number } = {},
  ): Promise<Invoice> {
    const inv = await createInvoice(
      {
        tenantId: TENANT,
        jobId: j.id,
        estimateId: extra.estimateId,
        invoiceNumber: number,
        lineItems: [buildLineItem(uuidv4(), 'Line', 1, totalCents, 0, true)],
        scheduleId: extra.scheduleId,
        milestoneIndex: extra.milestoneIndex,
        createdBy: 'u1',
      },
      invoiceRepo,
    );
    if (extra.status || extra.amountPaidCents) {
      return (await invoiceRepo.update(TENANT, inv.id, {
        ...(extra.status ? { status: extra.status } : {}),
        ...(extra.amountPaidCents ? { amountPaidCents: extra.amountPaidCents } : {}),
      }))!;
    }
    return inv;
  }

  describe('pure checks', () => {
    it('formats integer cents for owner text', () => {
      expect(formatCentsUsd(100000)).toBe('$1,000.00');
      expect(formatCentsUsd(5)).toBe('$0.05');
    });

    it('canceled never bills; void bills only while it holds a payment', () => {
      expect(invoiceStillBills({ status: 'draft', amountPaidCents: 0 })).toBe(true);
      expect(invoiceStillBills({ status: 'canceled', amountPaidCents: 0 })).toBe(false);
      expect(invoiceStillBills({ status: 'void', amountPaidCents: 0 })).toBe(false);
      expect(invoiceStillBills({ status: 'void', amountPaidCents: 1 })).toBe(true);
    });

    it("a plan's own milestones never count as a whole invoice; another estimate's invoice never matches", async () => {
      const { job: j, estimate } = await seedJob();
      const p = await plan(j, estimate.id, DEPOSIT_BALANCE);
      const own = await invoice(j, 'INV-1', 50000, { estimateId: estimate.id, scheduleId: p.id, milestoneIndex: 0 });
      const other = await invoice(j, 'INV-2', 25000, { estimateId: 'change-order' });
      expect(wholeInvoiceBillingEstimate(estimate.id, [own, other], p.id)).toBeUndefined();
      const whole = await invoice(j, 'INV-3', 100000, { estimateId: estimate.id });
      expect(wholeInvoiceBillingEstimate(estimate.id, [own, other, whole], p.id)?.invoiceNumber).toBe('INV-3');
      expect(wholeInvoiceBillingEstimate(estimate.id, [whole])?.invoiceNumber).toBe('INV-3');
    });

    it('C4 — completion will mint a plan only with milestone billing on and on_completion milestones left', async () => {
      const { job: j, estimate } = await seedJob();
      const p = await plan(j, estimate.id, DEPOSIT_BALANCE);
      expect(completionWillMintPlan(p, [], true)).toBe(true);
      expect(completionWillMintPlan(p, [], false)).toBe(false);
      const balance = await invoice(j, 'INV-2', 50000, { scheduleId: p.id, milestoneIndex: 1 });
      expect(completionWillMintPlan(p, [balance], true)).toBe(false);
    });

    it('a plan bills the estimate while a milestone still bills or completion will still mint it', async () => {
      const { job: j, estimate } = await seedJob();
      const p = await plan(j, estimate.id, DEPOSIT_BALANCE);
      const base = { estimateId: estimate.id, schedules: [p], jobAcceptedEstimateIds: [estimate.id], milestoneBillingEnabled: true, completionStillAhead: true };
      // Nothing minted, completion ahead: it will bill.
      expect(milestonePlanBillingEstimate({ ...base, invoices: [] })?.completionWillMint).toBe(true);
      // Nothing minted, job already complete: nothing will bill → no conflict.
      expect(milestonePlanBillingEstimate({ ...base, invoices: [], completionStillAhead: false })).toBeNull();
      // Nothing minted, milestone billing off → no conflict.
      expect(milestonePlanBillingEstimate({ ...base, invoices: [], milestoneBillingEnabled: false })).toBeNull();
      // A live deposit bills even with billing off; the reason says the rest is not automatic.
      const deposit = await invoice(j, 'INV-0001', 50000, { estimateId: estimate.id, scheduleId: p.id, milestoneIndex: 0 });
      const billing = milestonePlanBillingEstimate({ ...base, invoices: [deposit], milestoneBillingEnabled: false });
      expect(billing?.mintedInvoices.map((i) => i.invoiceNumber)).toEqual(['INV-0001']);
      expect(wholeInvoiceRefusedByPlanReason(billing!)).toBe(
        'This estimate is billed by a milestone plan: INV-0001 ($500.00) so far. A whole-estimate invoice would bill it twice, so none was created. ' +
          "The plan's remaining $500.00 is not invoiced automatically (the job is already complete, or milestone billing is off). Invoice it by hand if it is still owed.",
      );
      // A canceled deposit no longer bills.
      const canceled = { ...deposit, status: 'canceled' as const };
      expect(milestonePlanBillingEstimate({ ...base, invoices: [canceled], milestoneBillingEnabled: false })).toBeNull();
      // No plan for this estimate → never a conflict (C2).
      expect(milestonePlanBillingEstimate({ ...base, estimateId: 'another-estimate', invoices: [] })).toBeNull();
      // …but the canceled deposit still holds the estimate's single link: a whole
      // invoice can never be linked, so the refusal says to invoice by hand.
      expect(wholeInvoiceRefusalReason({ ...base, invoices: [canceled], milestoneBillingEnabled: false })).toBe(
        'This estimate is linked to INV-0001, a canceled invoice from its milestone plan, so no new invoice can be ' +
          'linked to it and none was created. Invoice the remaining balance by hand (without choosing the estimate).',
      );
    });

    it("a plan that recorded no estimate bills the job's single accepted estimate, resolved at check time", async () => {
      const { job: j, estimate } = await seedJob();
      const legacy = await plan(j, undefined, BOTH_ON_COMPLETION);
      expect(planBilledEstimateId(legacy, [estimate.id])).toBe(estimate.id);
      expect(planBilledEstimateId(legacy, [])).toBeUndefined();
      expect(planBilledEstimateId(legacy, ['a', 'b'])).toBeUndefined();
      expect(planBilledEstimateId({ estimateId: 'recorded' }, [estimate.id])).toBe('recorded');
      const check = { estimateId: estimate.id, schedules: [legacy], invoices: [], milestoneBillingEnabled: true, completionStillAhead: true };
      expect(milestonePlanBillingEstimate({ ...check, jobAcceptedEstimateIds: [estimate.id] })?.plan.id).toBe(legacy.id);
      // No accepted estimate on the job: nothing to protect (behaves as main).
      expect(milestonePlanBillingEstimate({ ...check, jobAcceptedEstimateIds: [] })).toBeNull();
    });

    it("the held-milestone draft's summary names the invoice that already bills the estimate", async () => {
      const { job: j, estimate } = await seedJob();
      const whole = await invoice(j, 'INV-0001', 100000, { estimateId: estimate.id });
      expect(
        heldMilestonesSummary(
          [
            { index: 0, label: 'Half', trigger: 'on_completion', amountCents: 50000 },
            { index: 1, label: 'Rest', trigger: 'on_completion', amountCents: 50000 },
          ],
          whole,
        ),
      ).toBe('Milestone invoice held: estimate already billed by INV-0001 (Half, Rest)');
    });
  });

  describe('plan then convert-to-invoice', () => {
    const convertDeps = () => ({ estimateRepo, invoiceRepo, jobRepo, settingsRepo, auditRepo, scheduleRepo, actorId: 'u1' });

    it('refuses while the plan will bill the estimate, and converts once it no longer does', async () => {
      const { job: j, estimate } = await seedJob();
      await plan(j, estimate.id, BOTH_ON_COMPLETION);
      await expect(convertEstimateToInvoice(TENANT, estimate.id, convertDeps())).rejects.toThrow(
        /billed by a milestone plan\. A whole-estimate invoice would bill it twice.*invoices the remaining \$1,000\.00 when the job is completed/,
      );
      expect(await invoiceRepo.findByJob(TENANT, j.id)).toEqual([]);

      await settingsRepo.update(TENANT, { milestoneBillingEnabled: false });
      const converted = await convertEstimateToInvoice(TENANT, estimate.id, convertDeps());
      expect(converted?.totals.totalCents).toBe(100000);
    });

    it("never returns the plan's deposit as if it were the conversion", async () => {
      const { job: j, estimate } = await seedJob();
      const p = await plan(j, estimate.id, DEPOSIT_BALANCE);
      await invoice(j, 'INV-0001', 50000, { estimateId: estimate.id, scheduleId: p.id, milestoneIndex: 0 });
      await expect(convertEstimateToInvoice(TENANT, estimate.id, convertDeps())).rejects.toThrow(/INV-0001 \(\$500\.00\) so far/);
    });

    it('a plan for a different estimate on the job does not block', async () => {
      const { job: j, estimate } = await seedJob();
      await plan(j, 'change-order-estimate', BOTH_ON_COMPLETION);
      expect((await convertEstimateToInvoice(TENANT, estimate.id, convertDeps()))?.estimateId).toBe(estimate.id);
    });

    it("a plan that recorded no estimate blocks converting the job's single accepted estimate", async () => {
      const { job: j, estimate } = await seedJob();
      await plan(j, undefined, BOTH_ON_COMPLETION);
      await expect(convertEstimateToInvoice(TENANT, estimate.id, convertDeps())).rejects.toThrow(/billed by a milestone plan/);
    });

    it('a canceled plan deposit that holds the link is refused before the insert, never returned', async () => {
      const { job: j, estimate } = await seedJob();
      const p = await plan(j, estimate.id, DEPOSIT_BALANCE);
      await invoice(j, 'INV-0001', 50000, { estimateId: estimate.id, scheduleId: p.id, milestoneIndex: 0, status: 'canceled' });
      await settingsRepo.update(TENANT, { milestoneBillingEnabled: false });
      await expect(convertEstimateToInvoice(TENANT, estimate.id, convertDeps())).rejects.toThrow(
        /linked to INV-0001, a canceled invoice from its milestone plan/,
      );
      expect((await invoiceRepo.findByJob(TENANT, j.id)).map((i) => i.invoiceNumber)).toEqual(['INV-0001']);
    });

    it('a uq_invoices_estimate collision never returns a milestone or non-billing invoice as the conversion', async () => {
      // No schedule repo wired (so no pre-check), a canceled milestone holding the
      // link, and the insert rejected the way Postgres's unique index rejects it.
      const { job: j, estimate } = await seedJob();
      await invoice(j, 'INV-0001', 50000, { estimateId: estimate.id, scheduleId: 'plan-1', milestoneIndex: 0, status: 'canceled' });
      invoiceRepo.create = async () => {
        throw Object.assign(new Error('duplicate key value violates unique constraint "uq_invoices_estimate"'), {
          code: '23505',
          constraint: 'uq_invoices_estimate',
        });
      };
      const { scheduleRepo: _omit, ...noScheduleDeps } = convertDeps();
      const attempt = convertEstimateToInvoice(TENANT, estimate.id, noScheduleDeps);
      await expect(attempt).rejects.toBeInstanceOf(ConflictError);
      await expect(convertEstimateToInvoice(TENANT, estimate.id, noScheduleDeps)).rejects.toThrow(
        /linked to INV-0001, a canceled invoice from its milestone plan/,
      );
    });
  });

  describe('plan then draft_invoice', () => {
    const draft = (j: Job, estimateId: string): Proposal => ({
      id: uuidv4(),
      tenantId: TENANT,
      proposalType: 'draft_invoice',
      status: 'approved',
      payload: {
        customerId: j.customerId,
        jobId: j.id,
        estimateId,
        lineItems: [{ description: 'Water heater', quantity: 1, unitPriceCents: 100000 }],
      },
      summary: 'Draft invoice for completed job',
      createdBy: 'system:auto_invoice',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const handler = () =>
      new CreateInvoiceExecutionHandler(invoiceRepo, settingsRepo, auditRepo, jobRepo, undefined, undefined, scheduleRepo, estimateRepo);

    it('refuses a whole-estimate draft when the plan has a live milestone, and names what is unbilled', async () => {
      const { job: j, estimate } = await seedJob({ status: 'completed' });
      const p = await plan(j, estimate.id, DEPOSIT_BALANCE);
      await invoice(j, 'INV-0001', 50000, { estimateId: estimate.id, scheduleId: p.id, milestoneIndex: 0 });
      const result = await handler().execute(draft(j, estimate.id), { tenantId: TENANT, executedBy: 'owner-1' });
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/INV-0001 \(\$500\.00\) so far.*remaining \$500\.00 is not invoiced automatically/);
      expect(await invoiceRepo.findByJob(TENANT, j.id)).toHaveLength(1);
    });

    it("refuses a whole-estimate draft when a plan that recorded no estimate bills the job's accepted estimate", async () => {
      const { job: j, estimate } = await seedJob();
      await plan(j, undefined, BOTH_ON_COMPLETION);
      const result = await handler().execute(draft(j, estimate.id), { tenantId: TENANT, executedBy: 'owner-1' });
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/invoices the remaining \$1,000\.00 when the job is completed/);
    });

    it('lets the draft through when the plan will bill nothing (milestone billing off, nothing minted)', async () => {
      const { job: j, estimate } = await seedJob({ status: 'completed' }, { milestoneBillingEnabled: false });
      await plan(j, estimate.id, BOTH_ON_COMPLETION);
      const result = await handler().execute(draft(j, estimate.id), { tenantId: TENANT, executedBy: 'owner-1' });
      expect(result.success).toBe(true);
    });
  });

  describe('auto-invoice on completion (C4)', () => {
    const autoDeps = () => ({ estimateRepo, invoiceRepo, proposalRepo, settingsRepo, auditRepo, scheduleRepo });

    it('yields to a plan completion is about to mint', async () => {
      const { job: j, estimate } = await seedJob({ status: 'completed' }, { autoInvoiceOnCompletion: true });
      await plan(j, estimate.id, BOTH_ON_COMPLETION);
      expect(await maybeAutoInvoiceOnCompletion(autoDeps(), j)).toBeNull();
    });

    it('never yields while milestone billing is off', async () => {
      const { job: j, estimate } = await seedJob({ status: 'completed' }, { autoInvoiceOnCompletion: true, milestoneBillingEnabled: false });
      await plan(j, estimate.id, BOTH_ON_COMPLETION);
      const draft = await maybeAutoInvoiceOnCompletion(autoDeps(), j);
      expect(draft?.payload.estimateId).toBe(estimate.id);
    });

    it("yields to a plan that recorded no estimate: it bills the job's single accepted estimate", async () => {
      const { job: j } = await seedJob({ status: 'completed' }, { autoInvoiceOnCompletion: true });
      await plan(j, undefined, BOTH_ON_COMPLETION);
      expect(await maybeAutoInvoiceOnCompletion(autoDeps(), j)).toBeNull();
    });
  });

  describe('completion holds milestones instead of dropping them (C1)', () => {
    const mintDeps = () => ({ scheduleRepo, invoiceRepo, settingsRepo, auditRepo, proposalRepo, estimateRepo });

    it('raises one ready_for_review draft with the held milestones and why; mints nothing on top', async () => {
      const { job: j, estimate } = await seedJob({ status: 'completed' });
      const p = await plan(j, estimate.id, BOTH_ON_COMPLETION);
      await invoice(j, 'INV-0001', 100000, { estimateId: estimate.id });

      expect(await mintCompletionMilestones(mintDeps(), j)).toEqual([]);
      expect(await invoiceRepo.findByJob(TENANT, j.id)).toHaveLength(1);

      const [held] = await proposalRepo.findByStatus(TENANT, 'ready_for_review');
      expect(held.proposalType).toBe('draft_invoice');
      expect(held.summary).toBe('Milestone invoice held: estimate already billed by INV-0001 (Half, Rest)');
      expect(held.idempotencyKey).toBe(heldMilestonesIdempotencyKey(p.id));
      expect(held.payload.estimateId).toBeUndefined();
      expect((held.payload.lineItems as Array<{ description: string; totalCents: number }>).map((l) => [l.description, l.totalCents])).toEqual([
        ['Half', 50000],
        ['Rest', 50000],
      ]);
      expect(held.explanation).toBe(
        'Completing the job would have invoiced Half ($500.00), Rest ($500.00) from the milestone plan, but INV-0001 ($1,000.00) ' +
          'already bills that estimate. No milestone invoice was created. Reject this if INV-0001 covers the work; approve it to invoice the milestones anyway.',
      );
      const audit = (await auditRepo.findByEntity(TENANT, 'job', j.id)).filter((e) => e.eventType === 'invoice.milestone_mint_held');
      expect(audit).toHaveLength(1);
      expect(audit[0].metadata).toMatchObject({ scheduleId: p.id, proposalId: held.id, amountCents: 100000, blockingInvoiceNumber: 'INV-0001' });

      // Idempotent: a second run raises nothing new.
      await mintCompletionMilestones(mintDeps(), j);
      expect(await proposalRepo.findByStatus(TENANT, 'ready_for_review')).toHaveLength(1);
    });

    it('a void blocker holding a payment points to invoicing the balance by hand; a canceled one does not block at all', async () => {
      const { job: j, estimate } = await seedJob({ status: 'completed' });
      await plan(j, estimate.id, BOTH_ON_COMPLETION);
      await invoice(j, 'INV-0001', 100000, { estimateId: estimate.id, status: 'void', amountPaidCents: 20000 });
      await mintCompletionMilestones(mintDeps(), j);
      const [held] = await proposalRepo.findByStatus(TENANT, 'ready_for_review');
      expect(held.explanation).toMatch(/already has a paid voided invoice \(INV-0001, \$200\.00 paid\).*invoice the remaining balance by hand/);

      const other = await seedJob({ status: 'completed' });
      await plan(other.job, other.estimate.id, BOTH_ON_COMPLETION);
      await invoice(other.job, 'INV-0009', 100000, { estimateId: other.estimate.id, status: 'canceled' });
      expect(await mintCompletionMilestones(mintDeps(), other.job)).toHaveLength(2);
    });

    it("fails loudly (no silent drop, no double bill) when there is nowhere to raise the owner's draft", async () => {
      const { job: j, estimate } = await seedJob({ status: 'completed' });
      await plan(j, estimate.id, BOTH_ON_COMPLETION);
      await invoice(j, 'INV-0001', 100000, { estimateId: estimate.id });
      await expect(mintCompletionMilestones({ scheduleRepo, invoiceRepo, settingsRepo, auditRepo }, j)).rejects.toThrow(
        /INV-0001 \(\$1,000\.00\) already bills that estimate/,
      );
      expect(await invoiceRepo.findByJob(TENANT, j.id)).toHaveLength(1);
    });

    it("a plan that recorded no estimate is held when a whole invoice bills the job's single accepted estimate", async () => {
      const { job: j, estimate } = await seedJob({ status: 'completed' });
      const legacy = await plan(j, undefined, BOTH_ON_COMPLETION);
      await invoice(j, 'INV-0001', 100000, { estimateId: estimate.id });
      expect(await mintCompletionMilestones(mintDeps(), j)).toEqual([]);
      const [held] = await proposalRepo.findByStatus(TENANT, 'ready_for_review');
      expect(held.idempotencyKey).toBe(heldMilestonesIdempotencyKey(legacy.id));
    });

    it('a plan that recorded no estimate, on a job with no accepted estimate, mints exactly as before', async () => {
      const { job: j, estimate } = await seedJob({ status: 'completed' });
      await estimateRepo.update(TENANT, estimate.id, { status: 'sent' });
      await plan(j, undefined, BOTH_ON_COMPLETION);
      await invoice(j, 'INV-0001', 100000, { estimateId: estimate.id });
      expect((await mintCompletionMilestones(mintDeps(), j)).map((i) => i.totals.totalCents)).toEqual([50000, 50000]);
    });
  });
});
