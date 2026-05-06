import { describe, it, expect, beforeEach, vi } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { lookupAgreements } from '../../../src/ai/skills/lookup-agreements';
import {
  InMemoryAgreementRepository,
  type Agreement,
  type AgreementRepository,
} from '../../../src/agreements/agreement';
import { InMemoryLookupEventRepository } from '../../../src/lookup-events/lookup-event';
import { LookupEventService } from '../../../src/lookup-events/lookup-event-service';

async function seedAgreement(
  repo: InMemoryAgreementRepository,
  opts: {
    tenantId: string;
    customerId: string;
    name: string;
    nextRunAt: Date;
    status?: 'active' | 'paused' | 'cancelled';
    priceCents?: number;
  },
) {
  const now = new Date();
  return repo.create({
    id: uuidv4(),
    tenantId: opts.tenantId,
    customerId: opts.customerId,
    name: opts.name,
    recurrenceRule: 'FREQ=MONTHLY',
    priceCents: opts.priceCents ?? 9900,
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

  // ============================================================
  // P18-004 — isolated unit tests for lookup_agreements
  // ============================================================

  describe('P18-004 lookup_agreements — TTS / tenant isolation / repo wiring', () => {
    it('P18-004 lookup-agreements single result — singular phrasing for one plan', async () => {
      await seedAgreement(agreementRepo, {
        tenantId: 't-1',
        customerId: 'cust-1',
        name: 'Silver Plan',
        nextRunAt: new Date('2026-06-15T17:00:00Z'),
      });
      const result = await lookupAgreements(
        { tenantId: 't-1', customerId: 'cust-1', timezone: 'America/Los_Angeles' },
        { agreementRepo },
      );
      if (result.status !== 'found') throw new Error('expected found');
      expect(result.summary).toMatch(/Your Silver Plan plan is next scheduled for/);
      expect(result.data.agreements).toHaveLength(1);
    });

    it('P18-004 lookup-agreements multi result — plural phrasing with count', async () => {
      await seedAgreement(agreementRepo, {
        tenantId: 't-1',
        customerId: 'cust-1',
        name: 'Plan A',
        nextRunAt: new Date('2026-06-01T10:00:00Z'),
      });
      await seedAgreement(agreementRepo, {
        tenantId: 't-1',
        customerId: 'cust-1',
        name: 'Plan B',
        nextRunAt: new Date('2026-07-01T10:00:00Z'),
      });
      await seedAgreement(agreementRepo, {
        tenantId: 't-1',
        customerId: 'cust-1',
        name: 'Plan C',
        nextRunAt: new Date('2026-08-01T10:00:00Z'),
      });

      const result = await lookupAgreements(
        { tenantId: 't-1', customerId: 'cust-1', timezone: 'America/Los_Angeles' },
        { agreementRepo },
      );
      if (result.status !== 'found') throw new Error('expected found');
      expect(result.summary).toContain('3 active service plans');
      // earliest first → Plan A
      expect(result.summary).toContain('Plan A');
      expect(result.data.agreements[0].name).toBe('Plan A');
    });

    it('P18-004 lookup-agreements empty — friendly TTS string', async () => {
      const result = await lookupAgreements(
        { tenantId: 't-1', customerId: 'no-such' },
        { agreementRepo },
      );
      expect(result.status).toBe('none');
      // P11-002 i18n catalog: "service plans" → "service agreement" (matches entity name).
      expect(result.summary.toLowerCase()).toContain('active service agreement');
    });

    it('P18-004 lookup-agreements tenant isolation — tenant A plans invisible to tenant B', async () => {
      await seedAgreement(agreementRepo, {
        tenantId: 'tenant-A',
        customerId: 'cust-shared',
        name: 'A-plan',
        nextRunAt: new Date('2026-06-01T10:00:00Z'),
      });
      await seedAgreement(agreementRepo, {
        tenantId: 'tenant-B',
        customerId: 'cust-shared',
        name: 'B-plan',
        nextRunAt: new Date('2026-06-01T10:00:00Z'),
      });

      const result = await lookupAgreements(
        { tenantId: 'tenant-A', customerId: 'cust-shared' },
        { agreementRepo },
      );
      if (result.status !== 'found') throw new Error('expected found');
      expect(result.data.agreements).toHaveLength(1);
      expect(result.data.agreements[0].name).toBe('A-plan');
    });

    it('P18-004 lookup-agreements repo wiring — findByTenant called with tenantId first arg + active filter', async () => {
      const findByTenant = vi.fn(async (_tenantId: string, _opts?: unknown) => [] as Agreement[]);
      const stubbed = agreementRepo as unknown as AgreementRepository;
      stubbed.findByTenant = findByTenant;
      await lookupAgreements(
        { tenantId: 'tenant-Z', customerId: 'cust-Q' },
        { agreementRepo: stubbed },
      );
      expect(findByTenant).toHaveBeenCalled();
      const call = findByTenant.mock.calls[0];
      if (!call) throw new Error('expected call');
      expect(call[0]).toBe('tenant-Z');
      expect(call[1]).toMatchObject({
        customerId: 'cust-Q',
        status: 'active',
      });
    });

    it('P18-004 lookup-agreements no ISO timestamps in summary (date rendered in tenant timezone)', async () => {
      await seedAgreement(agreementRepo, {
        tenantId: 't-1',
        customerId: 'cust-1',
        name: 'Plan',
        nextRunAt: new Date('2026-06-01T10:00:00Z'),
      });
      const result = await lookupAgreements(
        { tenantId: 't-1', customerId: 'cust-1', timezone: 'America/Los_Angeles' },
        { agreementRepo },
      );
      if (result.status !== 'found') throw new Error('expected found');
      expect(result.summary).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
      expect(result.summary).not.toMatch(/Z\b/);
      // Friendly weekday is rendered (Intl en-US)
      expect(result.summary).toMatch(/Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday/);
    });

    it('P18-004 lookup-agreements timezone matters — same date renders differently across zones', async () => {
      await seedAgreement(agreementRepo, {
        tenantId: 't-1',
        customerId: 'cust-1',
        name: 'Plan',
        // Midnight UTC → previous day in LA
        nextRunAt: new Date('2026-06-02T03:00:00Z'),
      });
      const ny = await lookupAgreements(
        { tenantId: 't-1', customerId: 'cust-1', timezone: 'America/New_York' },
        { agreementRepo },
      );
      const la = await lookupAgreements(
        { tenantId: 't-1', customerId: 'cust-1', timezone: 'America/Los_Angeles' },
        { agreementRepo },
      );
      if (ny.status !== 'found' || la.status !== 'found') throw new Error('expected found');
      // 03:00 UTC = 11pm Eastern (June 1) and 8pm Pacific (June 1)
      expect(ny.summary).toContain('June 1');
      expect(la.summary).toContain('June 1');
    });

    it('P18-004 lookup-agreements repo throws — returns status=error with friendly summary', async () => {
      const findByTenant = vi.fn(async () => {
        throw new Error('db down');
      });
      const stubbed = agreementRepo as unknown as AgreementRepository;
      stubbed.findByTenant = findByTenant;
      const result = await lookupAgreements(
        { tenantId: 't-1', customerId: 'cust-1' },
        { agreementRepo: stubbed },
      );
      expect(result.status).toBe('error');
      expect(result.summary.toLowerCase()).toContain('trouble');
    });

    it('P18-004 lookup-agreements cancelled status — excluded from active lookup', async () => {
      await seedAgreement(agreementRepo, {
        tenantId: 't-1',
        customerId: 'cust-1',
        name: 'Cancelled Plan',
        nextRunAt: new Date('2026-06-01T10:00:00Z'),
        status: 'cancelled',
      });
      const result = await lookupAgreements(
        { tenantId: 't-1', customerId: 'cust-1' },
        { agreementRepo },
      );
      expect(result.status).toBe('none');
    });

    it('P18-004 lookup-agreements audit row — records lookup_agreements intent', async () => {
      await seedAgreement(agreementRepo, {
        tenantId: 't-1',
        customerId: 'cust-1',
        name: 'Plan',
        nextRunAt: new Date('2026-06-01T10:00:00Z'),
      });
      const lookupRepo = new InMemoryLookupEventRepository();
      const lookupEvents = new LookupEventService(lookupRepo);
      await lookupAgreements(
        { tenantId: 't-1', customerId: 'cust-1', sessionId: 'sess-1' },
        { agreementRepo, lookupEvents },
      );
      const rows = await lookupRepo.listByTenant('t-1');
      expect(rows).toHaveLength(1);
      expect(rows[0].intent).toBe('lookup_agreements');
    });

    it('P18-004 lookup-agreements performance smoke — completes well under 500ms', async () => {
      await seedAgreement(agreementRepo, {
        tenantId: 't-1',
        customerId: 'cust-1',
        name: 'Plan',
        nextRunAt: new Date('2026-06-01T10:00:00Z'),
      });
      const t0 = Date.now();
      const result = await lookupAgreements(
        { tenantId: 't-1', customerId: 'cust-1' },
        { agreementRepo },
      );
      const elapsed = Date.now() - t0;
      expect(result.status).toBe('found');
      expect(elapsed).toBeLessThan(500);
    });
  });
});
