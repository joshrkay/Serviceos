import {
  createCustomer,
  getCustomer,
  updateCustomer,
  archiveCustomer,
  restoreCustomer,
  listCustomers,
  searchCustomers,
  validateCustomerInput,
  InMemoryCustomerRepository,
} from '../../src/customers/customer';
import { InMemoryAuditRepository } from '../../src/audit/audit';

describe('P1-001 — Customer entity + CRUD', () => {
  let repo: InMemoryCustomerRepository;
  let auditRepo: InMemoryAuditRepository;

  beforeEach(() => {
    repo = new InMemoryCustomerRepository();
    auditRepo = new InMemoryAuditRepository();
  });

  it('happy path — creates customer and retrieves it', async () => {
    const customer = await createCustomer(
      {
        tenantId: 'tenant-1',
        firstName: 'John',
        lastName: 'Doe',
        createdBy: 'user-1',
      },
      repo,
      auditRepo
    );

    expect(customer.id).toBeTruthy();
    expect(customer.displayName).toBe('John Doe');
    expect(customer.isArchived).toBe(false);

    const found = await getCustomer('tenant-1', customer.id, repo);
    expect(found).not.toBeNull();
    expect(found!.firstName).toBe('John');
  });

  it('happy path — creates customer with company name only', async () => {
    const customer = await createCustomer(
      {
        tenantId: 'tenant-1',
        firstName: '',
        lastName: '',
        companyName: 'ACME Corp',
        createdBy: 'user-1',
      },
      repo
    );

    expect(customer.displayName).toBe('ACME Corp');
  });

  it('happy path — updates customer', async () => {
    const customer = await createCustomer(
      { tenantId: 'tenant-1', firstName: 'John', lastName: 'Doe', createdBy: 'user-1' },
      repo
    );

    const updated = await updateCustomer(
      'tenant-1',
      customer.id,
      { firstName: 'Jane' },
      repo,
      'user-1',
      auditRepo
    );

    expect(updated!.firstName).toBe('Jane');
    expect(updated!.displayName).toBe('Jane Doe');
  });

  it('happy path — archives and restores customer', async () => {
    const customer = await createCustomer(
      { tenantId: 'tenant-1', firstName: 'John', lastName: 'Doe', createdBy: 'user-1' },
      repo
    );

    const archived = await archiveCustomer('tenant-1', customer.id, repo, 'user-1', auditRepo);
    expect(archived!.isArchived).toBe(true);
    expect(archived!.archivedAt).toBeTruthy();

    const restored = await restoreCustomer('tenant-1', customer.id, repo, 'user-1', auditRepo);
    expect(restored!.isArchived).toBe(false);
  });

  it('happy path — lists customers excluding archived', async () => {
    await createCustomer(
      { tenantId: 'tenant-1', firstName: 'Active', lastName: 'User', createdBy: 'user-1' },
      repo
    );
    const toArchive = await createCustomer(
      { tenantId: 'tenant-1', firstName: 'Archived', lastName: 'User', createdBy: 'user-1' },
      repo
    );
    await archiveCustomer('tenant-1', toArchive.id, repo);

    const active = await listCustomers('tenant-1', repo);
    expect(active).toHaveLength(1);
    expect(active[0].firstName).toBe('Active');

    const all = await listCustomers('tenant-1', repo, { includeArchived: true });
    expect(all).toHaveLength(2);
  });

  it('happy path — searches customers', async () => {
    await createCustomer(
      { tenantId: 'tenant-1', firstName: 'John', lastName: 'Doe', createdBy: 'user-1' },
      repo
    );
    await createCustomer(
      { tenantId: 'tenant-1', firstName: 'Jane', lastName: 'Smith', createdBy: 'user-1' },
      repo
    );

    const results = await searchCustomers('tenant-1', 'john', repo);
    expect(results).toHaveLength(1);
    expect(results[0].firstName).toBe('John');
  });

  it('happy path — emits audit events', async () => {
    const customer = await createCustomer(
      { tenantId: 'tenant-1', firstName: 'John', lastName: 'Doe', createdBy: 'user-1' },
      repo,
      auditRepo
    );

    const events = await auditRepo.findByEntity('tenant-1', 'customer', customer.id);
    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe('customer.created');
  });

  it('validation — rejects missing name and company', () => {
    const errors = validateCustomerInput({
      tenantId: 'tenant-1',
      firstName: '',
      lastName: '',
      createdBy: 'user-1',
    });
    expect(errors).toContain('firstName or companyName is required');
  });

  it('validation — rejects missing tenantId', () => {
    const errors = validateCustomerInput({
      tenantId: '',
      firstName: 'John',
      lastName: 'Doe',
      createdBy: 'user-1',
    });
    expect(errors).toContain('tenantId is required');
  });

  it('validation — rejects missing createdBy', () => {
    const errors = validateCustomerInput({
      tenantId: 'tenant-1',
      firstName: 'John',
      lastName: 'Doe',
      createdBy: '',
    });
    expect(errors).toContain('createdBy is required');
  });

  it('tenant isolation — cross-tenant data inaccessible', async () => {
    const customer = await createCustomer(
      { tenantId: 'tenant-1', firstName: 'John', lastName: 'Doe', createdBy: 'user-1' },
      repo
    );

    const found = await getCustomer('tenant-2', customer.id, repo);
    expect(found).toBeNull();
  });
});
