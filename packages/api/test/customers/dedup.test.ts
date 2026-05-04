import {
  checkCustomerDuplicates,
  normalizePhone,
  normalizeEmail,
  normalizeName,
} from '../../src/customers/dedup';
import { createCustomer, InMemoryCustomerRepository } from '../../src/customers/customer';

describe('P1-004 — Deterministic duplicate prevention (customers)', () => {
  let repo: InMemoryCustomerRepository;

  beforeEach(async () => {
    repo = new InMemoryCustomerRepository();
    await createCustomer(
      {
        tenantId: 'tenant-1',
        firstName: 'John',
        lastName: 'Doe',
        email: 'john@example.com',
        primaryPhone: '555-123-4567',
        createdBy: 'user-1',
      },
      repo
    );
  });

  it('happy path — no duplicates found for unique customer', async () => {
    const warnings = await checkCustomerDuplicates(
      {
        tenantId: 'tenant-1',
        firstName: 'Jane',
        lastName: 'Smith',
        email: 'jane@example.com',
        primaryPhone: '555-999-8888',
      },
      repo
    );
    expect(warnings).toHaveLength(0);
  });

  it('happy path — detects phone match', async () => {
    const warnings = await checkCustomerDuplicates(
      {
        tenantId: 'tenant-1',
        firstName: 'Different',
        lastName: 'Person',
        primaryPhone: '(555) 123-4567',
      },
      repo
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0].matchType).toBe('phone');
    expect(warnings[0].confidence).toBe('high');
  });

  it('happy path — detects email match', async () => {
    const warnings = await checkCustomerDuplicates(
      {
        tenantId: 'tenant-1',
        firstName: 'Different',
        lastName: 'Person',
        email: 'JOHN@EXAMPLE.COM',
      },
      repo
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0].matchType).toBe('email');
    expect(warnings[0].confidence).toBe('high');
  });

  it('happy path — detects name match', async () => {
    const warnings = await checkCustomerDuplicates(
      {
        tenantId: 'tenant-1',
        firstName: 'john',
        lastName: 'doe',
      },
      repo
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0].matchType).toBe('name');
    expect(warnings[0].confidence).toBe('medium');
  });

  it('normalizePhone — strips non-digits', () => {
    expect(normalizePhone('(555) 123-4567')).toBe('5551234567');
    expect(normalizePhone('+1-555-123-4567')).toBe('15551234567');
  });

  it('normalizeEmail — lowercases and trims', () => {
    expect(normalizeEmail('  John@Example.COM  ')).toBe('john@example.com');
  });

  it('normalizeName — lowercases and normalizes whitespace', () => {
    expect(normalizeName('  John   Doe  ')).toBe('john doe');
  });

  it('validation — no false positives for different tenant', async () => {
    const warnings = await checkCustomerDuplicates(
      {
        tenantId: 'tenant-2',
        firstName: 'John',
        lastName: 'Doe',
        email: 'john@example.com',
      },
      repo
    );
    expect(warnings).toHaveLength(0);
  });
});
