import { describe, it, expect, beforeEach } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { runBatchInvoiceSweep } from '../../src/workers/batch-invoice-worker';
import { InMemoryJobRepository, Job } from '../../src/jobs/job';
import { InMemoryInvoiceRepository } from '../../src/invoices/invoice';
import { InMemoryEstimateRepository, createEstimate } from '../../src/estimates/estimate';
import { InMemoryProposalRepository } from '../../src/proposals/proposal';
import { InMemorySettingsRepository, TenantSettings } from '../../src/settings/settings';
import { InMemoryBatchInvoiceRunRepository } from '../../src/invoices/batch-invoice-run';
import {
  InMemoryTransactionRunner,
  TenantTransactionRunner,
  TransactionScope,
} from '../../src/db/tenant-transaction';
import { buildLineItem } from '../../src/shared/billing-engine';
import { createLogger } from '../../src/logging/logger';

const TENANT = 'tenant-batch';
const logger = createLogger({ service: 'test', environment: 'test' });

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: uuidv4(),
    tenantId: TENANT,
    customerId: uuidv4(),
    locationId: uuidv4(),
    jobNumber: 'JOB-1',
    summary: 'AC repair',
    status: 'completed',
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

function makeSettings(batchInvoiceEnabled: boolean): TenantSettings {
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
    batchInvoiceEnabled,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

describe('runBatchInvoiceSweep', () => {
  let jobRepo: InMemoryJobRepository;
  let invoiceRepo: InMemoryInvoiceRepository;
  let estimateRepo: InMemoryEstimateRepository;
  let proposalRepo: InMemoryProposalRepository;
  let settingsRepo: InMemorySettingsRepository;
  let runRepo: InMemoryBatchInvoiceRunRepository;

  beforeEach(() => {
    jobRepo = new InMemoryJobRepository();
    invoiceRepo = new InMemoryInvoiceRepository();
    estimateRepo = new InMemoryEstimateRepository();
    proposalRepo = new InMemoryProposalRepository();
    settingsRepo = new InMemorySettingsRepository();
    runRepo = new InMemoryBatchInvoiceRunRepository();
  });

  function deps(now = new Date('2026-05-31T08:00:00Z')) {
    return {
      jobRepo,
      invoiceRepo,
      estimateRepo,
      proposalRepo,
      settingsRepo,
      runRepo,
      txRunner: new InMemoryTransactionRunner(),
      listTenantIds: async () => [TENANT],
      logger,
      now: () => now,
    };
  }

  async function seedCandidate(amountCents: number) {
    const job = await jobRepo.create(makeJob());
    const est = await createEstimate(
      { tenantId: TENANT, jobId: job.id, estimateNumber: 'EST-1', lineItems: [buildLineItem('i1', 'Repair', 1, amountCents, 0, true)], createdBy: 'u1' },
      estimateRepo,
    );
    await estimateRepo.update(TENANT, est.id, { status: 'accepted' });
    return job;
  }

  it('does nothing when the tenant has not opted in', async () => {
    await settingsRepo.create(makeSettings(false));
    await seedCandidate(20000);

    const result = await runBatchInvoiceSweep(deps());
    expect(result.proposals).toBe(0);
    expect(await proposalRepo.findByTenant(TENANT)).toHaveLength(0);
  });

  it('emits one batch_invoice proposal summarizing all candidate jobs', async () => {
    await settingsRepo.create(makeSettings(true));
    await seedCandidate(20000);
    await seedCandidate(5000);

    const result = await runBatchInvoiceSweep(deps());
    expect(result.proposals).toBe(1);
    expect(result.jobs).toBe(2);

    const proposals = await proposalRepo.findByTenant(TENANT);
    expect(proposals).toHaveLength(1);
    expect(proposals[0].proposalType).toBe('batch_invoice');
    const payload = proposals[0].payload as { totalCents: number; jobs: unknown[] };
    expect(payload.totalCents).toBe(25000);
    expect(payload.jobs).toHaveLength(2);
  });

  it('re-running the same day no-ops via the dedup ledger', async () => {
    await settingsRepo.create(makeSettings(true));
    await seedCandidate(20000);

    const first = await runBatchInvoiceSweep(deps());
    expect(first.proposals).toBe(1);

    const second = await runBatchInvoiceSweep(deps());
    expect(second.proposals).toBe(0);
    expect(second.skipped).toBe(1);
    // Still just the one proposal from the first run.
    expect(await proposalRepo.findByTenant(TENANT)).toHaveLength(1);
  });

  it('no-ops when there are no candidate jobs', async () => {
    await settingsRepo.create(makeSettings(true));
    const result = await runBatchInvoiceSweep(deps());
    expect(result.proposals).toBe(0);
  });

  // A runner that gives the in-memory ledger REAL rollback semantics (the
  // default InMemoryTransactionRunner is a no-op): it snapshots the ledger
  // before the unit of work and restores it if the work throws — mirroring the
  // pg transaction the worker relies on — so we can assert reserve + propose
  // are atomic.
  function rollbackRunner(): TenantTransactionRunner {
    return {
      run: async <T>(_t: string, fn: (scope: TransactionScope) => Promise<T>): Promise<T> => {
        const ledger = runRepo as unknown as { rows: Map<string, unknown> };
        const snapshot = new Map(ledger.rows);
        try {
          return await fn({ lock: async () => undefined, savepoint: (w) => w() });
        } catch (err) {
          ledger.rows = snapshot; // roll back reservations made in this unit
          throw err;
        }
      },
    };
  }

  it('rolls reservations back with a failed proposal, so the job re-batches the same day', async () => {
    await settingsRepo.create(makeSettings(true));
    const job = await seedCandidate(20000);

    // First sweep: the proposal write fails AFTER the reservation. The whole
    // unit rolls back — no proposal AND no orphaned reservation.
    const realCreate = proposalRepo.create.bind(proposalRepo);
    proposalRepo.create = async () => {
      throw new Error('proposal write failed');
    };
    const first = await runBatchInvoiceSweep({ ...deps(), txRunner: rollbackRunner() });
    expect(first.failed).toBe(1);
    expect(first.proposals).toBe(0);
    expect(await runRepo.findByJobAndDate(TENANT, job.id, '2026-05-31')).toBeNull();

    // Second sweep the SAME day succeeds: the rolled-back job is eligible again
    // (the old reserve-first design would have skipped it until tomorrow).
    proposalRepo.create = realCreate;
    const second = await runBatchInvoiceSweep({ ...deps(), txRunner: rollbackRunner() });
    expect(second.proposals).toBe(1);
    expect(second.jobs).toBe(1);
    expect(await proposalRepo.findByTenant(TENANT)).toHaveLength(1);
  });
});
