/**
 * Feature 6 — Job → Invoice generation: time-entry recalculation (launch pass).
 *
 * Covers the pure labor-recalculation helper and its wiring into the
 * auto-invoice-on-completion flow: when the tenant opts in and time is tracked,
 * the auto-drafted invoice's labor line is billed from ACTUAL hours; otherwise
 * the accepted estimate is billed as-is.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { recalculateLaborFromTimeEntries } from '../../src/invoices/labor-from-time-entries';
import { maybeAutoInvoiceOnCompletion } from '../../src/invoices/auto-invoice-on-completion';
import { buildLineItem, LineItem } from '../../src/shared/billing-engine';
import { InMemoryInvoiceRepository } from '../../src/invoices/invoice';
import { InMemoryEstimateRepository, createEstimate } from '../../src/estimates/estimate';
import { InMemoryProposalRepository } from '../../src/proposals/proposal';
import { InMemorySettingsRepository, TenantSettings } from '../../src/settings/settings';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { InMemoryTimeEntryRepository, TimeEntry, EntryType } from '../../src/time-tracking/time-entry';
import { Job } from '../../src/jobs/job';

const TENANT = 'tenant-time-entries';

function entry(jobId: string, entryType: EntryType, durationMinutes: number | undefined): TimeEntry {
  return {
    id: uuidv4(), tenantId: TENANT, userId: 'tech-1', jobId, entryType,
    clockedInAt: new Date('2026-06-01T09:00:00Z'),
    clockedOutAt: durationMinutes != null ? new Date('2026-06-01T11:00:00Z') : undefined,
    durationMinutes, createdAt: new Date(), updatedAt: new Date(),
  };
}

describe('Feature 6 — labor recalculation from time entries (pure)', () => {
  const items: LineItem[] = [
    buildLineItem('labor-1', 'Diagnostic + repair labor', 2, 12000, 0, false, 'labor'),
    buildLineItem('mat-1', 'Capacitor', 1, 4500, 1, true, 'material'),
  ];

  it('replaces the single labor line quantity with actual job hours', () => {
    // 3h job + 30m drive (excluded) + 15m break (excluded) = 3.0 billable hours.
    const entries = [
      entry('j', 'job', 180), entry('j', 'drive', 30), entry('j', 'break', 15),
    ];
    const res = recalculateLaborFromTimeEntries(items, entries);

    expect(res.adjusted).toBe(true);
    expect(res.laborHoursBilled).toBe(3);
    const labor = res.lineItems.find((li) => li.id === 'labor-1')!;
    expect(labor.quantity).toBe(3);
    expect(labor.totalCents).toBe(3 * 12000);
    // Material is untouched.
    const material = res.lineItems.find((li) => li.id === 'mat-1')!;
    expect(material.quantity).toBe(1);
    expect(material.totalCents).toBe(4500);
  });

  it('optionally counts drive time when includeDriveTime is set', () => {
    const entries = [entry('j', 'job', 180), entry('j', 'drive', 30)];
    const res = recalculateLaborFromTimeEntries(items, entries, { includeDriveTime: true });
    expect(res.laborHoursBilled).toBe(3.5);
    expect(res.lineItems.find((li) => li.id === 'labor-1')!.quantity).toBe(3.5);
  });

  it('bills the estimate as-is when no time is tracked', () => {
    const res = recalculateLaborFromTimeEntries(items, []);
    expect(res.adjusted).toBe(false);
    expect(res.lineItems).toEqual(items);
  });

  it('ignores open entries with no duration', () => {
    const res = recalculateLaborFromTimeEntries(items, [entry('j', 'job', undefined)]);
    expect(res.adjusted).toBe(false);
  });

  it('leaves multiple labor lines unchanged (ambiguous split)', () => {
    const multi = [
      buildLineItem('labor-a', 'Labor A', 1, 10000, 0, false, 'labor'),
      buildLineItem('labor-b', 'Labor B', 1, 11000, 1, false, 'labor'),
    ];
    const res = recalculateLaborFromTimeEntries(multi, [entry('j', 'job', 240)]);
    expect(res.adjusted).toBe(false);
    expect(res.lineItems).toEqual(multi);
  });
});

function makeJob(): Job {
  return {
    id: uuidv4(), tenantId: TENANT, customerId: uuidv4(), locationId: uuidv4(),
    jobNumber: 'JOB-1', summary: 'AC repair', status: 'completed', priority: 'normal',
    depositRequiredCents: 0, depositPaidCents: 0, depositStatus: 'not_required',
    moneyState: 'estimate_accepted', createdBy: 'u1', createdAt: new Date(), updatedAt: new Date(),
  };
}

function makeSettings(billLaborFromTimeEntries: boolean): TenantSettings {
  return {
    id: `settings-${TENANT}`, tenantId: TENANT, businessName: 'Rivera HVAC', timezone: 'UTC',
    estimatePrefix: 'EST-', invoicePrefix: 'INV-', nextEstimateNumber: 1, nextInvoiceNumber: 1,
    defaultPaymentTermDays: 30, autoInvoiceOnCompletion: true, billLaborFromTimeEntries,
    createdAt: new Date(), updatedAt: new Date(),
  };
}

describe('Feature 6 — Job → Invoice generation: auto-invoice uses actual hours', () => {
  let estimateRepo: InMemoryEstimateRepository;
  let invoiceRepo: InMemoryInvoiceRepository;
  let proposalRepo: InMemoryProposalRepository;
  let settingsRepo: InMemorySettingsRepository;
  let auditRepo: InMemoryAuditRepository;
  let timeEntryRepo: InMemoryTimeEntryRepository;

  beforeEach(() => {
    estimateRepo = new InMemoryEstimateRepository();
    invoiceRepo = new InMemoryInvoiceRepository();
    proposalRepo = new InMemoryProposalRepository();
    settingsRepo = new InMemorySettingsRepository();
    auditRepo = new InMemoryAuditRepository();
    timeEntryRepo = new InMemoryTimeEntryRepository();
  });

  function deps() {
    return { estimateRepo, invoiceRepo, proposalRepo, settingsRepo, auditRepo, timeEntryRepo };
  }

  async function seedAcceptedEstimate(jobId: string) {
    const est = await createEstimate(
      {
        tenantId: TENANT, jobId, estimateNumber: 'EST-1', createdBy: 'u1',
        lineItems: [
          buildLineItem('labor-1', 'Labor (est. 2h)', 2, 12000, 0, false, 'labor'),
          buildLineItem('mat-1', 'Capacitor', 1, 4500, 1, true, 'material'),
        ],
      },
      estimateRepo,
    );
    return (await estimateRepo.update(TENANT, est.id, { status: 'accepted' }))!;
  }

  it('recomputes the drafted labor line from logged hours when opted in', async () => {
    await settingsRepo.create(makeSettings(true));
    const job = makeJob();
    await seedAcceptedEstimate(job.id);
    // Tech logged 3h of job time (vs 2h estimated).
    await timeEntryRepo.create(entry(job.id, 'job', 180));

    const proposal = await maybeAutoInvoiceOnCompletion(deps(), job);

    expect(proposal).not.toBeNull();
    const payload = proposal!.payload as { lineItems: { id: string; quantity: number; unitPriceCents: number }[] };
    const labor = payload.lineItems.find((li) => li.id === 'labor-1')!;
    expect(labor.quantity).toBe(3);
    expect(labor.unitPriceCents).toBe(12000);
    expect(auditRepo.getAll().some((e) => e.metadata?.laborHoursBilled === 3)).toBe(true);
  });

  it('bills estimated hours when opted in but no time was logged', async () => {
    await settingsRepo.create(makeSettings(true));
    const job = makeJob();
    await seedAcceptedEstimate(job.id);

    const proposal = await maybeAutoInvoiceOnCompletion(deps(), job);
    const payload = proposal!.payload as { lineItems: { id: string; quantity: number }[] };
    expect(payload.lineItems.find((li) => li.id === 'labor-1')!.quantity).toBe(2);
  });

  it('bills estimated hours when the tenant has not opted in', async () => {
    await settingsRepo.create(makeSettings(false));
    const job = makeJob();
    await seedAcceptedEstimate(job.id);
    await timeEntryRepo.create(entry(job.id, 'job', 180));

    const proposal = await maybeAutoInvoiceOnCompletion(deps(), job);
    const payload = proposal!.payload as { lineItems: { id: string; quantity: number }[] };
    expect(payload.lineItems.find((li) => li.id === 'labor-1')!.quantity).toBe(2);
  });
});
