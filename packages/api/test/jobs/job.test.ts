import {
  createJob,
  getJob,
  updateJob,
  listJobs,
  validateJobInput,
  InMemoryJobRepository,
} from '../../src/jobs/job';
import { InMemoryAuditRepository } from '../../src/audit/audit';

describe('P1-005 — Job entity + CRUD', () => {
  let repo: InMemoryJobRepository;
  let auditRepo: InMemoryAuditRepository;

  beforeEach(() => {
    repo = new InMemoryJobRepository();
    auditRepo = new InMemoryAuditRepository();
  });

  it('happy path — creates job and retrieves it', async () => {
    const job = await createJob(
      {
        tenantId: 'tenant-1',
        customerId: 'cust-1',
        locationId: 'loc-1',
        summary: 'AC not cooling',
        createdBy: 'user-1',
      },
      repo,
      auditRepo
    );

    expect(job.id).toBeTruthy();
    expect(job.jobNumber).toBe('JOB-0001');
    expect(job.status).toBe('new');
    expect(job.priority).toBe('normal');

    const found = await getJob('tenant-1', job.id, repo);
    expect(found).not.toBeNull();
    expect(found!.summary).toBe('AC not cooling');
  });

  it('happy path — generates sequential job numbers', async () => {
    const job1 = await createJob(
      { tenantId: 'tenant-1', customerId: 'c-1', locationId: 'l-1', summary: 'Job 1', createdBy: 'u-1' },
      repo
    );
    const job2 = await createJob(
      { tenantId: 'tenant-1', customerId: 'c-1', locationId: 'l-1', summary: 'Job 2', createdBy: 'u-1' },
      repo
    );

    expect(job1.jobNumber).toBe('JOB-0001');
    expect(job2.jobNumber).toBe('JOB-0002');
  });

  it('happy path — updates job', async () => {
    const job = await createJob(
      { tenantId: 'tenant-1', customerId: 'c-1', locationId: 'l-1', summary: 'Fix leak', createdBy: 'u-1' },
      repo
    );

    const updated = await updateJob(
      'tenant-1',
      job.id,
      { priority: 'urgent', problemDescription: 'Water everywhere' },
      repo,
      'u-1',
      auditRepo
    );

    expect(updated!.priority).toBe('urgent');
    expect(updated!.problemDescription).toBe('Water everywhere');
  });

  it('happy path — lists jobs with filters', async () => {
    await createJob(
      { tenantId: 'tenant-1', customerId: 'c-1', locationId: 'l-1', summary: 'Job A', createdBy: 'u-1' },
      repo
    );
    await createJob(
      { tenantId: 'tenant-1', customerId: 'c-2', locationId: 'l-2', summary: 'Job B', createdBy: 'u-1' },
      repo
    );

    const byCustomer = await listJobs('tenant-1', repo, { customerId: 'c-1' });
    expect(byCustomer).toHaveLength(1);
    expect(byCustomer[0].summary).toBe('Job A');

    const bySearch = await listJobs('tenant-1', repo, { search: 'JOB-0002' });
    expect(bySearch).toHaveLength(1);
  });

  it('happy path — emits audit events', async () => {
    const job = await createJob(
      { tenantId: 'tenant-1', customerId: 'c-1', locationId: 'l-1', summary: 'Test', createdBy: 'u-1' },
      repo,
      auditRepo
    );

    const events = await auditRepo.findByEntity('tenant-1', 'job', job.id);
    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe('job.created');
  });

  it('validation — rejects missing required fields', () => {
    const errors = validateJobInput({
      tenantId: '',
      customerId: '',
      locationId: '',
      summary: '',
      createdBy: '',
    });
    expect(errors).toContain('tenantId is required');
    expect(errors).toContain('customerId is required');
    expect(errors).toContain('locationId is required');
    expect(errors).toContain('summary is required');
    expect(errors).toContain('createdBy is required');
  });

  it('validation — rejects invalid priority', () => {
    const errors = validateJobInput({
      tenantId: 't-1',
      customerId: 'c-1',
      locationId: 'l-1',
      summary: 'Test',
      priority: 'critical' as any,
      createdBy: 'u-1',
    });
    expect(errors).toContain('Invalid priority');
  });

  it('validation — createJob surfaces validator errors', async () => {
    await expect(
      createJob(
        {
          tenantId: 't-1',
          customerId: 'c-1',
          locationId: 'l-1',
          summary: 'Test',
          priority: 'critical' as any,
          createdBy: 'u-1',
        },
        repo
      )
    ).rejects.toThrow('Validation failed: Invalid priority');
  });

  it('tenant isolation — cross-tenant data inaccessible', async () => {
    const job = await createJob(
      { tenantId: 'tenant-1', customerId: 'c-1', locationId: 'l-1', summary: 'Test', createdBy: 'u-1' },
      repo
    );

    const found = await getJob('tenant-2', job.id, repo);
    expect(found).toBeNull();
  });
});
