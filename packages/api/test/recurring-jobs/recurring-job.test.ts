import { describe, it, expect, beforeEach } from 'vitest';
import {
  InMemoryRecurringJobRepository,
  archiveRecurringJob,
  createRecurringJob,
  updateRecurringJob,
  upcomingOccurrences,
  validateRecurringJobInput,
} from '../../src/recurring-jobs/recurring-job';
import { InMemoryAuditRepository } from '../../src/audit/audit';

const TENANT = '11111111-1111-1111-1111-111111111111';
const CUSTOMER = '22222222-2222-2222-2222-222222222222';
const ACTOR = 'user-1';

describe('recurring job series (R-JOB) — pure domain', () => {
  let repo: InMemoryRecurringJobRepository;
  let audit: InMemoryAuditRepository;

  beforeEach(() => {
    repo = new InMemoryRecurringJobRepository();
    audit = new InMemoryAuditRepository();
  });

  it('validates required fields and the rule', () => {
    expect(
      validateRecurringJobInput({ title: '', customerId: '', anchorDate: 'bad' }),
    ).toEqual(
      expect.arrayContaining([
        'title is required',
        'customerId is required',
        'anchorDate must be a date (YYYY-MM-DD)',
        'rule is required',
      ]),
    );
    expect(
      validateRecurringJobInput({
        title: 'Maint',
        customerId: CUSTOMER,
        anchorDate: '2026-06-01',
        rule: { frequency: 'monthly', interval: 1 },
      }),
    ).toHaveLength(0);
  });

  it('creates a series, defaults interval, and emits an audit event', async () => {
    const job = await createRecurringJob(
      {
        tenantId: TENANT,
        customerId: CUSTOMER,
        title: 'Monthly filter change',
        anchorDate: '2026-06-15',
        rule: { frequency: 'monthly' } as never,
        createdBy: ACTOR,
      },
      repo,
      audit,
    );
    expect(job.rule.interval).toBe(1);
    const events = await audit.findByEntity(TENANT, 'recurring_job', job.id);
    expect(events[0].eventType).toBe('recurring_job.created');
  });

  it('computes upcoming occurrences, filtering past dates', async () => {
    const job = await createRecurringJob(
      {
        tenantId: TENANT,
        customerId: CUSTOMER,
        title: 'Weekly lawn',
        anchorDate: '2026-06-01',
        rule: { frequency: 'weekly', interval: 1, count: 8 },
        createdBy: ACTOR,
      },
      repo,
    );
    expect(upcomingOccurrences(job, undefined, 3)).toEqual([
      '2026-06-01',
      '2026-06-08',
      '2026-06-15',
    ]);
    // From a mid-series date, only later visits remain.
    expect(upcomingOccurrences(job, '2026-06-20', 3)).toEqual([
      '2026-06-22',
      '2026-06-29',
      '2026-07-06',
    ]);
  });

  it('finds upcoming visits even when the anchor is long before `from`', async () => {
    // Daily series anchored ~90 days before the `from` date: the early window
    // is entirely in the past, so a fixed cap would filter everything out.
    const job = await createRecurringJob(
      {
        tenantId: TENANT,
        customerId: CUSTOMER,
        title: 'Daily check',
        anchorDate: '2026-01-01',
        rule: { frequency: 'daily', interval: 1 },
        createdBy: ACTOR,
      },
      repo,
    );
    expect(upcomingOccurrences(job, '2026-04-01', 3)).toEqual([
      '2026-04-01',
      '2026-04-02',
      '2026-04-03',
    ]);
  });

  it('returns only the remaining tail of a count-bounded series past `from`', async () => {
    const job = await createRecurringJob(
      {
        tenantId: TENANT,
        customerId: CUSTOMER,
        title: 'Five visits',
        anchorDate: '2026-06-01',
        rule: { frequency: 'weekly', interval: 1, count: 5 },
        createdBy: ACTOR,
      },
      repo,
    );
    // Anchor Jun 1; visits Jun 1/8/15/22/29. From Jun 20 only the last two remain.
    expect(upcomingOccurrences(job, '2026-06-20', 10)).toEqual(['2026-06-22', '2026-06-29']);
  });

  it('updates a series and re-validates the merged rule', async () => {
    const job = await createRecurringJob(
      {
        tenantId: TENANT,
        customerId: CUSTOMER,
        title: 'Maint',
        anchorDate: '2026-06-01',
        rule: { frequency: 'weekly', interval: 1 },
        createdBy: ACTOR,
      },
      repo,
    );
    const updated = await updateRecurringJob(
      TENANT,
      job.id,
      { rule: { frequency: 'monthly', interval: 2 } },
      repo,
      ACTOR,
      audit,
    );
    expect(updated.rule).toMatchObject({ frequency: 'monthly', interval: 2 });
    expect(updated.title).toBe('Maint');
  });

  it('archives a series (drops out of the active list)', async () => {
    const job = await createRecurringJob(
      {
        tenantId: TENANT,
        customerId: CUSTOMER,
        title: 'Maint',
        anchorDate: '2026-06-01',
        rule: { frequency: 'weekly', interval: 1 },
        createdBy: ACTOR,
      },
      repo,
    );
    await archiveRecurringJob(TENANT, job.id, repo, ACTOR, audit);
    expect(await repo.list(TENANT)).toHaveLength(0);
    expect(await repo.list(TENANT, { includeArchived: true })).toHaveLength(1);
  });

  it('filters by customer and isolates by tenant', async () => {
    await createRecurringJob(
      { tenantId: TENANT, customerId: CUSTOMER, title: 'A', anchorDate: '2026-06-01', rule: { frequency: 'weekly', interval: 1 }, createdBy: ACTOR },
      repo,
    );
    const other = '99999999-9999-9999-9999-999999999999';
    expect(await repo.list(TENANT, { customerId: other })).toHaveLength(0);
    expect(await repo.list('00000000-0000-0000-0000-000000000000')).toHaveLength(0);
  });
});
