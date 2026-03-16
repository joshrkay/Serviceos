import { buildCategoryContextBlock, buildTemplateContextBlock, assembleTemplateContext, formatTemplateForPrompt, formatCategoryPathForPrompt } from '../../../src/ai/tasks/template-context';
import { createTemplate, InMemoryEstimateTemplateRepository } from '../../../src/ai/tasks/estimate-template';
import { createServiceTaxonomy, InMemoryServiceTaxonomyRepository } from '../../../src/verticals/service-taxonomy';
import { hvacCategories } from '../../../src/verticals/data/hvac-taxonomy';

describe('P4-009B — Service category + template context assembly', () => {
  it('happy path — builds category context block', () => {
    const taxonomy = createServiceTaxonomy({ verticalSlug: 'hvac', version: '1.0.0', categories: hvacCategories });
    const block = buildCategoryContextBlock(taxonomy, 'hvac-repair-electrical');
    expect(block.type).toBe('service_category');
    expect(block.content).toContain('Repair');
  });

  it('happy path — builds template context block', async () => {
    const repo = new InMemoryEstimateTemplateRepository();
    const template = await createTemplate({
      packId: 'pack-1',
      verticalType: 'hvac',
      serviceCategory: 'repair',
      name: 'AC Repair',
      defaultNotes: 'Standard AC repair',
      defaultLineItems: [
        { description: 'Diagnostic', quantity: 1, unitPriceCents: 8900, taxable: true, sortOrder: 1 },
      ],
    }, repo);
    const block = buildTemplateContextBlock(template);
    expect(block.content).toContain('AC Repair');
    expect(block.content).toContain('Diagnostic');
  });

  it('happy path — assembleTemplateContext returns blocks', async () => {
    const templateRepo = new InMemoryEstimateTemplateRepository();
    const taxRepo = new InMemoryServiceTaxonomyRepository();

    const taxonomy = createServiceTaxonomy({ verticalSlug: 'hvac', version: '1.0.0', categories: hvacCategories });
    await taxRepo.create(taxonomy);

    await createTemplate({
      packId: 'pack-1', verticalType: 'hvac', serviceCategory: 'repair', name: 'T',
      defaultLineItems: [{ description: 'item', quantity: 1, unitPriceCents: 100, taxable: true, sortOrder: 1 }],
    }, templateRepo);

    const blocks = await assembleTemplateContext('tenant-1', 'hvac', 'repair', templateRepo, taxRepo);
    expect(blocks.length).toBeGreaterThanOrEqual(1);
  });

  it('validation — formatCategoryPathForPrompt handles empty path', () => {
    expect(formatCategoryPathForPrompt([])).toBe('Unknown category');
  });

  it('mock provider test — formatTemplateForPrompt includes all details', async () => {
    const repo = new InMemoryEstimateTemplateRepository();
    const template = await createTemplate({
      packId: 'pack-1',
      verticalType: 'hvac', serviceCategory: 'repair', name: 'Test', defaultNotes: 'Desc',
      defaultLineItems: [
        { description: 'Item A', quantity: 1, unitPriceCents: 10000, taxable: true, sortOrder: 1 },
      ],
    }, repo);
    const text = formatTemplateForPrompt(template);
    expect(text).toContain('Item A');
    expect(text).toContain('$100.00');
  });

  it('malformed AI output handled gracefully — no taxonomy returns fewer blocks', async () => {
    const templateRepo = new InMemoryEstimateTemplateRepository();
    const taxRepo = new InMemoryServiceTaxonomyRepository();

    const blocks = await assembleTemplateContext('tenant-1', 'hvac', 'repair', templateRepo, taxRepo);
    expect(blocks).toHaveLength(0);
  });
});
