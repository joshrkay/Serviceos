import { describe, it, expect, beforeEach } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { createJob, InMemoryJobRepository } from '../../src/jobs/job';
import { InMemoryEstimateRepository } from '../../src/estimates/estimate';
import { InMemoryInvoiceRepository, Invoice, InvoiceStatus } from '../../src/invoices/invoice';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { createLogger } from '../../src/logging/logger';
import {
  runOverdueInvoiceSweep,
  OverdueInvoiceWorkerDeps,
} from '../../src/workers/overdue-invoice-worker';
import type { DocumentTotals } from '../../src/shared/billing-engine';
import { InMemoryProposalRepository } from '../../src/proposals/proposal';
import {
  DunningConfig,
  InMemoryDunningConfigRepository,
  InMemoryDunningEventRepository,
} from '../../src/invoices/dunning-config';

const logger = createLogger({ service: 'test', environment: 'test', level: 'error' });
const NOW = new Date('2026-05-14T12:00:00Z');
const PAST = new Date('2026-05-01T00:00:00Z');
const FUTURE = new Date('2026-06-01T00:00:00Z');

const ZERO_TOTALS: DocumentTotals = {
  subtotalCents: 0,
  discountCents: 0,
  taxRateBps: 0,
  taxableSubtotalCents: 0,
  taxCents: 0,
  totalCents: 10000,
};

function makeInvoice(jobId: string, status: InvoiceStatus, dueDate: Date): Invoice {
  return {
    id: uuidv4(),
    tenantId: 't1',
    jobId,
    invoiceNumber: 'INV-0001',
    status,
    lineItems: [],
    totals: ZERO_TOTALS,
    amountPaidCents: 0,
    amountDueCents: 10000,
    dueDate,
    createdBy: 'u1',
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

describe('runOverdueInvoiceSweep', () => {
  let jobRepo: InMemoryJobRepository;
  let estimateRepo: InMemoryEstimateRepository;
  let invoiceRepo: InMemoryInvoiceRepository;
  let auditRepo: InMemoryAuditRepository;

  beforeEach(() => {
    jobRepo = new InMemoryJobRepository();
    estimateRepo = new InMemoryEstimateRepository();
    invoiceRepo = new InMemoryInvoiceRepository();
    auditRepo = new InMemoryAuditRepository();
  });

  function deps(listTenantIds: () => Promise<string[]>): OverdueInvoiceWorkerDeps {
    return {
      jobRepo,
      estimateRepo,
      invoiceRepo,
      auditRepo,
      listTenantIds,
      logger,
      now: () => NOW,
    };
  }

  it('returns all-zero when there are no tenants', async () => {
    const result = await runOverdueInvoiceSweep(deps(async () => []));
    expect(result).toEqual({ tenants: 0, overdue: 0, failed: 0 });
  });

  it('returns zero when listTenantIds throws', async () => {
    const result = await runOverdueInvoiceSweep({
      jobRepo,
      estimateRepo,
      invoiceRepo,
      auditRepo,
      listTenantIds: async () => {
        throw new Error('registry down');
      },
      logger,
      now: () => NOW,
    });
    expect(result).toEqual({ tenants: 0, overdue: 0, failed: 0 });
  });

  it('flips a past-due open invoice job to overdue and emits invoice.overdue', async () => {
    const job = await createJob(
      { tenantId: 't1', customerId: 'c1', locationId: 'l1', summary: 'Job', createdBy: 'u1' },
      jobRepo,
    );
    const invoice = await invoiceRepo.create(makeInvoice(job.id, 'open', PAST));

    const result = await runOverdueInvoiceSweep(deps(async () => ['t1']));

    expect(result).toEqual({ tenants: 1, overdue: 1, failed: 0 });
    expect((await jobRepo.findById('t1', job.id))!.moneyState).toBe('overdue');

    const events = await auditRepo.findByEntity('t1', 'invoice', invoice.id);
    const overdueEvent = events.find((e) => e.eventType === 'invoice.overdue');
    expect(overdueEvent).toBeDefined();
    expect(overdueEvent!.metadata).toMatchObject({ jobId: job.id, amountDueCents: 10000 });
  });

  it('leaves a not-yet-due open invoice untouched', async () => {
    const job = await createJob(
      { tenantId: 't1', customerId: 'c1', locationId: 'l1', summary: 'Job', createdBy: 'u1' },
      jobRepo,
    );
    await invoiceRepo.create(makeInvoice(job.id, 'open', FUTURE));

    const result = await runOverdueInvoiceSweep(deps(async () => ['t1']));

    expect(result.overdue).toBe(0);
    expect((await jobRepo.findById('t1', job.id))!.moneyState).toBe('no_estimate');
  });

  it('is idempotent — a second sweep emits no new event', async () => {
    const job = await createJob(
      { tenantId: 't1', customerId: 'c1', locationId: 'l1', summary: 'Job', createdBy: 'u1' },
      jobRepo,
    );
    await invoiceRepo.create(makeInvoice(job.id, 'open', PAST));

    await runOverdueInvoiceSweep(deps(async () => ['t1']));
    const second = await runOverdueInvoiceSweep(deps(async () => ['t1']));

    expect(second.overdue).toBe(0);
  });

  it('isolates a tenant failure and keeps sweeping the rest', async () => {
    const job = await createJob(
      { tenantId: 't2', customerId: 'c1', locationId: 'l1', summary: 'Job', createdBy: 'u1' },
      jobRepo,
    );
    await invoiceRepo.create({ ...makeInvoice(job.id, 'open', PAST), tenantId: 't2' });

    // Repo that throws for tenant 't1' only.
    const flakyInvoiceRepo = {
      findByTenant: async (tenantId: string, options?: unknown) => {
        if (tenantId === 't1') throw new Error('db down for t1');
        return invoiceRepo.findByTenant(tenantId, options as never);
      },
      findByJob: invoiceRepo.findByJob.bind(invoiceRepo),
    } as unknown as InMemoryInvoiceRepository;

    const result = await runOverdueInvoiceSweep({
      jobRepo,
      estimateRepo,
      invoiceRepo: flakyInvoiceRepo,
      auditRepo,
      listTenantIds: async () => ['t1', 't2'],
      logger,
      now: () => NOW,
    });

    expect(result.tenants).toBe(2);
    expect(result.failed).toBe(1);
    expect(result.overdue).toBe(1);
  });

  // §7 Collections cadence — owner-approved dunning proposals.
  describe('dunning cadence', () => {
    function makeConfig(overrides: Partial<DunningConfig> = {}): DunningConfig {
      return {
        id: uuidv4(),
        tenantId: 't1',
        enabled: true,
        reminderSteps: [{ offsetDays: 3, channel: 'sms' }],
        lateFeeType: 'none',
        lateFeeValueCents: 0,
        lateFeeGraceDays: 0,
        createdAt: NOW,
        updatedAt: NOW,
        ...overrides,
      };
    }

    async function seedOverdueInvoice(tenantId: string) {
      const job = await createJob(
        { tenantId, customerId: 'c1', locationId: 'l1', summary: 'Job', createdBy: 'u1' },
        jobRepo,
      );
      // PAST (2026-05-01) is 13 days before NOW (2026-05-14).
      const invoice = await invoiceRepo.create({
        ...makeInvoice(job.id, 'open', PAST),
        tenantId,
      });
      return invoice;
    }

    it('raises one send_payment_reminder proposal per due cadence step (ready_for_review)', async () => {
      const invoice = await seedOverdueInvoice('t1');
      const proposalRepo = new InMemoryProposalRepository();
      const dunningEventRepo = new InMemoryDunningEventRepository();
      const dunningConfigRepo = new InMemoryDunningConfigRepository();
      await dunningConfigRepo.upsert(
        makeConfig({
          reminderSteps: [
            { offsetDays: 3, channel: 'sms' },
            { offsetDays: 7, channel: 'email' },
          ],
        }),
      );

      await runOverdueInvoiceSweep({
        ...deps(async () => ['t1']),
        proposalRepo,
        dunningEventRepo,
        dunningConfigRepo,
      });

      const proposals = await proposalRepo.findByStatus('t1', 'ready_for_review');
      const reminders = proposals.filter((p) => p.proposalType === 'send_payment_reminder');
      expect(reminders).toHaveLength(2);
      expect(reminders.map((r) => r.payload.stepKey).sort()).toEqual(['3:sms', '7:email']);
      reminders.forEach((r) => expect(r.payload.invoiceId).toBe(invoice.id));

      const events = await dunningEventRepo.findByInvoice('t1', invoice.id);
      expect(events.filter((e) => e.kind === 'reminder')).toHaveLength(2);
    });

    it('is idempotent — a second sweep raises no duplicate reminder proposals', async () => {
      await seedOverdueInvoice('t1');
      const proposalRepo = new InMemoryProposalRepository();
      const dunningEventRepo = new InMemoryDunningEventRepository();
      const dunningConfigRepo = new InMemoryDunningConfigRepository();
      await dunningConfigRepo.upsert(
        makeConfig({
          reminderSteps: [
            { offsetDays: 3, channel: 'sms' },
            { offsetDays: 7, channel: 'email' },
          ],
        }),
      );
      const sweepDeps = {
        ...deps(async () => ['t1']),
        proposalRepo,
        dunningEventRepo,
        dunningConfigRepo,
      };

      await runOverdueInvoiceSweep(sweepDeps);
      await runOverdueInvoiceSweep(sweepDeps);

      const reminders = (await proposalRepo.findByStatus('t1', 'ready_for_review')).filter(
        (p) => p.proposalType === 'send_payment_reminder',
      );
      expect(reminders).toHaveLength(2); // not 4
    });

    it('falls back to the default 3/7/14 cadence when no config exists', async () => {
      await seedOverdueInvoice('t1');
      const proposalRepo = new InMemoryProposalRepository();
      const dunningEventRepo = new InMemoryDunningEventRepository();

      // No dunningConfigRepo → defaultDunningConfig (PRD US-370: 3/7/14).
      await runOverdueInvoiceSweep({
        ...deps(async () => ['t1']),
        proposalRepo,
        dunningEventRepo,
      });

      const reminders = (await proposalRepo.findByStatus('t1', 'ready_for_review')).filter(
        (p) => p.proposalType === 'send_payment_reminder',
      );
      // The seeded invoice is 13 days overdue → day-3 and day-7 steps are due;
      // the day-14 step is not yet (13 < 14).
      expect(reminders).toHaveLength(2);
      const stepKeys = reminders.map((p) => p.payload.stepKey).sort();
      expect(stepKeys).toEqual(['3:sms', '7:sms']);
    });

    it('raises a late fee as a money proposal and NEVER applies money in the sweep', async () => {
      const invoice = await seedOverdueInvoice('t1');
      const proposalRepo = new InMemoryProposalRepository();
      const dunningEventRepo = new InMemoryDunningEventRepository();
      const dunningConfigRepo = new InMemoryDunningConfigRepository();
      await dunningConfigRepo.upsert(
        makeConfig({
          reminderSteps: [],
          lateFeeType: 'flat',
          lateFeeValueCents: 2500,
          lateFeeGraceDays: 0,
        }),
      );

      await runOverdueInvoiceSweep({
        ...deps(async () => ['t1']),
        proposalRepo,
        dunningEventRepo,
        dunningConfigRepo,
      });

      const proposals = await proposalRepo.findByStatus('t1', 'ready_for_review');
      const fees = proposals.filter((p) => p.proposalType === 'apply_late_fee');
      expect(fees).toHaveLength(1);
      expect(fees[0].payload).toMatchObject({ invoiceId: invoice.id, feeCents: 2500 });
      // Money invariant: the sweep only PROPOSES — the invoice is untouched
      // (no fee line, amount due unchanged) until the owner approves.
      const after = await invoiceRepo.findById('t1', invoice.id);
      expect(after!.amountDueCents).toBe(10000);
      expect(after!.lineItems).toHaveLength(0);
    });

    it('isolates dunning across tenants — each proposal targets its own tenant’s invoice', async () => {
      const inv1 = await seedOverdueInvoice('t1');
      const inv2 = await seedOverdueInvoice('t2');
      const proposalRepo = new InMemoryProposalRepository();
      const dunningEventRepo = new InMemoryDunningEventRepository();

      await runOverdueInvoiceSweep({
        ...deps(async () => ['t1', 't2']),
        proposalRepo,
        dunningEventRepo,
      });

      const t1 = await proposalRepo.findByStatus('t1', 'ready_for_review');
      const t2 = await proposalRepo.findByStatus('t2', 'ready_for_review');
      expect(t1.every((p) => p.payload.invoiceId === inv1.id)).toBe(true);
      expect(t2.every((p) => p.payload.invoiceId === inv2.id)).toBe(true);
      // Ledger is tenant-scoped: t1's events never reference t2's invoice.
      const t1Events = await dunningEventRepo.findByInvoice('t1', inv2.id);
      expect(t1Events).toHaveLength(0);
    });
  });
});
