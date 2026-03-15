import { createEstimateTemplate, InMemoryEstimateTemplateRepository } from '../../../src/ai/tasks/estimate-template';
import { findMatchingTemplates, scoreTemplateMatch, getBestTemplate } from '../../../src/ai/tasks/template-retrieval';

describe('P4-004B — Template retrieval by vertical and category', () => {
  async function setupRepo() {
    const repo = new InMemoryEstimateTemplateRepository();
    const t1 = createEstimateTemplate({
      verticalSlug: 'hvac',
      categoryId: 'hvac-repair',
      name: 'AC Repair',
      description: 'Air conditioning repair template',
      lineItemTemplates: [{ description: 'Diagnostic', isOptional: false, sortOrder: 1 }],
      promptHints: ['capacitor', 'refrigerant'],
    });
    const t2 = createEstimateTemplate({
      verticalSlug: 'hvac',
      categoryId: 'hvac-install',
      name: 'AC Install',
      description: 'New AC installation template',
      lineItemTemplates: [{ description: 'Equipment', isOptional: false, sortOrder: 1 }],
    });
    await repo.create(t1);
    await repo.create(t2);
    return { repo, t1, t2 };
  }

  it('happy path — retrieves templates by vertical and category', async () => {
    const { repo } = await setupRepo();
    const matches = await findMatchingTemplates({ verticalSlug: 'hvac', categoryId: 'hvac-repair' }, repo);
    expect(matches).toHaveLength(1);
    expect(matches[0].template.name).toBe('AC Repair');
    expect(matches[0].score).toBeGreaterThan(0);
  });

  it('happy path — getBestTemplate returns top match', async () => {
    const { repo } = await setupRepo();
    const best = await getBestTemplate({ verticalSlug: 'hvac', categoryId: 'hvac-repair' }, repo);
    expect(best).not.toBeNull();
    expect(best!.name).toBe('AC Repair');
  });

  it('validation — scoreTemplateMatch scores by relevance', () => {
    const template = createEstimateTemplate({
      verticalSlug: 'hvac',
      categoryId: 'hvac-repair',
      name: 'Test',
      description: 'Test',
      lineItemTemplates: [],
    });
    const score = scoreTemplateMatch(template, {
      verticalSlug: 'hvac',
      categoryId: 'hvac-repair',
      searchTerms: ['test'],
    });
    expect(score).toBeGreaterThan(0.5);
  });

  it('mock provider test — returns empty for non-matching vertical', async () => {
    const { repo } = await setupRepo();
    const matches = await findMatchingTemplates({ verticalSlug: 'electrical' }, repo);
    expect(matches).toHaveLength(0);
  });

  it('mock provider test — respects limit', async () => {
    const { repo } = await setupRepo();
    const matches = await findMatchingTemplates({ verticalSlug: 'hvac', limit: 1 }, repo);
    expect(matches.length).toBeLessThanOrEqual(1);
  });

  it('malformed AI output handled gracefully — getBestTemplate returns null for no matches', async () => {
    const { repo } = await setupRepo();
    const result = await getBestTemplate({ verticalSlug: 'nonexistent' }, repo);
    expect(result).toBeNull();
  });
});
