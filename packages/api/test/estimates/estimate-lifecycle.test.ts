import {
  createEstimate,
  getEstimate,
  softDeleteEstimate,
  cloneEstimate,
  transitionEstimateStatus,
  listEstimates,
  InMemoryEstimateRepository,
} from '../../src/estimates/estimate';
import {
  buildLineItem,
  resolveSelectedLineItems,
  validateLineItemSelection,
  hasSelectableLineItems,
  LineItem,
} from '../../src/shared/billing-engine';
import { InMemoryAuditRepository } from '../../src/audit/audit';

const TENANT = 'tenant-1';

function items(): LineItem[] {
  return [
    buildLineItem('item-1', 'AC Repair Labor', 2, 7500, 1, true, 'labor'),
    buildLineItem('item-2', 'Compressor Part', 1, 15000, 2, true, 'material'),
  ];
}

describe('Estimate lifecycle — soft delete', () => {
  let repo: InMemoryEstimateRepository;
  let auditRepo: InMemoryAuditRepository;

  beforeEach(() => {
    repo = new InMemoryEstimateRepository();
    auditRepo = new InMemoryAuditRepository();
  });

  it('hides a soft-deleted estimate from all reads and emits audit', async () => {
    const est = await createEstimate(
      { tenantId: TENANT, jobId: 'job-1', estimateNumber: 'EST-1', lineItems: items(), createdBy: 'u-1' },
      repo,
    );

    const result = await softDeleteEstimate(TENANT, est.id, repo, {
      auditRepo,
      actorId: 'u-1',
      actorRole: 'owner',
    });
    expect(result).not.toBeNull();
    expect(result!.deletedAt).toBeInstanceOf(Date);

    expect(await getEstimate(TENANT, est.id, repo)).toBeNull();
    expect(await listEstimates(TENANT, repo)).toHaveLength(0);
    expect(await repo.findByJob(TENANT, 'job-1')).toHaveLength(0);

    const events = auditRepo.getAll();
    expect(events.some((e) => e.eventType === 'estimate.deleted')).toBe(true);
  });

  it('refuses to delete an accepted estimate', async () => {
    const est = await createEstimate(
      { tenantId: TENANT, jobId: 'job-1', estimateNumber: 'EST-1', lineItems: items(), createdBy: 'u-1' },
      repo,
    );
    await repo.update(TENANT, est.id, { status: 'accepted' });

    await expect(softDeleteEstimate(TENANT, est.id, repo)).rejects.toThrow(/accepted/i);
    // Still readable — the delete was rejected.
    expect(await getEstimate(TENANT, est.id, repo)).not.toBeNull();
  });
});

describe('Estimate lifecycle — clone', () => {
  let repo: InMemoryEstimateRepository;
  let auditRepo: InMemoryAuditRepository;

  beforeEach(() => {
    repo = new InMemoryEstimateRepository();
    auditRepo = new InMemoryAuditRepository();
  });

  it('clones into a fresh draft, resetting lifecycle state and copying tier metadata', async () => {
    const tiered: LineItem[] = [
      { ...buildLineItem('base', 'Diagnostic', 1, 5000, 0, true, 'labor') },
      { ...buildLineItem('good', 'Good tier', 1, 10000, 1, true, 'labor'), groupKey: 'tier', groupLabel: 'Plan', isOptional: true, isDefaultSelected: true },
      { ...buildLineItem('better', 'Better tier', 1, 20000, 2, true, 'labor'), groupKey: 'tier', groupLabel: 'Plan', isOptional: true },
    ];
    const est = await createEstimate(
      { tenantId: TENANT, jobId: 'job-1', estimateNumber: 'EST-1', lineItems: tiered, createdBy: 'u-1' },
      repo,
    );
    // Move it out of draft so we prove the clone resets state.
    await repo.update(TENANT, est.id, { status: 'sent', viewToken: 'tok', sentAt: new Date(), version: 4 });

    const clone = await cloneEstimate(TENANT, est.id, 'EST-2', 'u-2', repo, auditRepo);
    expect(clone).not.toBeNull();
    expect(clone!.id).not.toBe(est.id);
    expect(clone!.estimateNumber).toBe('EST-2');
    expect(clone!.status).toBe('draft');
    expect(clone!.version).toBe(1);
    expect(clone!.viewToken).toBeUndefined();
    expect(clone!.sentAt).toBeUndefined();
    // Tier metadata preserved.
    const better = clone!.lineItems.find((li) => li.description === 'Better tier');
    expect(better?.groupKey).toBe('tier');
    expect(better?.isOptional).toBe(true);
    // New line-item ids (not shared with the original).
    expect(clone!.lineItems.map((li) => li.id)).not.toContain('good');

    const events = auditRepo.getAll();
    expect(events.some((e) => e.eventType === 'estimate.cloned')).toBe(true);
  });
});

describe('Billing engine — good-better-best selection', () => {
  const lineItems: LineItem[] = [
    { ...buildLineItem('base', 'Diagnostic', 1, 5000, 0, true), },
    { ...buildLineItem('good', 'Good', 1, 10000, 1, true), groupKey: 'tier', groupLabel: 'Plan', isOptional: true, isDefaultSelected: true },
    { ...buildLineItem('better', 'Better', 1, 20000, 2, true), groupKey: 'tier', groupLabel: 'Plan', isOptional: true },
    { ...buildLineItem('addon', 'Surge protector', 1, 3000, 3, true), isOptional: true },
  ];

  it('hasSelectableLineItems detects tiers/add-ons', () => {
    expect(hasSelectableLineItems(lineItems)).toBe(true);
    expect(hasSelectableLineItems([buildLineItem('x', 'flat', 1, 100, 0, true)])).toBe(false);
  });

  it('resolves defaults when no selection given (base + default tier, no add-on)', () => {
    const resolved = resolveSelectedLineItems(lineItems);
    expect(resolved.map((li) => li.id).sort()).toEqual(['base', 'good']);
  });

  it('resolves an explicit selection (base always included)', () => {
    const resolved = resolveSelectedLineItems(lineItems, ['better', 'addon']);
    expect(resolved.map((li) => li.id).sort()).toEqual(['addon', 'base', 'better']);
  });

  it('defaults a tier group with no flagged default to its first option', () => {
    const noDefault: LineItem[] = [
      { ...buildLineItem('base', 'Diagnostic', 1, 5000, 0, true) },
      { ...buildLineItem('g1', 'Tier A', 1, 10000, 1, true), groupKey: 'tier', groupLabel: 'Plan', isOptional: true },
      { ...buildLineItem('g2', 'Tier B', 1, 20000, 2, true), groupKey: 'tier', groupLabel: 'Plan', isOptional: true },
    ];
    // No isDefaultSelected anywhere — the group must still contribute one
    // option (the first by sortOrder) so the total isn't understated.
    const resolved = resolveSelectedLineItems(noDefault);
    expect(resolved.map((li) => li.id).sort()).toEqual(['base', 'g1']);
  });

  it('rejects a selection with zero or multiple tier options', () => {
    expect(validateLineItemSelection(lineItems, ['addon'])).toContain('Select exactly one option for "Plan"');
    expect(validateLineItemSelection(lineItems, ['good', 'better'])).toContain('Select exactly one option for "Plan"');
    expect(validateLineItemSelection(lineItems, ['good'])).toEqual([]);
  });

  it('flags unknown selected ids', () => {
    expect(validateLineItemSelection(lineItems, ['good', 'nope'])).toContain('Unknown line item selected: nope');
  });
});

describe('Estimate status transitions — expired', () => {
  it('allows sent -> expired', async () => {
    const repo = new InMemoryEstimateRepository();
    const est = await createEstimate(
      { tenantId: TENANT, jobId: 'job-1', estimateNumber: 'EST-1', lineItems: items(), createdBy: 'u-1' },
      repo,
    );
    await repo.update(TENANT, est.id, { status: 'sent' });
    const expired = await transitionEstimateStatus(TENANT, est.id, 'expired', repo);
    expect(expired!.status).toBe('expired');
  });
});
