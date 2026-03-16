import { evaluateVerticalQuality, evaluateTerminologyAccuracy, evaluateCategoryAlignment, calculateWeightedScore } from '../../../src/ai/evaluation/vertical-quality-metrics';
import { Estimate, InMemoryEstimateRepository, createEstimate } from '../../../src/estimates/estimate';
import { buildLineItem } from '../../../src/shared/billing-engine';
import { createVerticalPack } from '../../../src/verticals/vertical-pack';
import { createTerminologyMap } from '../../../src/verticals/terminology-map';
import { createServiceTaxonomy } from '../../../src/verticals/service-taxonomy';
import { hvacTerminologyEntries } from '../../../src/verticals/data/hvac-terminology';
import { hvacCategories } from '../../../src/verticals/data/hvac-taxonomy';
import { LoadedVerticalPack } from '../../../src/verticals/vertical-loader';

describe('P4-011A — Vertical-aware estimate quality metric model', () => {
  function makeLoadedPack(): LoadedVerticalPack {
    const terminology = createTerminologyMap({ verticalSlug: 'hvac', version: '1.0.0', entries: hvacTerminologyEntries });
    const taxonomy = createServiceTaxonomy({ verticalSlug: 'hvac', version: '1.0.0', categories: hvacCategories });
    const pack = createVerticalPack({ slug: 'hvac', name: 'HVAC', version: '1', description: 'd', terminologyMapId: terminology.id, taxonomyId: taxonomy.id });
    return { pack, terminology, taxonomy };
  }

  it('happy path — evaluates quality with all dimensions', async () => {
    const loaded = makeLoadedPack();
    const repo = new InMemoryEstimateRepository();
    const estimate = await createEstimate({
      tenantId: 'tenant-1',
      jobId: 'j1',
      estimateNumber: 'E-001',
      lineItems: [
        buildLineItem('1', 'Capacitor replacement', 1, 25000, 1, true, 'material'),
        buildLineItem('2', 'Diagnostic fee', 1, 8900, 2, true, 'labor'),
      ],
      createdBy: 'user-1',
    }, repo);

    const metric = evaluateVerticalQuality(estimate, loaded);
    expect(metric.verticalType).toBe('hvac');
    expect(metric.score).toBeGreaterThanOrEqual(0);
    expect(metric.score).toBeLessThanOrEqual(1);
    expect(metric.details).toHaveProperty('dimensions');
  });

  it('happy path — evaluateTerminologyAccuracy scores based on term matches', async () => {
    const loaded = makeLoadedPack();
    const repo = new InMemoryEstimateRepository();
    const estimate = await createEstimate({
      tenantId: 't',
      jobId: 'j1',
      estimateNumber: 'E-001',
      lineItems: [buildLineItem('1', 'SEER rated Condenser unit', 1, 100000, 1, true)],
      createdBy: 'u',
    }, repo);
    const score = evaluateTerminologyAccuracy(estimate, loaded.terminology);
    expect(score).toBeGreaterThan(0);
  });

  it('validation — calculateWeightedScore handles equal weights', () => {
    const score = calculateWeightedScore([
      { dimension: 'a', score: 0.5, weight: 1 },
      { dimension: 'b', score: 1.0, weight: 1 },
    ]);
    expect(score).toBe(0.75);
  });

  it('mock provider test — evaluateCategoryAlignment scores based on tags', async () => {
    const loaded = makeLoadedPack();
    const repo = new InMemoryEstimateRepository();
    const estimate = await createEstimate({
      tenantId: 't',
      jobId: 'j1',
      estimateNumber: 'E-001',
      lineItems: [buildLineItem('1', 'Repair electrical wiring', 1, 20000, 1, true)],
      createdBy: 'u',
    }, repo);
    const score = evaluateCategoryAlignment(estimate, loaded.taxonomy, 'hvac-repair-electrical');
    expect(score).toBeGreaterThanOrEqual(0);
  });

  it('malformed AI output handled gracefully — empty line items score 0', async () => {
    const loaded = makeLoadedPack();
    const repo = new InMemoryEstimateRepository();
    const estimate = await createEstimate({
      tenantId: 't',
      jobId: 'j1',
      estimateNumber: 'E-001',
      lineItems: [buildLineItem('1', 'placeholder', 1, 100, 1, true)],
      createdBy: 'u',
    }, repo);
    // Override lineItems to empty for this test
    (estimate as any).lineItems = [];
    const metric = evaluateVerticalQuality(estimate, loaded);
    expect(metric.score).toBe(0);
  });
});
