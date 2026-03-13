import {
  assembleInvoiceContext,
  validateInvoiceContextInput,
  InMemoryJobRepository,
  InMemoryCustomerRepository,
  InMemoryTenantSettingsRepository,
} from '../../src/invoices/invoice-context';

describe('P5-002A — Invoice context from job/customer/settings', () => {
  let jobRepo: InMemoryJobRepository;
  let customerRepo: InMemoryCustomerRepository;
  let settingsRepo: InMemoryTenantSettingsRepository;

  const tenantId = 'tenant-1';
  const jobId = 'job-1';
  const customerId = 'cust-1';

  beforeEach(() => {
    jobRepo = new InMemoryJobRepository();
    customerRepo = new InMemoryCustomerRepository();
    settingsRepo = new InMemoryTenantSettingsRepository();

    jobRepo.addJob(tenantId, {
      id: jobId,
      title: 'AC Repair',
      description: 'Fix broken AC unit',
      status: 'completed',
      completedAt: new Date(),
      customerId,
    });

    customerRepo.addCustomer(tenantId, {
      id: customerId,
      name: 'John Doe',
      email: 'john@example.com',
      phone: '555-1234',
      address: '123 Main St',
    });

    settingsRepo.setSettings(tenantId, {
      defaultTaxRateBps: 825,
      invoiceNumberPrefix: 'INV-',
      nextInvoiceNumber: 42,
      defaultPaymentTermDays: 30,
      currency: 'USD',
    });
  });

  it('happy path — assembles full context', async () => {
    const ctx = await assembleInvoiceContext(tenantId, jobId, customerId, {
      jobRepo, customerRepo, settingsRepo,
    });

    expect(ctx.tenantId).toBe(tenantId);
    expect(ctx.job.id).toBe(jobId);
    expect(ctx.job.title).toBe('AC Repair');
    expect(ctx.customer.id).toBe(customerId);
    expect(ctx.customer.name).toBe('John Doe');
    expect(ctx.tenantSettings.defaultTaxRateBps).toBe(825);
    expect(ctx.tenantSettings.currency).toBe('USD');
  });

  it('validation — missing tenantId rejected', () => {
    const errors = validateInvoiceContextInput('', jobId, customerId);
    expect(errors).toContain('tenantId is required');
  });

  it('validation — missing jobId rejected', () => {
    const errors = validateInvoiceContextInput(tenantId, '', customerId);
    expect(errors).toContain('jobId is required');
  });

  it('validation — missing customerId rejected', () => {
    const errors = validateInvoiceContextInput(tenantId, jobId, '');
    expect(errors).toContain('customerId is required');
  });

  it('tenant isolation — cross-tenant job not found', async () => {
    await expect(
      assembleInvoiceContext('tenant-2', jobId, customerId, {
        jobRepo, customerRepo, settingsRepo,
      })
    ).rejects.toThrow('Job not found');
  });

  it('tenant isolation — cross-tenant customer not found', async () => {
    jobRepo.addJob('tenant-2', {
      id: jobId,
      title: 'AC Repair',
      status: 'completed',
      customerId,
    });

    await expect(
      assembleInvoiceContext('tenant-2', jobId, customerId, {
        jobRepo, customerRepo, settingsRepo,
      })
    ).rejects.toThrow('Customer not found');
  });

  it('mock provider — uses InMemory repositories correctly', async () => {
    const ctx = await assembleInvoiceContext(tenantId, jobId, customerId, {
      jobRepo, customerRepo, settingsRepo,
    });
    expect(ctx).toBeDefined();
    expect(ctx.job).toBeDefined();
    expect(ctx.customer).toBeDefined();
    expect(ctx.tenantSettings).toBeDefined();
  });

  it('missing job — throws error', async () => {
    await expect(
      assembleInvoiceContext(tenantId, 'nonexistent', customerId, {
        jobRepo, customerRepo, settingsRepo,
      })
    ).rejects.toThrow('Job not found');
  });
});
