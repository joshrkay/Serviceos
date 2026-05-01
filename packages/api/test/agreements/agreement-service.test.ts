import { describe, it, expect, beforeEach } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { InMemoryAgreementRepository } from '../../src/agreements/agreement';
import { InMemoryAgreementRunRepository } from '../../src/agreements/agreement-run';
import {
  createAgreement,
  pauseAgreement,
  resumeAgreement,
  cancelAgreement,
  runDueAgreements,
  JobsServicePort,
  InvoicesServicePort,
} from '../../src/agreements/agreement-service';

function tenantId(): string {
  return uuidv4();
}

function makeMocks(): {
  jobsService: JobsServicePort & { calls: number };
  invoicesService: InvoicesServicePort & { calls: number };
} {
  const jobsService = {
    calls: 0,
    async createJob() {
      jobsService.calls++;
      return { id: uuidv4() };
    },
  };
  const invoicesService = {
    calls: 0,
    async createDraftInvoice() {
      invoicesService.calls++;
      return { id: uuidv4() };
    },
  };
  return { jobsService, invoicesService };
}

describe('P9-003 agreement-service: createAgreement', () => {
  it('creates an agreement and computes the first run from startsOn', async () => {
    const repo = new InMemoryAgreementRepository();
    const t = tenantId();
    const a = await createAgreement(
      {
        tenantId: t,
        customerId: uuidv4(),
        name: 'Quarterly HVAC Tune-up',
        recurrenceRule: 'FREQ=QUARTERLY;BYMONTHDAY=15',
        priceCents: 19900,
        startsOn: '2026-06-15',
        createdBy: 'user-1',
      },
      repo,
    );
    expect(a.status).toBe('active');
    expect(a.nextRunAt.toISOString().slice(0, 10)).toBe('2026-06-15');
    expect(a.priceCents).toBe(19900);
  });

  it('rejects fractional priceCents', async () => {
    const repo = new InMemoryAgreementRepository();
    await expect(
      createAgreement(
        {
          tenantId: tenantId(),
          customerId: uuidv4(),
          name: 'x',
          recurrenceRule: 'FREQ=MONTHLY',
          priceCents: 100.5,
          startsOn: '2026-01-01',
          createdBy: 'user-1',
        },
        repo,
      ),
    ).rejects.toThrow();
  });

  it('rejects endsOn before startsOn', async () => {
    const repo = new InMemoryAgreementRepository();
    await expect(
      createAgreement(
        {
          tenantId: tenantId(),
          customerId: uuidv4(),
          name: 'x',
          recurrenceRule: 'FREQ=MONTHLY',
          priceCents: 1000,
          startsOn: '2026-06-01',
          endsOn: '2026-05-01',
          createdBy: 'user-1',
        },
        repo,
      ),
    ).rejects.toThrow();
  });
});

describe('P9-003 agreement-service: pause / resume / cancel', () => {
  it('pause then resume restores to active', async () => {
    const repo = new InMemoryAgreementRepository();
    const t = tenantId();
    const a = await createAgreement(
      {
        tenantId: t,
        customerId: uuidv4(),
        name: 'x',
        recurrenceRule: 'FREQ=MONTHLY',
        priceCents: 1000,
        startsOn: '2026-06-01',
        createdBy: 'u',
      },
      repo,
    );
    const paused = await pauseAgreement(t, a.id, repo);
    expect(paused?.status).toBe('paused');
    const resumed = await resumeAgreement(t, a.id, repo);
    expect(resumed?.status).toBe('active');
  });

  it('cancel is terminal — pause after cancel throws', async () => {
    const repo = new InMemoryAgreementRepository();
    const t = tenantId();
    const a = await createAgreement(
      {
        tenantId: t,
        customerId: uuidv4(),
        name: 'x',
        recurrenceRule: 'FREQ=MONTHLY',
        priceCents: 1000,
        startsOn: '2026-06-01',
        createdBy: 'u',
      },
      repo,
    );
    await cancelAgreement(t, a.id, repo);
    await expect(pauseAgreement(t, a.id, repo)).rejects.toThrow();
  });
});

describe('P9-003 agreement-service: runDueAgreements idempotency + tenant isolation', () => {
  let agreementRepo: InMemoryAgreementRepository;
  let runRepo: InMemoryAgreementRunRepository;
  let jobs: JobsServicePort & { calls: number };
  let invoices: InvoicesServicePort & { calls: number };
  const t = '11111111-1111-1111-1111-111111111111';
  const otherTenant = '22222222-2222-2222-2222-222222222222';

  beforeEach(() => {
    agreementRepo = new InMemoryAgreementRepository();
    runRepo = new InMemoryAgreementRunRepository();
    const m = makeMocks();
    jobs = m.jobsService;
    invoices = m.invoicesService;
  });

  it('calling runDueAgreements twice yields exactly one job + one invoice + one run', async () => {
    const a = await createAgreement(
      {
        tenantId: t,
        customerId: uuidv4(),
        name: 'monthly',
        recurrenceRule: 'FREQ=MONTHLY;BYMONTHDAY=1',
        priceCents: 5000,
        startsOn: '2026-06-01',
        createdBy: 'u',
      },
      agreementRepo,
    );
    const now = new Date(Date.UTC(2026, 5, 1, 9, 0, 0));
    const r1 = await runDueAgreements(t, {
      agreementRepo,
      runRepo,
      jobsService: jobs,
      invoicesService: invoices,
      now,
    });
    expect(r1.generatedRunIds.length).toBe(1);
    const r2 = await runDueAgreements(t, {
      agreementRepo,
      runRepo,
      jobsService: jobs,
      invoicesService: invoices,
      now,
    });
    expect(r2.generatedRunIds.length).toBe(0);
    expect(jobs.calls).toBe(1);
    expect(invoices.calls).toBe(1);
    const runs = await runRepo.findByAgreement(t, a.id);
    expect(runs.length).toBe(1);
  });

  it('respects ends_on — agreements past end date are not run', async () => {
    await createAgreement(
      {
        tenantId: t,
        customerId: uuidv4(),
        name: 'expired',
        recurrenceRule: 'FREQ=MONTHLY;BYMONTHDAY=1',
        priceCents: 1000,
        startsOn: '2026-01-01',
        endsOn: '2026-03-01',
        createdBy: 'u',
      },
      agreementRepo,
    );
    const now = new Date(Date.UTC(2026, 5, 1));
    const result = await runDueAgreements(t, {
      agreementRepo,
      runRepo,
      jobsService: jobs,
      invoicesService: invoices,
      now,
    });
    expect(result.generatedRunIds.length).toBe(0);
    expect(jobs.calls).toBe(0);
  });

  it('paused agreements are skipped', async () => {
    const a = await createAgreement(
      {
        tenantId: t,
        customerId: uuidv4(),
        name: 'paused',
        recurrenceRule: 'FREQ=MONTHLY;BYMONTHDAY=1',
        priceCents: 1000,
        startsOn: '2026-06-01',
        createdBy: 'u',
      },
      agreementRepo,
    );
    await pauseAgreement(t, a.id, agreementRepo);
    const now = new Date(Date.UTC(2026, 5, 1));
    const result = await runDueAgreements(t, {
      agreementRepo,
      runRepo,
      jobsService: jobs,
      invoicesService: invoices,
      now,
    });
    expect(result.generatedRunIds.length).toBe(0);
  });

  it('tenant isolation — runDueAgreements only touches the requested tenant', async () => {
    await createAgreement(
      {
        tenantId: t,
        customerId: uuidv4(),
        name: 'tenant-A',
        recurrenceRule: 'FREQ=MONTHLY;BYMONTHDAY=1',
        priceCents: 1000,
        startsOn: '2026-06-01',
        createdBy: 'u',
      },
      agreementRepo,
    );
    await createAgreement(
      {
        tenantId: otherTenant,
        customerId: uuidv4(),
        name: 'tenant-B',
        recurrenceRule: 'FREQ=MONTHLY;BYMONTHDAY=1',
        priceCents: 1000,
        startsOn: '2026-06-01',
        createdBy: 'u',
      },
      agreementRepo,
    );
    const now = new Date(Date.UTC(2026, 5, 1));
    const result = await runDueAgreements(t, {
      agreementRepo,
      runRepo,
      jobsService: jobs,
      invoicesService: invoices,
      now,
    });
    expect(result.generatedRunIds.length).toBe(1);
    // Tenant B's agreement is untouched.
    const otherRuns = await runRepo.findByAgreement(
      otherTenant,
      (await agreementRepo.findByTenant(otherTenant))[0].id,
    );
    expect(otherRuns.length).toBe(0);
  });

  it('records a failed run when invoice creation throws', async () => {
    const failingInvoices: InvoicesServicePort = {
      async createDraftInvoice() {
        throw new Error('boom');
      },
    };
    const a = await createAgreement(
      {
        tenantId: t,
        customerId: uuidv4(),
        name: 'failing',
        recurrenceRule: 'FREQ=MONTHLY;BYMONTHDAY=1',
        priceCents: 1000,
        startsOn: '2026-06-01',
        createdBy: 'u',
      },
      agreementRepo,
    );
    const now = new Date(Date.UTC(2026, 5, 1));
    const result = await runDueAgreements(t, {
      agreementRepo,
      runRepo,
      jobsService: jobs,
      invoicesService: failingInvoices,
      now,
    });
    expect(result.failedRunIds.length).toBe(1);
    const runs = await runRepo.findByAgreement(t, a.id);
    expect(runs[0].status).toBe('failed');
    expect(runs[0].errorMessage).toMatch(/boom/);
  });
});
