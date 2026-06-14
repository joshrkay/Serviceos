import { describe, it, expect, beforeEach } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { InMemoryAgreementRepository } from '../../src/agreements/agreement';
import { InMemoryAgreementRunRepository } from '../../src/agreements/agreement-run';
import {
  createAgreement,
  updateAgreement,
  pauseAgreement,
  resumeAgreement,
  cancelAgreement,
  runDueAgreements,
  renewExpiringAgreements,
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

describe('membership auto-renew: validation', () => {
  it('createAgreement rejects auto-renew without endsOn (no term to renew)', async () => {
    const repo = new InMemoryAgreementRepository();
    await expect(
      createAgreement(
        {
          tenantId: tenantId(),
          customerId: uuidv4(),
          name: 'Gold membership',
          recurrenceRule: 'FREQ=MONTHLY;BYMONTHDAY=1',
          priceCents: 1500,
          startsOn: '2026-01-01',
          autoRenew: true,
          renewalTermMonths: 12,
          createdBy: 'u',
        },
        repo,
      ),
    ).rejects.toThrow(/endsOn/);
  });

  it('createAgreement rejects auto-renew without renewalTermMonths', async () => {
    const repo = new InMemoryAgreementRepository();
    await expect(
      createAgreement(
        {
          tenantId: tenantId(),
          customerId: uuidv4(),
          name: 'Gold membership',
          recurrenceRule: 'FREQ=MONTHLY;BYMONTHDAY=1',
          priceCents: 1500,
          startsOn: '2026-01-01',
          endsOn: '2027-01-01',
          autoRenew: true,
          createdBy: 'u',
        },
        repo,
      ),
    ).rejects.toThrow(/renewalTermMonths/);
  });

  it('createAgreement persists auto-renew fields when valid', async () => {
    const repo = new InMemoryAgreementRepository();
    const a = await createAgreement(
      {
        tenantId: tenantId(),
        customerId: uuidv4(),
        name: 'Gold membership',
        recurrenceRule: 'FREQ=MONTHLY;BYMONTHDAY=1',
        priceCents: 1500,
        startsOn: '2026-01-01',
        endsOn: '2027-01-01',
        autoRenew: true,
        renewalTermMonths: 12,
        createdBy: 'u',
      },
      repo,
    );
    expect(a.autoRenew).toBe(true);
    expect(a.renewalTermMonths).toBe(12);
    expect(a.renewalCount).toBe(0);
  });

  it('non-membership agreements default to autoRenew=false with no term', async () => {
    const repo = new InMemoryAgreementRepository();
    const a = await createAgreement(
      {
        tenantId: tenantId(),
        customerId: uuidv4(),
        name: 'one-off recurring',
        recurrenceRule: 'FREQ=MONTHLY;BYMONTHDAY=1',
        priceCents: 1500,
        startsOn: '2026-01-01',
        createdBy: 'u',
      },
      repo,
    );
    expect(a.autoRenew).toBe(false);
    expect(a.renewalTermMonths).toBeUndefined();
  });

  it('updateAgreement rejects clearing endsOn while auto-renew stays on', async () => {
    const repo = new InMemoryAgreementRepository();
    const t = tenantId();
    const a = await createAgreement(
      {
        tenantId: t,
        customerId: uuidv4(),
        name: 'Gold',
        recurrenceRule: 'FREQ=MONTHLY;BYMONTHDAY=1',
        priceCents: 1500,
        startsOn: '2026-01-01',
        endsOn: '2027-01-01',
        autoRenew: true,
        renewalTermMonths: 12,
        createdBy: 'u',
      },
      repo,
    );
    await expect(updateAgreement(t, a.id, { endsOn: null }, repo)).rejects.toThrow(/endsOn/);
  });

  it('updateAgreement rejects turning auto-renew on without a term', async () => {
    const repo = new InMemoryAgreementRepository();
    const t = tenantId();
    const a = await createAgreement(
      {
        tenantId: t,
        customerId: uuidv4(),
        name: 'Standard',
        recurrenceRule: 'FREQ=MONTHLY;BYMONTHDAY=1',
        priceCents: 1500,
        startsOn: '2026-01-01',
        endsOn: '2027-01-01',
        createdBy: 'u',
      },
      repo,
    );
    await expect(updateAgreement(t, a.id, { autoRenew: true }, repo)).rejects.toThrow(
      /renewalTermMonths/,
    );
  });
});

describe('membership auto-renew: renewExpiringAgreements', () => {
  async function makeMembership(
    repo: InMemoryAgreementRepository,
    t: string,
    opts: { startsOn: string; endsOn: string; term: number; autoRenew?: boolean },
  ) {
    return createAgreement(
      {
        tenantId: t,
        customerId: uuidv4(),
        name: 'membership',
        recurrenceRule: 'FREQ=MONTHLY;BYMONTHDAY=1',
        priceCents: 1500,
        startsOn: opts.startsOn,
        endsOn: opts.endsOn,
        autoRenew: opts.autoRenew ?? true,
        renewalTermMonths: opts.term,
        createdBy: 'u',
      },
      repo,
    );
  }

  it('rolls a lapsed term forward by one term and bumps renewalCount', async () => {
    const repo = new InMemoryAgreementRepository();
    const t = tenantId();
    const a = await makeMembership(repo, t, { startsOn: '2025-01-01', endsOn: '2026-01-01', term: 12 });
    const now = new Date(Date.UTC(2026, 1, 1)); // 2026-02-01, just past term end
    const result = await renewExpiringAgreements(t, { agreementRepo: repo, now });
    expect(result.renewedAgreementIds).toEqual([a.id]);
    const updated = await repo.findById(t, a.id);
    expect(updated?.endsOn).toBe('2027-01-01');
    expect(updated?.renewalCount).toBe(1);
  });

  it('catches up multiple missed terms in a single pass', async () => {
    const repo = new InMemoryAgreementRepository();
    const t = tenantId();
    const a = await makeMembership(repo, t, { startsOn: '2023-01-01', endsOn: '2024-01-01', term: 12 });
    const now = new Date(Date.UTC(2026, 1, 1)); // 2026-02-01 — two full terms skipped
    await renewExpiringAgreements(t, { agreementRepo: repo, now });
    const updated = await repo.findById(t, a.id);
    expect(updated?.endsOn).toBe('2027-01-01'); // 2024→2025→2026→2027
    expect(updated?.renewalCount).toBe(3);
  });

  it('does not renew an agreement still inside its term', async () => {
    const repo = new InMemoryAgreementRepository();
    const t = tenantId();
    await makeMembership(repo, t, { startsOn: '2026-01-01', endsOn: '2027-01-01', term: 12 });
    const now = new Date(Date.UTC(2026, 5, 1));
    const result = await renewExpiringAgreements(t, { agreementRepo: repo, now });
    expect(result.renewedAgreementIds).toEqual([]);
  });

  it('does not renew when auto-renew is off, even past term end', async () => {
    const repo = new InMemoryAgreementRepository();
    const t = tenantId();
    await makeMembership(repo, t, {
      startsOn: '2025-01-01',
      endsOn: '2026-01-01',
      term: 12,
      autoRenew: false,
    });
    const now = new Date(Date.UTC(2026, 5, 1));
    const result = await renewExpiringAgreements(t, { agreementRepo: repo, now });
    expect(result.renewedAgreementIds).toEqual([]);
  });

  it('clamps the renewal day for short target months (Jan 31 + 1mo → Feb 28)', async () => {
    const repo = new InMemoryAgreementRepository();
    const t = tenantId();
    const a = await makeMembership(repo, t, { startsOn: '2025-12-31', endsOn: '2026-01-31', term: 1 });
    const now = new Date(Date.UTC(2026, 1, 1)); // 2026-02-01
    await renewExpiringAgreements(t, { agreementRepo: repo, now });
    const updated = await repo.findById(t, a.id);
    expect(updated?.endsOn).toBe('2026-02-28');
  });

  it('a renewed membership is runnable again in the same sweep', async () => {
    // Renewal runs before runDueAgreements, so an agreement whose next run is
    // already due generates this cycle instead of waiting for the next sweep.
    const repo = new InMemoryAgreementRepository();
    const runRepo = new InMemoryAgreementRunRepository();
    const { jobsService, invoicesService } = makeMocks();
    const t = tenantId();
    const a = await makeMembership(repo, t, { startsOn: '2025-01-01', endsOn: '2026-01-01', term: 12 });
    // Term has lapsed; before renewal the agreement is not due (past ends_on).
    const now = new Date(Date.UTC(2026, 1, 2)); // 2026-02-02
    const before = await runDueAgreements(t, { agreementRepo: repo, runRepo, jobsService, invoicesService, now });
    expect(before.generatedRunIds.length).toBe(0);
    await renewExpiringAgreements(t, { agreementRepo: repo, now });
    const after = await runDueAgreements(t, { agreementRepo: repo, runRepo, jobsService, invoicesService, now });
    expect(after.generatedRunIds.length).toBe(1);
    void a;
  });
});

describe('membership member pricing: createAgreement / updateAgreement', () => {
  it('defaults memberDiscountBps to 0 and accepts a configured value', async () => {
    const repo = new InMemoryAgreementRepository();
    const t = tenantId();
    const plain = await createAgreement(
      {
        tenantId: t,
        customerId: uuidv4(),
        name: 'plain',
        recurrenceRule: 'FREQ=MONTHLY',
        priceCents: 1000,
        startsOn: '2026-01-01',
        createdBy: 'u',
      },
      repo,
    );
    expect(plain.memberDiscountBps).toBe(0);

    const member = await createAgreement(
      {
        tenantId: t,
        customerId: uuidv4(),
        name: 'Gold',
        recurrenceRule: 'FREQ=MONTHLY',
        priceCents: 1000,
        startsOn: '2026-01-01',
        memberDiscountBps: 1500,
        createdBy: 'u',
      },
      repo,
    );
    expect(member.memberDiscountBps).toBe(1500);
  });

  it('updateAgreement changes memberDiscountBps', async () => {
    const repo = new InMemoryAgreementRepository();
    const t = tenantId();
    const a = await createAgreement(
      {
        tenantId: t,
        customerId: uuidv4(),
        name: 'x',
        recurrenceRule: 'FREQ=MONTHLY',
        priceCents: 1000,
        startsOn: '2026-01-01',
        createdBy: 'u',
      },
      repo,
    );
    const updated = await updateAgreement(t, a.id, { memberDiscountBps: 2000 }, repo);
    expect(updated?.memberDiscountBps).toBe(2000);
  });
});
