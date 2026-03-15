import { evaluateVerticalQuality, evaluateTerminologyAccuracy, evaluateCategoryAlignment, calculateWeightedScore } from '../../../src/ai/evaluation/vertical-quality-metrics';
import { createEstimate } from '../../../src/estimates/estimate';
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

  it('happy path — evaluates quality with all dimensions', () => {
    const loaded = makeLoadedPack();
    const estimate = createEstimate({
      tenantId: 'tenant-1',
      categoryId: 'hvac-repair',
      lineItems: [
        { id: '1', description: 'Capacitor replacement', quantity: 1, unitPrice: 250, total: 250, category: 'parts' },
        { id: '2', description: 'Diagnostic fee', quantity: 1, unitPrice: 89, total: 89, category: 'labor' },
      ],
      snapshot: {},
      source: 'ai_generated',
      createdBy: 'user-1',
    });

    const metric = evaluateVerticalQuality(estimate, loaded);
    expect(metric.verticalSlug).toBe('hvac');
    expect(metric.score).toBeGreaterThanOrEqual(0);
    expect(metric.score).toBeLessThanOrEqual(1);
    expect(metric.details).toHaveProperty('dimensions');
  });

  it('happy path — evaluateTerminologyAccuracy scores based on term matches', () => {
    const loaded = makeLoadedPack();
    const estimate = createEstimate({
      tenantId: 't',
      lineItems: [{ id: '1', description: 'SEER rated Condenser unit', quantity: 1, unitPrice: 1000, total: 1000 }],
      snapshot: {},
      source: 'ai_generated',
      createdBy: 'u',
    });
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

  it('mock provider test — evaluateCategoryAlignment scores based on tags', () => {
    const loaded = makeLoadedPack();
    const estimate = createEstimate({
      tenantId: 't',
      lineItems: [{ id: '1', description: 'Repair electrical wiring', quantity: 1, unitPrice: 200, total: 200 }],
      snapshot: {},
      source: 'ai_generated',
      createdBy: 'u',
    });
    const score = evaluateCategoryAlignment(estimate, loaded.taxonomy, 'hvac-repair-electrical');
    expect(score).toBeGreaterThanOrEqual(0);
  });

  it('malformed AI output handled gracefully — empty line items score 0', () => {
    const loaded = makeLoadedPack();
    const estimate = createEstimate({ tenantId: 't', lineItems: [], snapshot: {}, source: 'ai_generated', createdBy: 'u' });
    const metric = evaluateVerticalQuality(estimate, loaded);
    expect(metric.score).toBe(0);
  });
});
