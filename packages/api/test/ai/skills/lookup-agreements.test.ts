import { describe, it, expect, beforeEach } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { lookupAgreements } from '../../../src/ai/skills/lookup-agreements';
import { InMemoryAgreementRepository } from '../../../src/agreements/agreement';

async function seedAgreement(
  repo: InMemoryAgreementRepository,
  opts: {
    tenantId: string;
    customerId: string;
    name: string;
    nextRunAt: Date;
    status?: 'active' | 'paused' | 'cancelled';
  },
) {
  const now = new Date();
  return repo.create({
    id: uuidv4(),
    tenantId: opts.tenantId,
    customerId: opts.customerId,
    name: opts.name,
    recurrenceRule: 'FREQ=MONTHLY',
    priceCents: 9900,
    autoGenerateInvoice: true,
    autoGenerateJob: true,
    nextRunAt: opts.nextRunAt,
    status: opts.status ?? 'active',
    startsOn: '2026-01-01',
    createdBy: 'u-1',
    createdAt: now,
    updatedAt: now,
  });
}

describe('P11-001 — lookupAgreements skill', () => {
  let agreementRepo: InMemoryAgreementRepository;

  beforeEach(() => {
    agreementRepo = new InMemoryAgreementRepository();
  });

  it('happy path — surfaces active agreements with next run', async () => {
    await seedAgreement(agreementRepo, {
      tenantId: 'tenant-1',
      customerId: 'cust-1',
      name: 'Gold Plan',
      nextRunAt: new Date('2026-06-01T10:00:00Z'),
    });

    const result = await lookupAgreements(
      { tenantId: 'tenant-1', customerId: 'cust-1', timezone: 'America/Los_Angeles' },
      { agreementRepo },
    );

    expect(result.status).toBe('found');
    if (result.status !== 'found') return;
    expect(result.summary).toContain('Gold Plan');
  });

  it('none — friendly summary when no active plans', async () => {
    const result = await lookupAgreements(
      { tenantId: 'tenant-1', customerId: 'cust-empty' },
      { agreementRepo },
    );
    expect(result.status).toBe('none');
  });

  it('tenant isolation — never leaks plans from another tenant', async () => {
    await seedAgreement(agreementRepo, {
      tenantId: 'tenant-2',
      customerId: 'cust-shared',
      name: 'Other-tenant Plan',
      nextRunAt: new Date('2026-06-01T10:00:00Z'),
    });

    const result = await lookupAgreements(
      { tenantId: 'tenant-1', customerId: 'cust-shared' },
      { agreementRepo },
    );

    expect(result.status).toBe('none');
  });

  it('only returns active — paused/cancelled excluded', async () => {
    await seedAgreement(agreementRepo, {
      tenantId: 'tenant-1',
      customerId: 'cust-1',
      name: 'Paused',
      nextRunAt: new Date('2026-06-01T10:00:00Z'),
      status: 'paused',
    });
    const result = await lookupAgreements(
      { tenantId: 'tenant-1', customerId: 'cust-1' },
      { agreementRepo },
    );
    expect(result.status).toBe('none');
  });
});
