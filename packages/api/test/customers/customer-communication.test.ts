import {
  createCustomer,
  updateCustomer,
  validateCustomerInput,
  InMemoryCustomerRepository,
} from '../../src/customers/customer';

describe('P1-002 — Customer communication methods', () => {
  let repo: InMemoryCustomerRepository;

  beforeEach(() => {
    repo = new InMemoryCustomerRepository();
  });

  it('happy path — creates customer with all communication fields', async () => {
    const customer = await createCustomer(
      {
        tenantId: 'tenant-1',
        firstName: 'John',
        lastName: 'Doe',
        primaryPhone: '555-123-4567',
        secondaryPhone: '555-987-6543',
        email: 'john@example.com',
        preferredChannel: 'email',
        smsConsent: true,
        communicationNotes: 'Prefers evening calls',
        createdBy: 'user-1',
      },
      repo
    );

    expect(customer.primaryPhone).toBe('555-123-4567');
    expect(customer.secondaryPhone).toBe('555-987-6543');
    expect(customer.email).toBe('john@example.com');
    expect(customer.preferredChannel).toBe('email');
    expect(customer.smsConsent).toBe(true);
    expect(customer.communicationNotes).toBe('Prefers evening calls');
  });

  it('happy path — defaults preferredChannel to none', async () => {
    const customer = await createCustomer(
      { tenantId: 'tenant-1', firstName: 'John', lastName: 'Doe', createdBy: 'user-1' },
      repo
    );
    expect(customer.preferredChannel).toBe('none');
    expect(customer.smsConsent).toBe(false);
  });

  it('happy path — updates communication fields', async () => {
    const customer = await createCustomer(
      { tenantId: 'tenant-1', firstName: 'John', lastName: 'Doe', createdBy: 'user-1' },
      repo
    );

    const updated = await updateCustomer(
      'tenant-1',
      customer.id,
      {
        primaryPhone: '555-111-2222',
        email: 'new@example.com',
        preferredChannel: 'sms',
        smsConsent: true,
      },
      repo
    );

    expect(updated!.primaryPhone).toBe('555-111-2222');
    expect(updated!.email).toBe('new@example.com');
    expect(updated!.preferredChannel).toBe('sms');
    expect(updated!.smsConsent).toBe(true);
  });

  it('validation — rejects invalid phone format', () => {
    const errors = validateCustomerInput({
      tenantId: 'tenant-1',
      firstName: 'John',
      lastName: 'Doe',
      primaryPhone: '123',
      createdBy: 'user-1',
    });
    expect(errors).toContain('Invalid primaryPhone format');
  });

  it('validation — rejects invalid secondary phone format', () => {
    const errors = validateCustomerInput({
      tenantId: 'tenant-1',
      firstName: 'John',
      lastName: 'Doe',
      secondaryPhone: 'abc',
      createdBy: 'user-1',
    });
    expect(errors).toContain('Invalid secondaryPhone format');
  });

  it('validation — rejects invalid email format', () => {
    const errors = validateCustomerInput({
      tenantId: 'tenant-1',
      firstName: 'John',
      lastName: 'Doe',
      email: 'not-an-email',
      createdBy: 'user-1',
    });
    expect(errors).toContain('Invalid email format');
  });

  it('validation — rejects invalid preferredChannel', () => {
    const errors = validateCustomerInput({
      tenantId: 'tenant-1',
      firstName: 'John',
      lastName: 'Doe',
      preferredChannel: 'pigeon' as any,
      createdBy: 'user-1',
    });
    expect(errors).toContain('Invalid preferredChannel');
  });

  it('tenant isolation — cross-tenant communication data inaccessible', async () => {
    const customer = await createCustomer(
      {
        tenantId: 'tenant-1',
        firstName: 'John',
        lastName: 'Doe',
        email: 'john@example.com',
        createdBy: 'user-1',
      },
      repo
    );

    const found = await repo.findById('tenant-2', customer.id);
    expect(found).toBeNull();
  });
});
