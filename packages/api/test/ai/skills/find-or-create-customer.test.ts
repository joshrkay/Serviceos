import { describe, it, expect, vi } from 'vitest';
import {
  findOrCreateCustomerByPhone,
  callerDisplayName,
} from '../../../src/ai/skills/find-or-create-customer';
import type { Customer, CustomerRepository } from '../../../src/customers/customer';
import { normalizePhone } from '../../../src/shared/phone';

const TENANT = 'tenant-1';

function customer(over: Partial<Customer> & { id: string; primaryPhone?: string }): Customer {
  return {
    tenantId: TENANT,
    firstName: '',
    lastName: '',
    displayName: 'Seed',
    preferredChannel: 'phone',
    smsConsent: false,
    isArchived: false,
    createdBy: 'seed',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  };
}

function makeRepo(seed: Customer[] = []) {
  const rows = [...seed];
  const create = vi.fn(async (c: Customer) => {
    rows.push(c);
    return c;
  });
  const repo = {
    create,
    findById: async (t: string, id: string) => rows.find((r) => r.id === id && r.tenantId === t) ?? null,
    findByTenant: async () => rows,
    update: async () => null,
    search: async () => [],
    findByPhoneNormalized: async (t: string, pn: string) =>
      rows.filter(
        (r) => r.tenantId === t && r.primaryPhone && normalizePhone(r.primaryPhone).endsWith(pn.slice(-10)),
      ),
  } as unknown as CustomerRepository;
  return { repo, rows, create };
}

describe('callerDisplayName', () => {
  it('prefers the spoken name', () => {
    expect(callerDisplayName({ firstName: 'Jane', lastName: 'Smith', rawPhone: '+15125550100' })).toBe('Jane Smith');
  });
  it('falls back to company, then a masked-phone placeholder', () => {
    expect(callerDisplayName({ companyName: 'Acme HVAC', rawPhone: '+15125550100' })).toBe('Acme HVAC');
    expect(callerDisplayName({ rawPhone: '+15125550100' })).toMatch(/^Caller .*0100$/);
  });
});

describe('findOrCreateCustomerByPhone', () => {
  const input = (over = {}) => ({ tenantId: TENANT, fromPhone: '+15125550100', ...over });

  it('returns an existing customer matched by phone without creating one', async () => {
    const existing = customer({ id: 'c1', primaryPhone: '+15125550100', displayName: 'Jane Smith' });
    const { repo, create } = makeRepo([existing]);
    const res = await findOrCreateCustomerByPhone({ ...input(), customerRepo: repo });
    expect(res.status).toBe('found');
    expect(res.customerId).toBe('c1');
    expect(create).not.toHaveBeenCalled();
  });

  it('creates a new customer (phone + placeholder name) and audits when none matches', async () => {
    const { repo, create } = makeRepo([]);
    const audit = { create: vi.fn() };
    const res = await findOrCreateCustomerByPhone({ ...input(), customerRepo: repo, auditRepo: audit });
    expect(res.status).toBe('created');
    expect(create).toHaveBeenCalledTimes(1);
    expect(res.customer.primaryPhone).toBe('+15125550100');
    expect(res.customer.displayName).toMatch(/^Caller .*0100$/);
    expect(res.customer.createdBy).toBe('system:inbound-call');
    expect(audit.create).toHaveBeenCalledTimes(1);
    const event = audit.create.mock.calls[0][0];
    expect(event.eventType).toBe('customer.created');
    expect(event.metadata).toMatchObject({ source: 'inbound_call' });
  });

  it('uses a captured name for the new customer', async () => {
    const { repo } = makeRepo([]);
    const res = await findOrCreateCustomerByPhone({
      ...input(),
      customerRepo: repo,
      firstName: 'Jane',
      lastName: 'Smith',
    });
    expect(res.status).toBe('created');
    expect(res.customer.displayName).toBe('Jane Smith');
    expect(res.customer.firstName).toBe('Jane');
  });

  it('prefers a non-archived match over an archived one', async () => {
    const archived = customer({ id: 'old', primaryPhone: '+15125550100', isArchived: true });
    const active = customer({ id: 'new', primaryPhone: '+15125550100', isArchived: false });
    const { repo } = makeRepo([archived, active]);
    const res = await findOrCreateCustomerByPhone({ ...input(), customerRepo: repo });
    expect(res).toMatchObject({ status: 'found', customerId: 'new' });
  });

  it('creates without a lookup when the phone is too short to match reliably', async () => {
    const { repo, create } = makeRepo([]);
    const res = await findOrCreateCustomerByPhone({ ...input({ fromPhone: '123' }), customerRepo: repo });
    expect(res.status).toBe('created');
    expect(create).toHaveBeenCalledTimes(1);
  });
});
