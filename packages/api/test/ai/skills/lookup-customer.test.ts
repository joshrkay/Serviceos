import { describe, it, expect, beforeEach } from 'vitest';
import { lookupCustomer } from '../../../src/ai/skills/lookup-customer';
import {
  createCustomer,
  InMemoryCustomerRepository,
} from '../../../src/customers/customer';
import { InMemoryLookupEventRepository } from '../../../src/lookup-events/lookup-event';
import { LookupEventService } from '../../../src/lookup-events/lookup-event-service';

describe('VQ-006 — lookupCustomer skill', () => {
  let customerRepo: InMemoryCustomerRepository;
  let lookupRepo: InMemoryLookupEventRepository;
  let lookupEvents: LookupEventService;

  beforeEach(() => {
    customerRepo = new InMemoryCustomerRepository();
    lookupRepo = new InMemoryLookupEventRepository();
    lookupEvents = new LookupEventService(lookupRepo);
  });

  it('VQ-006 — happy path: lookup by ID returns customer', async () => {
    const created = await createCustomer(
      {
        tenantId: 'tenant-1',
        firstName: 'Jane',
        lastName: 'Smith',
        primaryPhone: '+15551234567',
        email: 'jane@example.com',
        createdBy: 'u-1',
      },
      customerRepo,
    );

    const result = await lookupCustomer(
      {
        tenantId: 'tenant-1',
        identifier: { type: 'id', value: created.id },
      },
      { customerRepo, lookupEvents },
    );

    expect(result.status).toBe('found');
    if (result.status !== 'found') return;
    expect(result.data.customers).toHaveLength(1);
    expect(result.data.customers[0].customerId).toBe(created.id);
    expect(result.data.customers[0].displayName).toBe('Jane Smith');
    expect(result.summary.toLowerCase()).toContain('jane smith');
  });

  it('VQ-006 — lookup by phone matches normalized phone', async () => {
    await createCustomer(
      {
        tenantId: 'tenant-1',
        firstName: 'Bob',
        lastName: 'Jones',
        primaryPhone: '(555) 234-5678',
        createdBy: 'u-1',
      },
      customerRepo,
    );

    const result = await lookupCustomer(
      {
        tenantId: 'tenant-1',
        identifier: { type: 'phone', value: '+15552345678' },
      },
      { customerRepo, lookupEvents },
    );

    expect(result.status).toBe('found');
    if (result.status !== 'found') return;
    expect(result.data.customers).toHaveLength(1);
    expect(result.data.customers[0].displayName).toBe('Bob Jones');
    // Phone is masked — only last 4 should be readable.
    expect(result.data.customers[0].primaryPhoneMasked).not.toBe('(555) 234-5678');
    expect(result.data.customers[0].primaryPhoneMasked).toContain('5678');
  });

  it('VQ-006 — multiple matches returns array', async () => {
    await createCustomer(
      {
        tenantId: 'tenant-1',
        firstName: 'Alice',
        lastName: 'A',
        primaryPhone: '+15559999999',
        createdBy: 'u-1',
      },
      customerRepo,
    );
    await createCustomer(
      {
        tenantId: 'tenant-1',
        firstName: 'Bob',
        lastName: 'B',
        primaryPhone: '+15559999999',
        createdBy: 'u-1',
      },
      customerRepo,
    );

    const result = await lookupCustomer(
      {
        tenantId: 'tenant-1',
        identifier: { type: 'phone', value: '+15559999999' },
      },
      { customerRepo, lookupEvents },
    );

    expect(result.status).toBe('found');
    if (result.status !== 'found') return;
    expect(result.data.customers).toHaveLength(2);
  });

  it('VQ-006 — not-found returns empty result without error', async () => {
    const result = await lookupCustomer(
      {
        tenantId: 'tenant-1',
        identifier: { type: 'id', value: 'does-not-exist' },
      },
      { customerRepo, lookupEvents },
    );

    expect(result.status).toBe('none');
    if (result.status !== 'none') return;
    expect(result.data.customers).toEqual([]);
    expect(result.summary.toLowerCase()).toContain("not seeing");
  });

  it('VQ-006 — tenant isolation: customer in tenant A invisible from tenant B', async () => {
    const created = await createCustomer(
      {
        tenantId: 'tenant-A',
        firstName: 'Carol',
        lastName: 'C',
        primaryPhone: '+15558888888',
        createdBy: 'u-1',
      },
      customerRepo,
    );

    const byId = await lookupCustomer(
      {
        tenantId: 'tenant-B',
        identifier: { type: 'id', value: created.id },
      },
      { customerRepo, lookupEvents },
    );
    expect(byId.status).toBe('none');

    const byPhone = await lookupCustomer(
      {
        tenantId: 'tenant-B',
        identifier: { type: 'phone', value: '+15558888888' },
      },
      { customerRepo, lookupEvents },
    );
    expect(byPhone.status).toBe('none');
  });

  it('VQ-006 — audit: writes a lookup_events row on each invocation', async () => {
    const created = await createCustomer(
      {
        tenantId: 'tenant-1',
        firstName: 'Dee',
        lastName: 'D',
        createdBy: 'u-1',
      },
      customerRepo,
    );

    await lookupCustomer(
      {
        tenantId: 'tenant-1',
        identifier: { type: 'id', value: created.id },
        sessionId: 'sess-9',
      },
      { customerRepo, lookupEvents },
    );

    const rows = await lookupRepo.listByTenant('tenant-1');
    expect(rows).toHaveLength(1);
    expect(rows[0].intent).toBe('lookup_customer');
    expect(rows[0].sessionId).toBe('sess-9');
  });
});
