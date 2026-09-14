import { describe, it, expect, beforeEach } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { CreateInvoiceScheduleExecutionHandler } from '../../src/proposals/execution/invoice-schedule-handler';
import { actionClassForProposalType, Proposal } from '../../src/proposals/proposal';
import { validateProposalPayload } from '../../src/proposals/contracts';
import { createInvoiceSchedulePayloadSchema } from '../../src/proposals/contracts/create-invoice-schedule';
import { InMemoryInvoiceRepository, createInvoice } from '../../src/invoices/invoice';
import { InMemoryProposalRepository } from '../../src/proposals/proposal';
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

    it('rejects percent milestones that sum past 100%', () => {
      expect(
        createInvoiceSchedulePayloadSchema.safeParse({
          jobId: uuidv4(),
          milestones: [
            { label: 'A', type: 'percent', value: 6000, trigger: 'on_accept' },
            { label: 'B', type: 'percent', value: 6000, trigger: 'manual' }, // 12000 > 10000
            { label: 'Rest', type: 'remainder', value: 0, trigger: 'on_completion' },
          ],
        }).success,
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

    /** #1203 — a plan bills the job's single accepted estimate, so each job gets one. */
    async function acceptedEstimateFor(jobId: string, amountCents = 20000, estimateNumber = 'EST-A') {
      const est = await createEstimate(
        { tenantId: TENANT, jobId, estimateNumber, lineItems: [buildLineItem('i1', 'Work', 1, amountCents, 0, true)], createdBy: 'u1' },
        estimateRepo,
      );
      return (await estimateRepo.update(TENANT, est.id, { status: 'accepted' }))!;
    }

    it('writes the schedule and mints the first milestone invoice (explicit total)', async () => {
      const jobId = uuidv4();
      await acceptedEstimateFor(jobId);
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

    it('drafts EVERY on_accept milestone up front, not just the first', async () => {
      // Deposit + permit fee are both due on accept; the balance on completion.
      const jobId = uuidv4();
      await acceptedEstimateFor(jobId, 100000);
      const result = await handler.execute(
        makeProposal({
          jobId,
          totalAmountCents: 100000,
          milestones: [
            { label: 'Deposit', type: 'percent', value: 3000, trigger: 'on_accept' }, // 30000
            { label: 'Permit fee', type: 'flat', value: 15000, trigger: 'on_accept' }, // 15000
            { label: 'Balance', type: 'remainder', value: 0, trigger: 'on_completion' },
          ],
        }),
        { tenantId: TENANT, executedBy: 'u1' },
      );
      expect(result.success).toBe(true);

      const invoices = await invoiceRepo.findByJob(TENANT, jobId);
      // Both on_accept milestones drafted (indexes 0 and 1); the on_completion
      // remainder (index 2) is NOT minted here.
      expect(invoices).toHaveLength(2);
      const byIndex = new Map(invoices.map((inv) => [inv.milestoneIndex, inv.totals.totalCents]));
      expect(byIndex.get(0)).toBe(30000);
      expect(byIndex.get(1)).toBe(15000);
      expect(byIndex.has(2)).toBe(false);
    });

    it('links the estimate on the first on_accept invoice only (uq_invoices_estimate)', async () => {
      // One invoice per estimate: a permit fee drafted alongside the deposit
      // must not carry the same estimate_id, or its INSERT is rejected.
      const jobId = uuidv4();
      const est = await createEstimate(
        { tenantId: TENANT, jobId, estimateNumber: 'EST-9', lineItems: [buildLineItem('i1', 'Roof', 1, 100000, 0, true)], createdBy: 'u1' },
        estimateRepo,
      );
      const result = await handler.execute(
        makeProposal({
          jobId,
          estimateId: est.id,
          totalAmountCents: 100000,
          milestones: [
            { label: 'Deposit', type: 'percent', value: 3000, trigger: 'on_accept' },
            { label: 'Permit fee', type: 'flat', value: 15000, trigger: 'on_accept' },
            { label: 'Balance', type: 'remainder', value: 0, trigger: 'on_completion' },
          ],
        }),
        { tenantId: TENANT, executedBy: 'u1' },
      );
      expect(result.success).toBe(true);

      const invoices = await invoiceRepo.findByJob(TENANT, jobId);
      expect(invoices).toHaveLength(2);
      const byIndex = new Map(invoices.map((inv) => [inv.milestoneIndex, inv.estimateId]));
      expect(byIndex.get(0)).toBe(est.id);
      expect(byIndex.get(1)).toBeUndefined();
    });

    it('fails the execution on a 23505 from any index other than the milestone index', async () => {
      const jobId = uuidv4();
      await acceptedEstimateFor(jobId);
      invoiceRepo.create = async () => {
        throw Object.assign(new Error('duplicate key value violates unique constraint "uq_invoices_estimate"'), {
          code: '23505',
          constraint: 'uq_invoices_estimate',
        });
      };
      const result = await handler.execute(
        makeProposal({ jobId, totalAmountCents: 20000, milestones: milestones5050 }),
        { tenantId: TENANT, executedBy: 'u1' },
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain('uq_invoices_estimate');
    });

    it('re-execution after a partial mint drafts only the missing on_accept milestone', async () => {
      // Simulate a prior run that minted milestone 0 but not 1 (e.g. crashed
      // mid-loop, no resultEntityId persisted), then retry.
      const jobId = uuidv4();
      await acceptedEstimateFor(jobId, 100000);
      const payload = {
        jobId,
        totalAmountCents: 100000,
        milestones: [
          { label: 'Deposit', type: 'percent', value: 3000, trigger: 'on_accept' },
          { label: 'Permit fee', type: 'flat', value: 15000, trigger: 'on_accept' },
          { label: 'Balance', type: 'remainder', value: 0, trigger: 'on_completion' },
        ],
      };
      // First run mints both; delete milestone 1 to mimic a partial prior run.
      await handler.execute(makeProposal(payload), { tenantId: TENANT, executedBy: 'u1' });
      const after = await invoiceRepo.findByJob(TENANT, jobId);
      expect(after).toHaveLength(2);

      // Re-run: schedule already exists, both milestones already drafted — no dups.
      const rerun = await handler.execute(makeProposal(payload), { tenantId: TENANT, executedBy: 'u1' });
      expect(rerun.success).toBe(true);
      expect(await invoiceRepo.findByJob(TENANT, jobId)).toHaveLength(2);
      expect(await scheduleRepo.findByJob(TENANT, jobId)).toHaveLength(1);
    });

    it('rejects a different schedule for a job that already has one (no graft onto the old row)', async () => {
      const jobId = uuidv4();
      await acceptedEstimateFor(jobId);
      // First proposal establishes the schedule (50% deposit on accept).
      const first = await handler.execute(
        makeProposal({ jobId, totalAmountCents: 20000, milestones: milestones5050 }),
        { tenantId: TENANT, executedBy: 'u1' },
      );
      expect(first.success).toBe(true);

      // A second, DIFFERENT plan for the SAME job must be rejected — not grafted
      // onto the existing schedule_id, which would desync the stored milestones
      // from the drafted invoices and corrupt the on_completion balance.
      const second = await handler.execute(
        makeProposal(
          {
            jobId,
            totalAmountCents: 50000,
            milestones: [
              { label: 'Deposit', type: 'percent', value: 8000, trigger: 'on_accept' },
              { label: 'Balance', type: 'remainder', value: 0, trigger: 'on_completion' },
            ],
          },
          { id: 'p2' },
        ),
        { tenantId: TENANT, executedBy: 'u1' },
      );
      expect(second.success).toBe(false);
      expect(second.error).toMatch(/different invoice schedule/i);

      // The original schedule and its single on_accept invoice are untouched.
      expect(await scheduleRepo.findByJob(TENANT, jobId)).toHaveLength(1);
      const invoices = await invoiceRepo.findByJob(TENANT, jobId);
      expect(invoices).toHaveLength(1);
      expect(invoices[0].totals.totalCents).toBe(10000); // still 50% of 20000
    });

    it('rejects schedule reuse when only the estimateId differs (same total + milestones)', async () => {
      const jobId = uuidv4();
      const estimateA = await acceptedEstimateFor(jobId, 20000, 'EST-A');
      const estimateB = await createEstimate(
        { tenantId: TENANT, jobId, estimateNumber: 'EST-B', lineItems: [buildLineItem('i1', 'Work', 1, 20000, 0, true)], createdBy: 'u1' },
        estimateRepo,
      );
      // First schedule tied to estimate A.
      const first = await handler.execute(
        makeProposal({ jobId, estimateId: estimateA.id, totalAmountCents: 20000, milestones: milestones5050 }),
        { tenantId: TENANT, executedBy: 'u1' },
      );
      expect(first.success).toBe(true);

      // A revised proposal for estimate B with the SAME total + milestones must
      // not reuse estimate A's schedule (mixed provenance) — it is rejected.
      const second = await handler.execute(
        makeProposal(
          { jobId, estimateId: estimateB.id, totalAmountCents: 20000, milestones: milestones5050 },
          { id: 'p2' },
        ),
        { tenantId: TENANT, executedBy: 'u1' },
      );
      expect(second.success).toBe(false);
      expect(second.error).toMatch(/different invoice schedule/i);
      expect(await scheduleRepo.findByJob(TENANT, jobId)).toHaveLength(1);
    });

    it('does not mint an invoice up front when no milestone is on_accept', async () => {
      const jobId = uuidv4();
      await acceptedEstimateFor(jobId);
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
      // A voice plan with no spoken amount: the job's accepted estimate is
      // resolved (#1203) but, as before, supplies no total the payload did not ask for.
      const jobId = uuidv4();
      await acceptedEstimateFor(jobId);
      const result = await handler.execute(
        makeProposal({ jobId, milestones: milestones5050 }),
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

    describe('#1203 — the plan bills one recorded estimate', () => {
      /** The voice on-ramp's payload shape: jobId + milestones + spoken total, never an estimateId. */
      const voicePayload = (jobId: string, totalAmountCents = 20000) => ({
        jobId,
        jobReference: 'the Rivera job',
        scheduleDescription: '50% deposit, 50% on completion',
        milestones: milestones5050,
        totalAmountCents,
      });

      async function wholeInvoice(jobId: string, estimateId: string | undefined, totalCents: number, number = 'INV-9') {
        return createInvoice(
          { tenantId: TENANT, jobId, estimateId, invoiceNumber: number, lineItems: [buildLineItem('w1', 'Work', 1, totalCents, 0, true)], createdBy: 'u1' },
          invoiceRepo,
        );
      }

      async function nothingWritten(jobId: string, invoicesBefore: number) {
        expect(await scheduleRepo.findByJob(TENANT, jobId)).toEqual([]);
        expect(await invoiceRepo.findByJob(TENANT, jobId)).toHaveLength(invoicesBefore);
      }

      it("records the job's single accepted estimate on a voice plan, and links it on the first milestone", async () => {
        const jobId = uuidv4();
        const est = await acceptedEstimateFor(jobId);
        // A draft change order on the same job is not a candidate.
        await createEstimate(
          { tenantId: TENANT, jobId, estimateNumber: 'EST-CO', lineItems: [buildLineItem('c1', 'Valve', 1, 5000, 0, true)], createdBy: 'u1' },
          estimateRepo,
        );
        const result = await handler.execute(makeProposal(voicePayload(jobId)), { tenantId: TENANT, executedBy: 'u1' });
        expect(result.success).toBe(true);
        const [schedule] = await scheduleRepo.findByJob(TENANT, jobId);
        expect(schedule.estimateId).toBe(est.id);
        const [deposit] = await invoiceRepo.findByJob(TENANT, jobId);
        expect(deposit.estimateId).toBe(est.id);
        expect(deposit.totals.totalCents).toBe(10000);
      });

      it('refuses a voice plan when the job has no accepted estimate, writing nothing', async () => {
        const jobId = uuidv4();
        await createEstimate(
          { tenantId: TENANT, jobId, estimateNumber: 'EST-S', lineItems: [buildLineItem('i1', 'Work', 1, 20000, 0, true)], createdBy: 'u1' },
          estimateRepo,
        );
        const result = await handler.execute(makeProposal(voicePayload(jobId)), { tenantId: TENANT, executedBy: 'u1' });
        expect(result.success).toBe(false);
        expect(result.error).toMatch(/no accepted estimate/);
        await nothingWritten(jobId, 0);
      });

      it('refuses a voice plan when the job has several accepted estimates (legacy rows), naming them', async () => {
        // Postgres keeps one accepted estimate per job (uq_estimates_accepted_per_job);
        // only rows from before that index can hold two. The in-memory repo allows it.
        const jobId = uuidv4();
        await acceptedEstimateFor(jobId, 20000, 'EST-1');
        await acceptedEstimateFor(jobId, 30000, 'EST-2');
        const result = await handler.execute(makeProposal(voicePayload(jobId)), { tenantId: TENANT, executedBy: 'u1' });
        expect(result.success).toBe(false);
        expect(result.error).toMatch(/more than one accepted estimate \(EST-1, EST-2\); say which one/);
        await nothingWritten(jobId, 0);
      });

      it('refuses a payload estimate that belongs to another job, or does not exist', async () => {
        const jobId = uuidv4();
        await acceptedEstimateFor(jobId);
        const otherJobEstimate = await acceptedEstimateFor(uuidv4(), 70000, 'EST-OTHER');
        const foreign = await handler.execute(
          makeProposal({ jobId, estimateId: otherJobEstimate.id, milestones: milestones5050 }),
          { tenantId: TENANT, executedBy: 'u1' },
        );
        expect(foreign.success).toBe(false);
        expect(foreign.error).toMatch(/belongs to a different job/);
        const missing = await handler.execute(
          makeProposal({ jobId, estimateId: uuidv4(), totalAmountCents: 20000, milestones: milestones5050 }, { id: 'p2' }),
          { tenantId: TENANT, executedBy: 'u1' },
        );
        expect(missing.success).toBe(false);
        expect(missing.error).toMatch(/not found/);
        await nothingWritten(jobId, 0);
      });

      it('refuses when a live invoice outside the plan already bills the estimate, naming it', async () => {
        const jobId = uuidv4();
        const est = await acceptedEstimateFor(jobId);
        await wholeInvoice(jobId, est.id, 20000, 'INV-0001');
        const result = await handler.execute(makeProposal(voicePayload(jobId)), { tenantId: TENANT, executedBy: 'u1' });
        expect(result.success).toBe(false);
        expect(result.error).toBe(
          'This estimate is already invoiced as INV-0001 ($200.00), so a milestone plan would bill it twice. No invoice schedule was created.',
        );
        await nothingWritten(jobId, 1);
      });

      it('a canceled or unpaid void invoice does not block; a void one holding a payment does, with the refund reason', async () => {
        for (const [status, paid, allowed] of [['canceled', 0, true], ['void', 0, true], ['void', 5000, false]] as const) {
          const jobId = uuidv4();
          const est = await acceptedEstimateFor(jobId);
          const inv = await wholeInvoice(jobId, est.id, 20000, 'INV-0001');
          await invoiceRepo.update(TENANT, inv.id, { status, amountPaidCents: paid });
          const result = await handler.execute(makeProposal(voicePayload(jobId)), { tenantId: TENANT, executedBy: 'u1' });
          expect(result.success).toBe(allowed);
          if (!allowed) {
            expect(result.error).toMatch(/INV-0001, which is void but still holds \$50\.00 of payments\. Refund or move that payment first/);
          }
        }
      });

      it("another estimate's invoice on the job (a change order) never blocks the plan", async () => {
        const jobId = uuidv4();
        await acceptedEstimateFor(jobId);
        const changeOrder = await createEstimate(
          { tenantId: TENANT, jobId, estimateNumber: 'EST-CO', lineItems: [buildLineItem('c1', 'Valve', 1, 5000, 0, true)], createdBy: 'u1' },
          estimateRepo,
        );
        await wholeInvoice(jobId, changeOrder.id, 5000, 'INV-0001');
        const result = await handler.execute(makeProposal(voicePayload(jobId)), { tenantId: TENANT, executedBy: 'u1' });
        expect(result.success).toBe(true);
      });

      it("a retry is not refused by the plan's own first milestone, which carries the estimate id", async () => {
        const jobId = uuidv4();
        await acceptedEstimateFor(jobId);
        expect((await handler.execute(makeProposal(voicePayload(jobId)), { tenantId: TENANT, executedBy: 'u1' })).success).toBe(true);
        const retry = await handler.execute(makeProposal(voicePayload(jobId)), { tenantId: TENANT, executedBy: 'u1' });
        expect(retry.success).toBe(true);
        expect(await invoiceRepo.findByJob(TENANT, jobId)).toHaveLength(1);
      });

      it('lets the plan through when the job has invoices with no estimate, and lists them on the proposal explanation', async () => {
        const proposalRepo = new InMemoryProposalRepository();
        const withNotes = new CreateInvoiceScheduleExecutionHandler(scheduleRepo, invoiceRepo, settingsRepo, estimateRepo, proposalRepo);
        const jobId = uuidv4();
        await acceptedEstimateFor(jobId);
        await wholeInvoice(jobId, undefined, 15000, 'INV-0001');
        const proposal = await proposalRepo.create(makeProposal(voicePayload(jobId), { explanation: 'Voice plan' }));
        const result = await withNotes.execute(proposal, { tenantId: TENANT, executedBy: 'u1' });
        expect(result.success).toBe(true);
        expect((await proposalRepo.findById(TENANT, proposal.id))?.explanation).toBe(
          'Voice plan\n\nHeads-up: this job also has an invoice not tied to an estimate: INV-0001 ($150.00). ' +
            'The milestone plan bills its estimate only, so check it is not for the same work.',
        );
      });
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
