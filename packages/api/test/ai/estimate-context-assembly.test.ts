import { assembleVerticalEstimateContext } from '../../src/ai/tasks/estimate-context';
import { SourceContext } from '../../src/ai/orchestration/context-builder';
import { VerticalPackConfig } from '../../src/shared/pack-config-loader';
import { EstimateTemplate } from '../../src/ai/tasks/estimate-template';

describe('P4-009B — Service category + template context assembly', () => {
  const sourceContext: SourceContext = {
    tenant: { name: 'Test Co' },
  };

  const hvacConfig: VerticalPackConfig = {
    verticalType: 'hvac',
    packId: 'hvac-v1',
    version: '1.0.0',
    terminology: {
      furnace: { canonical: 'furnace', displayLabel: 'Furnace', promptHint: 'Gas or electric furnace', aliases: [] },
      ac_unit: { canonical: 'ac_unit', displayLabel: 'AC Unit', promptHint: 'Air conditioning unit', aliases: [] },
    },
    categories: [{ id: 'diagnostic', name: 'Diagnostic', description: 'Diagnostic services', sortOrder: 1, typicalLineItems: ['Diagnostic fee'] }],
  };

  const template: EstimateTemplate = {
    id: 'tmpl-1',
    packId: 'hvac-v1',
    verticalType: 'hvac',
    serviceCategory: 'diagnostic',
    name: 'HVAC Diagnostic',
    defaultLineItems: [
      { description: 'Diagnostic service call', category: 'labor', quantity: 1, unitPriceCents: 8900, taxable: true, sortOrder: 1 },
    ],
    defaultNotes: 'Standard diagnostic',
    sortOrder: 1,
    createdAt: new Date(),
  };

  it('happy path — assembles vertical context with template', () => {
    const context = assembleVerticalEstimateContext(sourceContext, hvacConfig, template);

    expect(context.serviceCategory).toBe('diagnostic');
    expect(context.templateSummary).toBeDefined();
    expect(context.templateSummary!.name).toBe('HVAC Diagnostic');
    expect(context.templateSummary!.defaultLineItems).toHaveLength(1);
    expect(context.terminologyHints).toBeDefined();
    expect(context.terminologyHints!.length).toBeGreaterThan(0);
  });

  it('happy path — assembles without template', () => {
    const context = assembleVerticalEstimateContext(sourceContext, hvacConfig, null);

    expect(context.serviceCategory).toBeUndefined();
    expect(context.templateSummary).toBeUndefined();
    expect(context.terminologyHints).toBeDefined();
  });

  it('mock provider — no vertical returns empty context', () => {
    const context = assembleVerticalEstimateContext(sourceContext, null, null);

    expect(context.serviceCategory).toBeUndefined();
    expect(context.templateSummary).toBeUndefined();
    expect(context.terminologyHints).toBeUndefined();
  });

  it('happy path — terminology hints are limited in size', () => {
    const largeConfig: VerticalPackConfig = {
      ...hvacConfig,
      terminology: Object.fromEntries(
        Array.from({ length: 30 }, (_, i) => [`term_${i}`, {
          canonical: `term_${i}`, displayLabel: `Term ${i}`, promptHint: `Hint ${i}`, aliases: [],
        }])
      ),
    };

    const context = assembleVerticalEstimateContext(sourceContext, largeConfig, null);
    expect(context.terminologyHints!.length).toBeLessThanOrEqual(15);
  });
});
