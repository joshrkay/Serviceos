import {
  createTimeToCashEvent,
  validateTimeToCashEventInput,
  VALID_MILESTONES,
  InMemoryTimeToCashEventRepository,
  TimeToCashMilestone,
} from '../../src/invoices/analytics';

describe('P5-013A — Time-to-cash event model', () => {
  let repo: InMemoryTimeToCashEventRepository;

  const tenantId = 'tenant-1';
  const jobId = 'job-1';

  beforeEach(() => {
    repo = new InMemoryTimeToCashEventRepository();
  });

  it('happy path — creates event for each milestone type', async () => {
    for (const milestone of VALID_MILESTONES) {
      const event = await createTimeToCashEvent({
        tenantId,
        jobId,
        milestone,
        occurredAt: new Date(),
      }, repo);
      expect(event.id).toBeTruthy();
      expect(event.milestone).toBe(milestone);
    }

    const events = await repo.findByJob(tenantId, jobId);
    expect(events).toHaveLength(VALID_MILESTONES.length);
  });

  it('happy path — creates event with invoice reference', async () => {
    const event = await createTimeToCashEvent({
      tenantId,
      jobId,
      invoiceId: 'inv-1',
      milestone: 'invoice_drafted',
      occurredAt: new Date(),
    }, repo);

    expect(event.invoiceId).toBe('inv-1');
  });

  it('happy path — creates event with metadata', async () => {
    const event = await createTimeToCashEvent({
      tenantId,
      jobId,
      milestone: 'fully_paid',
      occurredAt: new Date(),
      metadata: { paymentMethod: 'credit_card' },
    }, repo);

    expect(event.metadata).toEqual({ paymentMethod: 'credit_card' });
  });

  it('validation — required fields', () => {
    const errors = validateTimeToCashEventInput({
      tenantId: '',
      jobId: '',
      milestone: '' as TimeToCashMilestone,
      occurredAt: undefined as unknown as Date,
    });
    expect(errors).toContain('tenantId is required');
    expect(errors).toContain('jobId is required');
    expect(errors).toContain('milestone is required');
    expect(errors).toContain('occurredAt is required');
  });

  it('validation — invalid milestone', () => {
    const errors = validateTimeToCashEventInput({
      tenantId,
      jobId,
      milestone: 'invalid_milestone' as TimeToCashMilestone,
      occurredAt: new Date(),
    });
    expect(errors).toContain('Invalid milestone');
  });

  it('tenant isolation — cross-tenant query returns empty', async () => {
    await createTimeToCashEvent({
      tenantId,
      jobId,
      milestone: 'job_completed',
      occurredAt: new Date(),
    }, repo);

    const events = await repo.findByJob('tenant-2', jobId);
    expect(events).toHaveLength(0);
  });

  it('query — findByJob returns correct events', async () => {
    await createTimeToCashEvent({ tenantId, jobId: 'job-1', milestone: 'job_completed', occurredAt: new Date() }, repo);
    await createTimeToCashEvent({ tenantId, jobId: 'job-2', milestone: 'job_completed', occurredAt: new Date() }, repo);

    const job1Events = await repo.findByJob(tenantId, 'job-1');
    expect(job1Events).toHaveLength(1);
  });

  it('query — findByInvoice returns correct events', async () => {
    await createTimeToCashEvent({ tenantId, jobId, invoiceId: 'inv-1', milestone: 'invoice_drafted', occurredAt: new Date() }, repo);
    await createTimeToCashEvent({ tenantId, jobId, invoiceId: 'inv-2', milestone: 'invoice_drafted', occurredAt: new Date() }, repo);

    const inv1Events = await repo.findByInvoice(tenantId, 'inv-1');
    expect(inv1Events).toHaveLength(1);
  });

  it('ordering — events returned in chronological order', async () => {
    const t1 = new Date('2024-01-01');
    const t2 = new Date('2024-01-02');
    const t3 = new Date('2024-01-03');

    await createTimeToCashEvent({ tenantId, jobId, milestone: 'invoice_approved', occurredAt: t3 }, repo);
    await createTimeToCashEvent({ tenantId, jobId, milestone: 'job_completed', occurredAt: t1 }, repo);
    await createTimeToCashEvent({ tenantId, jobId, milestone: 'invoice_drafted', occurredAt: t2 }, repo);

    const events = await repo.findByJob(tenantId, jobId);
    expect(events[0].milestone).toBe('job_completed');
    expect(events[1].milestone).toBe('invoice_drafted');
    expect(events[2].milestone).toBe('invoice_approved');
  });
});
