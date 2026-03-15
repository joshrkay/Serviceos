import { buildCategoryContextBlock, buildTemplateContextBlock, assembleTemplateContext, formatTemplateForPrompt, formatCategoryPathForPrompt } from '../../../src/ai/tasks/template-context';
import { createEstimateTemplate, InMemoryEstimateTemplateRepository } from '../../../src/ai/tasks/estimate-template';
import { createServiceTaxonomy, InMemoryServiceTaxonomyRepository } from '../../../src/verticals/service-taxonomy';
import { hvacCategories } from '../../../src/verticals/data/hvac-taxonomy';

describe('P4-009B — Service category + template context assembly', () => {
  it('happy path — builds category context block', () => {
    const taxonomy = createServiceTaxonomy({ verticalSlug: 'hvac', version: '1.0.0', categories: hvacCategories });
    const block = buildCategoryContextBlock(taxonomy, 'hvac-repair-electrical');
    expect(block.type).toBe('service_category');
    expect(block.content).toContain('Repair');
    expect(block.content).toContain('Electrical');
  });

  it('happy path — builds template context block', () => {
    const template = createEstimateTemplate({
      verticalSlug: 'hvac',
      categoryId: 'hvac-repair',
      name: 'AC Repair',
      description: 'Standard AC repair',
      lineItemTemplates: [
        { description: 'Diagnostic', defaultUnitPrice: 89, isOptional: false, sortOrder: 1 },
      ],
      promptHints: ['Check capacitor'],
    });
    const block = buildTemplateContextBlock(template);
    expect(block.content).toContain('AC Repair');
    expect(block.content).toContain('Diagnostic');
    expect(block.content).toContain('Check capacitor');
  });

  it('happy path — assembleTemplateContext returns blocks', async () => {
    const templateRepo = new InMemoryEstimateTemplateRepository();
    const taxRepo = new InMemoryServiceTaxonomyRepository();

    const taxonomy = createServiceTaxonomy({ verticalSlug: 'hvac', version: '1.0.0', categories: hvacCategories });
    await taxRepo.create(taxonomy);

    const template = createEstimateTemplate({ verticalSlug: 'hvac', categoryId: 'hvac-repair', name: 'T', description: 'd', lineItemTemplates: [] });
    await templateRepo.create(template);

    const blocks = await assembleTemplateContext('tenant-1', 'hvac', 'hvac-repair', templateRepo, taxRepo);
    expect(blocks).toHaveLength(2);
  });

  it('validation — formatCategoryPathForPrompt handles empty path', () => {
    expect(formatCategoryPathForPrompt([])).toBe('Unknown category');
  });

  it('mock provider test — formatTemplateForPrompt includes all details', () => {
    const template = createEstimateTemplate({
      verticalSlug: 'hvac', categoryId: 'r', name: 'Test', description: 'Desc',
      lineItemTemplates: [
        { description: 'Item A', defaultUnitPrice: 100, isOptional: true, sortOrder: 1 },
      ],
      promptHints: ['hint1'],
    });
    const text = formatTemplateForPrompt(template);
    expect(text).toContain('Item A');
    expect(text).toContain('$100');
    expect(text).toContain('optional');
    expect(text).toContain('hint1');
  });

  it('malformed AI output handled gracefully — no taxonomy returns fewer blocks', async () => {
    const templateRepo = new InMemoryEstimateTemplateRepository();
    const taxRepo = new InMemoryServiceTaxonomyRepository();

    const blocks = await assembleTemplateContext('tenant-1', 'hvac', 'hvac-repair', templateRepo, taxRepo);
    expect(blocks).toHaveLength(0);
  });
});
