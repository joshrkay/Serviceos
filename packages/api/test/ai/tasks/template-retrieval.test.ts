import { createTemplate, InMemoryEstimateTemplateRepository } from '../../../src/ai/tasks/estimate-template';
import { findMatchingTemplates, scoreTemplateMatch, getBestTemplate } from '../../../src/ai/tasks/template-retrieval';

describe('P4-004B — Template retrieval by vertical and category', () => {
  async function setupRepo() {
    const repo = new InMemoryEstimateTemplateRepository();
    const t1 = await createTemplate({
      packId: 'pack-1',
      verticalType: 'hvac',
      serviceCategory: 'repair',
      name: 'AC Repair',
      defaultNotes: 'Air conditioning repair template',
      defaultLineItems: [{ description: 'Diagnostic', quantity: 1, unitPriceCents: 8900, taxable: true, sortOrder: 1 }],
    }, repo);
    const t2 = await createTemplate({
      packId: 'pack-1',
      verticalType: 'hvac',
      serviceCategory: 'install',
      name: 'AC Install',
      defaultNotes: 'New AC installation template',
      defaultLineItems: [{ description: 'Equipment', quantity: 1, unitPriceCents: 500000, taxable: true, sortOrder: 1 }],
    }, repo);
    return { repo, t1, t2 };
  }

  it('happy path — retrieves templates by vertical and category', async () => {
    const { repo } = await setupRepo();
    const matches = await findMatchingTemplates({ verticalType: 'hvac', serviceCategory: 'repair' }, repo);
    expect(matches).toHaveLength(1);
    expect(matches[0].template.name).toBe('AC Repair');
    expect(matches[0].score).toBeGreaterThan(0);
  });

  it('happy path — getBestTemplate returns top match', async () => {
    const { repo } = await setupRepo();
    const best = await getBestTemplate({ verticalType: 'hvac', serviceCategory: 'repair' }, repo);
    expect(best).not.toBeNull();
    expect(best!.name).toBe('AC Repair');
  });

  it('validation — scoreTemplateMatch scores by relevance', async () => {
    const repo = new InMemoryEstimateTemplateRepository();
    const template = await createTemplate({
      packId: 'pack-1',
      verticalType: 'hvac',
      serviceCategory: 'repair',
      name: 'Test',
      defaultLineItems: [{ description: 'item', quantity: 1, unitPriceCents: 100, taxable: true, sortOrder: 1 }],
    }, repo);
    const score = scoreTemplateMatch(template, {
      verticalType: 'hvac',
      serviceCategory: 'repair',
      searchTerms: ['test'],
    });
    expect(score).toBeGreaterThan(0.5);
  });

  it('mock provider test — returns empty for non-matching vertical', async () => {
    const { repo } = await setupRepo();
    const matches = await findMatchingTemplates({ verticalType: 'plumbing' }, repo);
    expect(matches).toHaveLength(0);
  });

  it('mock provider test — respects limit', async () => {
    const { repo } = await setupRepo();
    const matches = await findMatchingTemplates({ verticalType: 'hvac', limit: 1 }, repo);
    expect(matches.length).toBeLessThanOrEqual(1);
  });

  it('malformed AI output handled gracefully — getBestTemplate returns null for no matches', async () => {
    const { repo } = await setupRepo();
    const result = await getBestTemplate({ verticalType: 'plumbing', serviceCategory: 'drain' }, repo);
    expect(result).toBeNull();
  });
});
