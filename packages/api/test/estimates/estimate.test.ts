import {
  createEstimate,
  getEstimate,
  updateEstimate,
  transitionEstimateStatus,
  validateEstimateInput,
  isEstimateCatalogGrounded,
  InMemoryEstimateRepository,
} from '../../src/estimates/estimate';
import { buildLineItem, LineItem, PricingSource } from '../../src/shared/billing-engine';
import { InMemoryAuditRepository } from '../../src/audit/audit';

describe('P1-009 — Estimate entity + shared line-item schema', () => {
  let repo: InMemoryEstimateRepository;
  let auditRepo: InMemoryAuditRepository;

  const sampleItems = [
    buildLineItem('item-1', 'AC Repair Labor', 2, 7500, 1, true, 'labor'),
    buildLineItem('item-2', 'Compressor Part', 1, 15000, 2, true, 'material'),
  ];

  beforeEach(() => {
    repo = new InMemoryEstimateRepository();
    auditRepo = new InMemoryAuditRepository();
  });

  it('happy path — creates estimate with calculated totals', async () => {
    const estimate = await createEstimate(
      {
        tenantId: 'tenant-1',
        jobId: 'job-1',
        estimateNumber: 'EST-0001',
        lineItems: sampleItems,
        taxRateBps: 825,
        createdBy: 'user-1',
      },
      repo,
      auditRepo
    );

    expect(estimate.id).toBeTruthy();
    expect(estimate.status).toBe('draft');
    expect(estimate.totals.subtotalCents).toBe(30000); // 15000 + 15000
    expect(estimate.totals.taxCents).toBe(2475); // 30000 * 825 / 10000
    expect(estimate.totals.totalCents).toBe(32475);
  });

  it('happy path — retrieves estimate', async () => {
    const estimate = await createEstimate(
      { tenantId: 'tenant-1', jobId: 'job-1', estimateNumber: 'EST-0001', lineItems: sampleItems, createdBy: 'u-1' },
      repo
    );

    const found = await getEstimate('tenant-1', estimate.id, repo);
    expect(found).not.toBeNull();
    expect(found!.lineItems).toHaveLength(2);
  });

  it('happy path — updates estimate recalculates totals', async () => {
    const estimate = await createEstimate(
      { tenantId: 'tenant-1', jobId: 'job-1', estimateNumber: 'EST-0001', lineItems: sampleItems, taxRateBps: 825, createdBy: 'u-1' },
      repo
    );

    const updated = await updateEstimate(
      'tenant-1',
      estimate.id,
      { discountCents: 5000 },
      repo
    );

    expect(updated!.totals.discountCents).toBe(5000);
    expect(updated!.totals.totalCents).toBeLessThan(estimate.totals.totalCents);
  });

  it('validation — rejects missing required fields', () => {
    const errors = validateEstimateInput({
      tenantId: '',
      jobId: '',
      estimateNumber: '',
      lineItems: [],
      createdBy: '',
    });
    expect(errors).toContain('tenantId is required');
    expect(errors).toContain('jobId is required');
    expect(errors).toContain('estimateNumber is required');
    expect(errors).toContain('createdBy is required');
    expect(errors).toContain('At least one line item is required');
  });

  it('tenant isolation — cross-tenant data inaccessible', async () => {
    const estimate = await createEstimate(
      { tenantId: 'tenant-1', jobId: 'job-1', estimateNumber: 'EST-0001', lineItems: sampleItems, createdBy: 'u-1' },
      repo
    );

    const found = await getEstimate('tenant-2', estimate.id, repo);
    expect(found).toBeNull();
  });

  it('status transition — valid transition draft to sent', async () => {
    const estimate = await createEstimate(
      { tenantId: 'tenant-1', jobId: 'job-1', estimateNumber: 'EST-0001', lineItems: sampleItems, createdBy: 'u-1' },
      repo
    );

    const result = await transitionEstimateStatus('tenant-1', estimate.id, 'sent', repo);
    expect(result!.status).toBe('sent');
  });

  it('status transition — rejects invalid transition draft to accepted', async () => {
    const estimate = await createEstimate(
      { tenantId: 'tenant-1', jobId: 'job-1', estimateNumber: 'EST-0001', lineItems: sampleItems, createdBy: 'u-1' },
      repo
    );

    await expect(
      transitionEstimateStatus('tenant-1', estimate.id, 'accepted', repo)
    ).rejects.toThrow('Invalid transition from draft to accepted');
  });

  it('edit guard — plain update on a sent estimate routes to the revise flow', async () => {
    const estimate = await createEstimate(
      { tenantId: 'tenant-1', jobId: 'job-1', estimateNumber: 'EST-0001', lineItems: sampleItems, createdBy: 'u-1' },
      repo
    );
    await transitionEstimateStatus('tenant-1', estimate.id, 'sent', repo);

    await expect(
      updateEstimate('tenant-1', estimate.id, { discountCents: 1000 }, repo)
    ).rejects.toThrow(/revise/i);
  });

  it('zero amount edge case — zero-value line items', async () => {
    const zeroItems = [buildLineItem('z-1', 'Free consultation', 1, 0, 1, true)];
    const estimate = await createEstimate(
      { tenantId: 'tenant-1', jobId: 'job-1', estimateNumber: 'EST-0001', lineItems: zeroItems, createdBy: 'u-1' },
      repo
    );

    expect(estimate.totals.subtotalCents).toBe(0);
    expect(estimate.totals.totalCents).toBe(0);
  });

  it('rounding boundary — fractional quantity', async () => {
    const items = [buildLineItem('r-1', 'Hourly labor', 1.5, 7500, 1, true, 'labor')];
    const estimate = await createEstimate(
      { tenantId: 'tenant-1', jobId: 'job-1', estimateNumber: 'EST-0001', lineItems: items, taxRateBps: 825, createdBy: 'u-1' },
      repo
    );

    expect(estimate.totals.subtotalCents).toBe(11250);
    expect(Number.isInteger(estimate.totals.taxCents)).toBe(true);
  });
});

describe('P2-036 V2 (U-G) — isEstimateCatalogGrounded', () => {
  // Build a priced line ($75) carrying a given pricingSource (or none).
  function pricedLine(id: string, source?: PricingSource): LineItem {
    const li = buildLineItem(id, 'Service line', 1, 7500, 1, true, 'labor');
    return source === undefined ? li : { ...li, pricingSource: source };
  }

  it('all lines catalog-sourced → grounded (true)', () => {
    const lineItems = [pricedLine('a', 'catalog'), pricedLine('b', 'catalog')];
    expect(isEstimateCatalogGrounded({ lineItems })).toBe(true);
  });

  it('all lines manual-sourced → grounded (true)', () => {
    const lineItems = [pricedLine('a', 'manual'), pricedLine('b', 'manual')];
    expect(isEstimateCatalogGrounded({ lineItems })).toBe(true);
  });

  it('mixed catalog + manual → grounded (true)', () => {
    const lineItems = [pricedLine('a', 'catalog'), pricedLine('b', 'manual')];
    expect(isEstimateCatalogGrounded({ lineItems })).toBe(true);
  });

  it('any uncatalogued priced line → NOT grounded (false)', () => {
    const lineItems = [pricedLine('a', 'catalog'), pricedLine('b', 'uncatalogued')];
    expect(isEstimateCatalogGrounded({ lineItems })).toBe(false);
  });

  it('any ambiguous priced line → NOT grounded (false)', () => {
    const lineItems = [pricedLine('a', 'catalog'), pricedLine('b', 'ambiguous')];
    expect(isEstimateCatalogGrounded({ lineItems })).toBe(false);
  });

  it('any priced line with undefined pricingSource (legacy/manual-without-signal) → NOT grounded (false)', () => {
    const lineItems = [pricedLine('a', 'catalog'), pricedLine('b', undefined)];
    expect(isEstimateCatalogGrounded({ lineItems })).toBe(false);
  });

  it('any priced line with null pricingSource (DB NULL round-trip) → NOT grounded (false)', () => {
    // A row persisted with pricing_source = NULL maps back to null/undefined;
    // pin null explicitly since the column is nullable.
    const nullLine = { ...pricedLine('b'), pricingSource: null as unknown as PricingSource };
    const lineItems = [pricedLine('a', 'catalog'), nullLine];
    expect(isEstimateCatalogGrounded({ lineItems })).toBe(false);
  });

  it('empty estimate (no priced lines) → NOT grounded (false) — nothing to vouch for', () => {
    expect(isEstimateCatalogGrounded({ lineItems: [] })).toBe(false);
  });

  it('zero-priced lines are skipped — a $0 line without a signal does NOT break grounding', () => {
    const zeroLine = buildLineItem('free', 'Free consultation', 1, 0, 2, true, 'labor');
    const lineItems = [pricedLine('a', 'catalog'), zeroLine];
    expect(isEstimateCatalogGrounded({ lineItems })).toBe(true);
  });

  it('only zero-priced lines → NOT grounded (false) — no priced line to ground', () => {
    const zeroLine = buildLineItem('free', 'Free consultation', 1, 0, 1, true, 'labor');
    expect(isEstimateCatalogGrounded({ lineItems: [zeroLine] })).toBe(false);
  });
});
