import { describe, it, expect } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { InMemoryAgreementRepository } from '../../src/agreements/agreement';

describe('P9-003 InMemoryAgreementRepository CRUD + tenant isolation', () => {
  it('round-trips a row by id', async () => {
    const repo = new InMemoryAgreementRepository();
    const tenantId = uuidv4();
    const id = uuidv4();
    const now = new Date();
    await repo.create({
      id,
      tenantId,
      customerId: uuidv4(),
      name: 'name',
      recurrenceRule: 'FREQ=MONTHLY',
      priceCents: 1000,
      autoGenerateInvoice: true,
      autoGenerateJob: true,
      nextRunAt: now,
      status: 'active',
      startsOn: '2026-01-01',
      createdBy: 'u',
      createdAt: now,
      updatedAt: now,
    });
    const found = await repo.findById(tenantId, id);
    expect(found?.id).toBe(id);
  });

  it('returns null for cross-tenant findById', async () => {
    const repo = new InMemoryAgreementRepository();
    const tenantA = uuidv4();
    const tenantB = uuidv4();
    const id = uuidv4();
    const now = new Date();
    await repo.create({
      id,
      tenantId: tenantA,
      customerId: uuidv4(),
      name: 'name',
      recurrenceRule: 'FREQ=MONTHLY',
      priceCents: 1000,
      autoGenerateInvoice: true,
      autoGenerateJob: true,
      nextRunAt: now,
      status: 'active',
      startsOn: '2026-01-01',
      createdBy: 'u',
      createdAt: now,
      updatedAt: now,
    });
    expect(await repo.findById(tenantB, id)).toBeNull();
  });

  it('findByTenant filters by status', async () => {
    const repo = new InMemoryAgreementRepository();
    const tenantId = uuidv4();
    const now = new Date();
    for (const [i, status] of (['active', 'paused', 'cancelled'] as const).entries()) {
      await repo.create({
        id: uuidv4(),
        tenantId,
        customerId: uuidv4(),
        name: `${i}`,
        recurrenceRule: 'FREQ=MONTHLY',
        priceCents: 0,
        autoGenerateInvoice: true,
        autoGenerateJob: true,
        nextRunAt: now,
        status,
        startsOn: '2026-01-01',
        createdBy: 'u',
        createdAt: new Date(now.getTime() + i),
        updatedAt: now,
      });
    }
    const onlyActive = await repo.findByTenant(tenantId, { status: 'active' });
    expect(onlyActive.length).toBe(1);
    expect(onlyActive[0].status).toBe('active');
  });

  it('findDue filters by tenant + status + next_run_at', async () => {
    const repo = new InMemoryAgreementRepository();
    const tenantA = uuidv4();
    const tenantB = uuidv4();
    const now = new Date();
    await repo.create({
      id: uuidv4(),
      tenantId: tenantA,
      customerId: uuidv4(),
      name: 'A-due',
      recurrenceRule: 'FREQ=MONTHLY',
      priceCents: 0,
      autoGenerateInvoice: true,
      autoGenerateJob: true,
      nextRunAt: new Date(now.getTime() - 1000),
      status: 'active',
      startsOn: '2026-01-01',
      createdBy: 'u',
      createdAt: now,
      updatedAt: now,
    });
    await repo.create({
      id: uuidv4(),
      tenantId: tenantB,
      customerId: uuidv4(),
      name: 'B-due',
      recurrenceRule: 'FREQ=MONTHLY',
      priceCents: 0,
      autoGenerateInvoice: true,
      autoGenerateJob: true,
      nextRunAt: new Date(now.getTime() - 1000),
      status: 'active',
      startsOn: '2026-01-01',
      createdBy: 'u',
      createdAt: now,
      updatedAt: now,
    });
    const dueA = await repo.findDue(tenantA, now);
    expect(dueA.length).toBe(1);
    expect(dueA[0].name).toBe('A-due');
  });
});
