import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { PgInvoiceRepository } from '../../src/invoices/pg-invoice';
import { PgInvoiceScheduleRepository } from '../../src/invoices/pg-invoice-schedule';
import { PgSettingsRepository } from '../../src/settings/pg-settings';
import { PgEstimateRepository } from '../../src/estimates/pg-estimate';
import { PgJobRepository } from '../../src/jobs/pg-job';
import { PgCustomerRepository } from '../../src/customers/pg-customer';
import { PgLocationRepository } from '../../src/locations/pg-location';
import { PgAuditRepository } from '../../src/audit/pg-audit';
import { PgProposalRepository } from '../../src/proposals/pg-proposal';
import { PgPaymentRepository } from '../../src/invoices/pg-payment';
import { createInvoiceWithNextNumber, issueInvoice, transitionInvoiceStatus } from '../../src/invoices/invoice';
import { recordPayment } from '../../src/invoices/payment';
import { buildInvoiceSchedule, MILESTONE_UNIQUE_INDEX } from '../../src/invoices/invoice-schedule';
import { mintCompletionMilestones } from '../../src/invoices/schedule-completion';
import { convertEstimateToInvoice } from '../../src/invoices/convert-estimate';
import { CreateInvoiceScheduleTaskHandler } from '../../src/ai/tasks/voice-extended-tasks';
import { runJobCompletionEffects } from '../../src/jobs/completion-effects';
import { createProposal, Proposal } from '../../src/proposals/proposal';
import { transitionProposal, UNDO_WINDOW_MS } from '../../src/proposals/lifecycle';
import { InMemoryProposalExecutionRepository } from '../../src/proposals/proposal-execution';
import { ProposalExecutor } from '../../src/proposals/execution/executor';
import { IdempotencyGuard } from '../../src/proposals/execution/idempotency';
import { createExecutionHandlerRegistry, ExecutionResult } from '../../src/proposals/execution/handlers';
import { buildLineItem, calculateDocumentTotals } from '../../src/shared/billing-engine';
import { Job } from '../../src/jobs/job';

/**
 * Pins the real Postgres indexes behind milestone billing. Before the fix, a
 * 50% deposit / 50% balance schedule that referenced an estimate billed ONLY
 * the deposit: the balance INSERT tripped uq_invoices_estimate and the
 * completion hook swallowed every 23505 as "already minted". In-memory repos
 * never raise the index, so only this test proves the balance is billed.
 */
describe('Postgres integration — milestone billing against an estimate', () => {
  let pool: Pool;
  let invoiceRepo: PgInvoiceRepository;
  let scheduleRepo: PgInvoiceScheduleRepository;
  let settingsRepo: PgSettingsRepository;
  let tenant: { tenantId: string; userId: string };
  let job: Job;
  let estimateId: string;

  beforeAll(async () => {
    pool = await getSharedTestDb();
    invoiceRepo = new PgInvoiceRepository(pool);
    scheduleRepo = new PgInvoiceScheduleRepository(pool);
    settingsRepo = new PgSettingsRepository(pool);
    const estimateRepo = new PgEstimateRepository(pool);
    const jobRepo = new PgJobRepository(pool);
    const customerRepo = new PgCustomerRepository(pool);
    const locationRepo = new PgLocationRepository(pool);
    tenant = await createTestTenant(pool);

    await settingsRepo.create({
      id: crypto.randomUUID(),
      tenantId: tenant.tenantId,
      businessName: 'Milestone Co',
      timezone: 'UTC',
      estimatePrefix: 'EST-',
      invoicePrefix: 'INV-',
      nextEstimateNumber: 1,
      nextInvoiceNumber: 1,
      defaultPaymentTermDays: 30,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    // Opt-in kill switch (migration 26x): create() does not persist it, update() does.
    await settingsRepo.update(tenant.tenantId, { milestoneBillingEnabled: true });

    const customerId = crypto.randomUUID();
    await customerRepo.create({
      id: customerId,
      tenantId: tenant.tenantId,
      firstName: 'Mila',
      lastName: 'Stone',
      displayName: 'Mila Stone',
      preferredChannel: 'phone',
      smsConsent: false,
      isArchived: false,
      createdBy: tenant.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const locationId = crypto.randomUUID();
    await locationRepo.create({
      id: locationId,
      tenantId: tenant.tenantId,
      customerId,
      street1: '1 Deposit Way',
      city: 'Austin',
      state: 'TX',
      postalCode: '78701',
      country: 'USA',
      isPrimary: true,
      isArchived: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    job = await jobRepo.create({
      id: crypto.randomUUID(),
      tenantId: tenant.tenantId,
      customerId,
      locationId,
      jobNumber: 'JOB-MS-1',
      summary: 'Roof replacement',
      status: 'completed',
      priority: 'normal',
      depositRequiredCents: 0,
      depositPaidCents: 0,
      depositStatus: 'not_required',
      createdBy: tenant.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const items = [buildLineItem(crypto.randomUUID(), 'Roof', 1, 100000, 0, true, 'labor')];
    estimateId = crypto.randomUUID();
    await estimateRepo.create({
      id: estimateId,
      tenantId: tenant.tenantId,
      jobId: job.id,
      estimateNumber: 'EST-MS-1',
      status: 'accepted',
      lineItems: items,
      totals: calculateDocumentTotals(items, 0, 0),
      version: 1,
      createdBy: tenant.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  it('both unique indexes the mint paths reason about exist with the expected names', async () => {
    const { rows } = await pool.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE tablename = 'invoices' AND indexname = ANY($1)`,
      [['uq_invoices_estimate', MILESTONE_UNIQUE_INDEX]],
    );
    expect(rows.map((r) => r.indexname).sort()).toEqual(['uq_invoices_estimate', MILESTONE_UNIQUE_INDEX].sort());
  });

  it('bills the on_completion balance when the deposit already links the estimate', async () => {
    const schedule = buildInvoiceSchedule({
      tenantId: tenant.tenantId,
      jobId: job.id,
      estimateId,
      totalAmountCents: 100000,
      milestones: [
        { label: 'Deposit', type: 'percent', value: 5000, trigger: 'on_accept' },
        { label: 'Balance', type: 'remainder', value: 0, trigger: 'on_completion' },
      ],
      createdBy: tenant.userId,
    });
    await scheduleRepo.create(schedule);

    // The deposit minted at schedule approval carries the estimate link.
    const deposit = await createInvoiceWithNextNumber(
      {
        tenantId: tenant.tenantId,
        jobId: job.id,
        estimateId,
        lineItems: [buildLineItem(crypto.randomUUID(), 'Deposit', 1, 50000, 0, true)],
        createdBy: tenant.userId,
        scheduleId: schedule.id,
        milestoneIndex: 0,
      },
      invoiceRepo,
      settingsRepo,
    );
    expect(deposit.estimateId).toBe(estimateId);

    const created = await mintCompletionMilestones({ scheduleRepo, invoiceRepo, settingsRepo }, job);
    expect(created).toHaveLength(1);
    expect(created[0].scheduleId).toBe(schedule.id);
    expect(created[0].milestoneIndex).toBe(1);
    expect(created[0].totals.totalCents).toBe(50000);
    expect(created[0].estimateId).toBeUndefined();

    const { rows } = await pool.query<{ milestone_index: number; estimate_id: string | null; total_cents: number }>(
      `SELECT milestone_index, estimate_id, total_cents FROM invoices
        WHERE tenant_id = $1 AND schedule_id = $2 ORDER BY milestone_index`,
      [tenant.tenantId, schedule.id],
    );
    expect(rows).toEqual([
      { milestone_index: 0, estimate_id: estimateId, total_cents: 50000 },
      { milestone_index: 1, estimate_id: null, total_cents: 50000 },
    ]);

    // Re-running completion mints nothing further (idempotent on the real index).
    const again = await mintCompletionMilestones({ scheduleRepo, invoiceRepo, settingsRepo }, job);
    expect(again).toHaveLength(0);
  });


  /**
   * #1203 — an estimate that was already invoiced must never also be billed by
   * a milestone plan. #975 made milestoneEstimateLink treat ANY invoice
   * carrying the estimate id as "the first milestone holds the link", so both
   * mint paths drafted every milestone without it: $1,000 converted + $500
   * deposit + $500 balance = $2,000 of drafts for a $1,000 estimate. Before
   * #975 the uq_invoices_estimate collision blocked it by accident.
   *
   * Every plan here is created the way production creates one: the REAL voice
   * task handler (CreateInvoiceScheduleTaskHandler — its payload carries jobId,
   * jobReference, scheduleDescription, milestones and totalAmountCents, never
   * an estimateId), approved and run through the PRODUCTION execution registry
   * + ProposalExecutor, and billed at completion by the REAL
   * runJobCompletionEffects (auto-invoice first, then milestone minting).
   * Conversion is the real convertEstimateToInvoice the estimate route runs.
   */
  describe('#1203 — never bill an estimate twice (voice plan, real completion effects)', () => {
    let estimateRepo: PgEstimateRepository;
    let jobRepo: PgJobRepository;
    let customerRepo: PgCustomerRepository;
    let locationRepo: PgLocationRepository;
    let auditRepo: PgAuditRepository;
    let proposalRepo: PgProposalRepository;
    let paymentRepo: PgPaymentRepository;
    let executor: ProposalExecutor;

    const DEPOSIT_THEN_BALANCE = '50% deposit, 50% on completion';
    const BOTH_ON_COMPLETION = 'half on completion, the rest when done';

    interface Seeded {
      tag: string;
      tenantId: string;
      userId: string;
      customerId: string;
      locationId: string;
      job: Job;
      estimateId: string;
    }

    interface InvoiceRow {
      invoice_number: string;
      status: string;
      estimate_id: string | null;
      schedule_id: string | null;
      milestone_index: number | null;
      total_cents: number;
    }

    const silentLogger = { error: () => undefined };

    async function seedJobWithEstimate(
      s: Pick<Seeded, 'tenantId' | 'userId' | 'customerId' | 'locationId'>,
      tag: string,
      amountCents: number,
    ): Promise<{ job: Job; estimateId: string }> {
      const now = new Date();
      const job = await jobRepo.create({
        id: crypto.randomUUID(),
        tenantId: s.tenantId,
        customerId: s.customerId,
        locationId: s.locationId,
        jobNumber: `JOB-1203-${tag}`,
        summary: 'Water heater swap',
        status: 'completed',
        priority: 'normal',
        depositRequiredCents: 0,
        depositPaidCents: 0,
        depositStatus: 'not_required',
        createdBy: s.userId,
        createdAt: now,
        updatedAt: now,
      });
      const items = [buildLineItem(crypto.randomUUID(), 'Water heater', 1, amountCents, 0, true, 'labor')];
      const estimateId = crypto.randomUUID();
      await estimateRepo.create({
        id: estimateId,
        tenantId: s.tenantId,
        jobId: job.id,
        estimateNumber: `EST-1203-${tag}`,
        status: 'accepted',
        lineItems: items,
        totals: calculateDocumentTotals(items, 0, 0),
        version: 1,
        createdBy: s.userId,
        createdAt: now,
        updatedAt: now,
      });
      return { job, estimateId };
    }

    /** A fresh tenant (milestone billing on), a completed job and its ACCEPTED estimate. */
    async function seed(
      tag: string,
      amountCents: number,
      opts: { autoInvoiceOnCompletion?: boolean } = {},
    ): Promise<Seeded> {
      const { tenantId, userId } = await createTestTenant(pool);
      const now = new Date();
      await settingsRepo.create({
        id: crypto.randomUUID(),
        tenantId,
        businessName: `Milestone ${tag}`,
        timezone: 'UTC',
        estimatePrefix: 'EST-',
        invoicePrefix: 'INV-',
        nextEstimateNumber: 1,
        nextInvoiceNumber: 1,
        defaultPaymentTermDays: 30,
        createdAt: now,
        updatedAt: now,
      });
      await settingsRepo.update(tenantId, {
        milestoneBillingEnabled: true,
        autoInvoiceOnCompletion: opts.autoInvoiceOnCompletion ?? false,
      });
      const customerId = crypto.randomUUID();
      await customerRepo.create({
        id: customerId,
        tenantId,
        firstName: 'Dee',
        lastName: tag,
        displayName: `Dee ${tag}`,
        preferredChannel: 'phone',
        smsConsent: false,
        isArchived: false,
        createdBy: userId,
        createdAt: now,
        updatedAt: now,
      });
      const locationId = crypto.randomUUID();
      await locationRepo.create({
        id: locationId,
        tenantId,
        customerId,
        street1: '1203 Double Bill Ln',
        city: 'Austin',
        state: 'TX',
        postalCode: '78701',
        country: 'USA',
        addressType: 'service',
        isPrimary: true,
        isArchived: false,
        createdAt: now,
        updatedAt: now,
      });
      const base = { tenantId, userId, customerId, locationId };
      const { job, estimateId } = await seedJobWithEstimate(base, tag, amountCents);
      return { tag, ...base, job, estimateId };
    }

    /** POST /estimates/:id/convert-to-invoice's domain call. */
    async function convert(s: Seeded) {
      const invoice = await convertEstimateToInvoice(s.tenantId, s.estimateId, {
        estimateRepo,
        invoiceRepo,
        jobRepo,
        settingsRepo,
        auditRepo,
        actorId: s.userId,
      });
      expect(invoice).not.toBeNull();
      return invoice!;
    }

    /** "Set up <plan> for the <tag> job", through the REAL voice task handler. */
    async function voicePlan(s: Seeded, sentence: string, amountCents: number): Promise<Proposal> {
      const { proposal } = await new CreateInvoiceScheduleTaskHandler().handle({
        tenantId: s.tenantId,
        userId: s.userId,
        message: `Set up ${sentence} for the ${s.tag} job, ${amountCents / 100} dollars`,
        existingEntities: {
          jobReference: `the ${s.tag} job`,
          jobId: s.job.id, // router-resolved (P8 annotation seam)
          scheduleDescription: sentence,
          amount: amountCents,
        },
      });
      expect(proposal.proposalType).toBe('create_invoice_schedule');
      // The production payload shape: no estimate id anywhere.
      expect(proposal.payload).not.toHaveProperty('estimateId');
      return proposal;
    }

    /** The owner approves; the proposal runs through the production registry + executor. */
    async function approveAndExecute(s: Seeded, proposal: Proposal): Promise<ExecutionResult> {
      let approved = proposal;
      if (approved.status === 'draft') approved = transitionProposal(approved, 'ready_for_review', s.userId);
      approved = transitionProposal(approved, 'approved', s.userId);
      // Backdate past the 5-second undo window so the executor runs now.
      approved = { ...approved, approvedAt: new Date(Date.now() - UNDO_WINDOW_MS - 100) };
      if (await proposalRepo.findById(s.tenantId, approved.id)) {
        await proposalRepo.updateStatus(s.tenantId, approved.id, 'approved', { approvedAt: approved.approvedAt });
      } else {
        await proposalRepo.create(approved);
      }
      const { result } = await executor.execute(approved, { tenantId: s.tenantId, executedBy: s.userId });
      return result;
    }

    /** The owner approves every invoice draft waiting in the inbox for this job. */
    async function approveWaitingInvoiceDrafts(s: Seeded): Promise<void> {
      const waiting = [
        ...(await proposalRepo.findByStatus(s.tenantId, 'draft')),
        ...(await proposalRepo.findByStatus(s.tenantId, 'ready_for_review')),
      ].filter((p) => p.proposalType === 'draft_invoice' && p.payload.jobId === s.job.id);
      for (const draft of waiting) {
        expect((await approveAndExecute(s, draft)).success).toBe(true);
      }
    }

    /** The job is marked complete: the REAL completion effects run. */
    function completeJob(s: Seeded, logger: { error: (message: string, meta?: Record<string, unknown>) => void } = silentLogger) {
      return runJobCompletionEffects(
        { estimateRepo, invoiceRepo, proposalRepo, settingsRepo, auditRepo, scheduleRepo },
        s.job,
        logger,
      );
    }

    /** Every invoice on the job, straight out of Postgres. */
    async function invoiceRows(s: Seeded, jobId = s.job.id): Promise<InvoiceRow[]> {
      const { rows } = await pool.query<InvoiceRow>(
        `SELECT invoice_number, status, estimate_id, schedule_id, milestone_index, total_cents::int AS total_cents
           FROM invoices WHERE tenant_id = $1 AND job_id = $2 ORDER BY invoice_number`,
        [s.tenantId, jobId],
      );
      return rows;
    }

    const billed = (rows: InvoiceRow[]) =>
      rows.filter((r) => r.status !== 'canceled' && r.status !== 'void').reduce((sum, r) => sum + r.total_cents, 0);

    beforeAll(() => {
      estimateRepo = new PgEstimateRepository(pool);
      jobRepo = new PgJobRepository(pool);
      customerRepo = new PgCustomerRepository(pool);
      locationRepo = new PgLocationRepository(pool);
      auditRepo = new PgAuditRepository(pool);
      proposalRepo = new PgProposalRepository(pool);
      paymentRepo = new PgPaymentRepository(pool);
      const registry = createExecutionHandlerRegistry({
        customerRepo,
        jobRepo,
        locationRepo,
        invoiceRepo,
        estimateRepo,
        settingsRepo,
        scheduleRepo,
        proposalRepo,
        auditRepo,
      });
      const guard = new IdempotencyGuard(new InMemoryProposalExecutionRepository(), proposalRepo);
      executor = new ProposalExecutor(registry, proposalRepo, guard, auditRepo);
    });

    it('a voice plan for a converted estimate is refused at approval: no schedule row, only the converted invoice, even after completion', async () => {
      const s = await seed('A-CONVERTED', 100000);
      const converted = await convert(s);
      expect(converted.estimateId).toBe(s.estimateId);

      const result = await approveAndExecute(s, await voicePlan(s, DEPOSIT_THEN_BALANCE, 100000));
      await completeJob(s);

      // Only the converted $1,000 invoice: no $500 deposit + $500 balance on top.
      expect(await invoiceRows(s)).toEqual([
        { invoice_number: 'INV-0001', status: 'draft', estimate_id: s.estimateId, schedule_id: null, milestone_index: null, total_cents: 100000 },
      ]);
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/already invoiced as INV-0001/);
      expect(await scheduleRepo.findByJob(s.tenantId, s.job.id)).toEqual([]);
    });

    it('auto-invoice on completion and a milestone plan never both bill the job', async () => {
      const s = await seed('B-AUTO-INVOICE', 100000, { autoInvoiceOnCompletion: true });
      const approved = await approveAndExecute(s, await voicePlan(s, BOTH_ON_COMPLETION, 100000));
      expect(approved.success).toBe(true);
      expect(await invoiceRows(s)).toEqual([]);

      await completeJob(s);
      await approveWaitingInvoiceDrafts(s);

      // The plan bills the job; auto-invoice raised no whole-estimate draft.
      const rows = await invoiceRows(s);
      expect(rows.map((r) => [r.schedule_id, r.milestone_index, r.total_cents])).toEqual([
        [approved.resultEntityId, 0, 50000],
        [approved.resultEntityId, 1, 50000],
      ]);
      expect(billed(rows)).toBe(100000);
      expect(await proposalRepo.findByIdempotencyKey(s.tenantId, `auto_invoice:${s.job.id}`)).toBeNull();
    });

    it('an invoice auto-drafted at completion blocks a milestone plan approved afterwards', async () => {
      const s = await seed('C-AUTO-DRAFT-WAITING', 100000, { autoInvoiceOnCompletion: true });
      await completeJob(s); // no plan yet: auto-invoice raises the $1,000 draft for review
      expect(await proposalRepo.findByIdempotencyKey(s.tenantId, `auto_invoice:${s.job.id}`)).not.toBeNull();

      const result = await approveAndExecute(s, await voicePlan(s, DEPOSIT_THEN_BALANCE, 100000));
      await approveWaitingInvoiceDrafts(s);

      expect(await invoiceRows(s)).toEqual([
        { invoice_number: 'INV-0001', status: 'draft', estimate_id: s.estimateId, schedule_id: null, milestone_index: null, total_cents: 100000 },
      ]);
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/auto-drafted/i);
      expect(await scheduleRepo.findByJob(s.tenantId, s.job.id)).toEqual([]);
    });

    it('a plan approved before the conversion refuses to mint its balance at completion, and the owner sees why', async () => {
      const s = await seed('D-PLAN-THEN-CONVERT', 100000);
      const approved = await approveAndExecute(s, await voicePlan(s, DEPOSIT_THEN_BALANCE, 100000));
      expect(approved.success).toBe(true);
      await convert(s);

      const errors: Array<{ message: string; meta?: Record<string, unknown> }> = [];
      await completeJob(s, { error: (message, meta) => errors.push({ message, meta }) });

      expect(await invoiceRows(s)).toEqual([
        { invoice_number: 'INV-0001', status: 'draft', estimate_id: null, schedule_id: approved.resultEntityId, milestone_index: 0, total_cents: 50000 },
        { invoice_number: 'INV-0002', status: 'draft', estimate_id: s.estimateId, schedule_id: null, milestone_index: null, total_cents: 100000 },
      ]);
      // Owner-visible: an audit row the activity feed shows, not only a log line.
      const refused = (await auditRepo.findByEntity(s.tenantId, 'job', s.job.id)).filter(
        (e) => e.eventType === 'invoice.milestone_mint_refused',
      );
      expect(refused).toHaveLength(1);
      expect(refused[0].metadata).toMatchObject({ scheduleId: approved.resultEntityId, blockingInvoiceNumber: 'INV-0002' });
      expect(String(refused[0].metadata?.reason)).toMatch(/already invoiced as INV-0002/);
      expect(errors.map((e) => e.message)).toEqual(['schedule completion milestone minting failed']);

      // Re-completing still mints nothing over the converted invoice.
      await completeJob(s);
      expect(await invoiceRows(s)).toHaveLength(2);
    });

    it('a canceled converted draft, or a void converted invoice with no payment, does not block the plan', async () => {
      const canceled = await seed('E1-CANCELED', 100000);
      const c1 = await convert(canceled);
      await transitionInvoiceStatus(canceled.tenantId, c1.id, 'canceled', invoiceRepo);
      const p1 = await approveAndExecute(canceled, await voicePlan(canceled, DEPOSIT_THEN_BALANCE, 100000));
      await completeJob(canceled);

      const voided = await seed('E2-VOID-UNPAID', 100000);
      const c2 = await convert(voided);
      await issueInvoice(voided.tenantId, c2.id, 30, invoiceRepo);
      await transitionInvoiceStatus(voided.tenantId, c2.id, 'void', invoiceRepo);
      const p2 = await approveAndExecute(voided, await voicePlan(voided, DEPOSIT_THEN_BALANCE, 100000));
      await completeJob(voided);

      for (const [s, p, deadStatus] of [[canceled, p1, 'canceled'], [voided, p2, 'void']] as const) {
        expect(p.success).toBe(true);
        const rows = await invoiceRows(s);
        expect(rows.map((r) => [r.status, r.schedule_id, r.milestone_index, r.total_cents])).toEqual([
          [deadStatus, null, null, 100000],
          ['draft', p.resultEntityId, 0, 50000],
          ['draft', p.resultEntityId, 1, 50000],
        ]);
        expect(billed(rows)).toBe(100000);
      }
    });

    it('a void converted invoice that carries a payment still blocks the plan', async () => {
      const s = await seed('F-VOID-PAID', 100000);
      const converted = await convert(s);
      await issueInvoice(s.tenantId, converted.id, 30, invoiceRepo);
      await recordPayment(
        { tenantId: s.tenantId, invoiceId: converted.id, amountCents: 20000, method: 'cash', processedBy: s.userId },
        invoiceRepo,
        paymentRepo,
      );
      await transitionInvoiceStatus(s.tenantId, converted.id, 'void', invoiceRepo);

      const result = await approveAndExecute(s, await voicePlan(s, DEPOSIT_THEN_BALANCE, 100000));
      await completeJob(s);

      expect(await invoiceRows(s)).toEqual([
        { invoice_number: 'INV-0001', status: 'void', estimate_id: s.estimateId, schedule_id: null, milestone_index: null, total_cents: 100000 },
      ]);
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/already invoiced as INV-0001/);
    });

    it('a normal estimate with no prior invoice still mints every milestone exactly as before (voice plan, and an explicit-estimate plan whose first milestone carries estimate_id)', async () => {
      const voice = await seed('G1-NORMAL-VOICE', 100000);
      const v = await approveAndExecute(voice, await voicePlan(voice, DEPOSIT_THEN_BALANCE, 100000));
      await completeJob(voice);
      expect(v.success).toBe(true);
      expect(await invoiceRows(voice)).toEqual([
        { invoice_number: 'INV-0001', status: 'draft', estimate_id: null, schedule_id: v.resultEntityId, milestone_index: 0, total_cents: 50000 },
        { invoice_number: 'INV-0002', status: 'draft', estimate_id: null, schedule_id: v.resultEntityId, milestone_index: 1, total_cents: 50000 },
      ]);

      // The contract also accepts an explicit estimateId (total derived from the estimate).
      const explicit = await seed('G2-NORMAL-EXPLICIT', 100000);
      const proposal = createProposal({
        tenantId: explicit.tenantId,
        proposalType: 'create_invoice_schedule',
        payload: {
          jobId: explicit.job.id,
          estimateId: explicit.estimateId,
          milestones: (await voicePlan(explicit, DEPOSIT_THEN_BALANCE, 100000)).payload.milestones,
        },
        summary: 'Bill in stages',
        createdBy: explicit.userId,
      });
      const e = await approveAndExecute(explicit, proposal);
      await completeJob(explicit);
      expect(e.success).toBe(true);
      const rows = await invoiceRows(explicit);
      expect(rows).toEqual([
        { invoice_number: 'INV-0001', status: 'draft', estimate_id: explicit.estimateId, schedule_id: e.resultEntityId, milestone_index: 0, total_cents: 50000 },
        { invoice_number: 'INV-0002', status: 'draft', estimate_id: null, schedule_id: e.resultEntityId, milestone_index: 1, total_cents: 50000 },
      ]);
      // The schedule's OWN deposit carries the estimate id: re-completion is not
      // "invoiced outside the schedule" and mints nothing more.
      await completeJob(explicit);
      expect(await invoiceRows(explicit)).toEqual(rows);
    });

    it("refuses a plan whose estimateId belongs to a different job of the same tenant", async () => {
      const s = await seed('H-MISMATCH', 100000);
      const other = await seedJobWithEstimate(s, 'H-OTHER-JOB', 70000);
      const proposal = createProposal({
        tenantId: s.tenantId,
        proposalType: 'create_invoice_schedule',
        payload: {
          jobId: s.job.id,
          estimateId: other.estimateId,
          milestones: (await voicePlan(s, DEPOSIT_THEN_BALANCE, 100000)).payload.milestones,
        },
        summary: 'Bill in stages',
        createdBy: s.userId,
      });
      const result = await approveAndExecute(s, proposal);

      expect(await invoiceRows(s)).toEqual([]);
      expect(await invoiceRows(s, other.job.id)).toEqual([]);
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/different job/i);
      expect(await scheduleRepo.findByJob(s.tenantId, s.job.id)).toEqual([]);
    });

    it("T1 — tenant B bills its own plan in the same run and is untouched by tenant A's refusal", async () => {
      const tenantB = await seed('T1-B-NEIGHBOUR', 240000);
      const b = await approveAndExecute(tenantB, await voicePlan(tenantB, DEPOSIT_THEN_BALANCE, 240000));
      await completeJob(tenantB);
      const bBefore = await invoiceRows(tenantB);
      expect(bBefore.map((r) => [r.schedule_id, r.total_cents])).toEqual([
        [b.resultEntityId, 120000],
        [b.resultEntityId, 120000],
      ]);

      const tenantA = await seed('T1-A-CONVERTED', 100000);
      await convert(tenantA);
      const a = await approveAndExecute(tenantA, await voicePlan(tenantA, DEPOSIT_THEN_BALANCE, 100000));
      await completeJob(tenantA);

      expect((await invoiceRows(tenantA)).map((r) => [r.invoice_number, r.schedule_id, r.total_cents])).toEqual([
        ['INV-0001', null, 100000],
      ]);
      expect(a.success).toBe(false);
      // Tenant B's plan did not move, and neither tenant reads the other's invoices.
      expect(await invoiceRows(tenantB)).toEqual(bBefore);
      expect(await invoiceRepo.findByJob(tenantB.tenantId, tenantA.job.id)).toEqual([]);
      expect(await invoiceRepo.findByJob(tenantA.tenantId, tenantB.job.id)).toEqual([]);
      expect(
        (await auditRepo.findByEntity(tenantB.tenantId, 'job', tenantB.job.id)).filter(
          (ev) => ev.eventType === 'invoice.milestone_mint_refused',
        ),
      ).toEqual([]);
    });
  });
});
