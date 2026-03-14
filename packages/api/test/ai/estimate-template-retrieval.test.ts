import {
  InMemoryEstimateTemplateRepository,
  createTemplate,
  findTemplate,
} from '../../src/ai/tasks/estimate-template';

describe('P4-004B — Template retrieval by vertical and category', () => {
  let repo: InMemoryEstimateTemplateRepository;

  beforeEach(async () => {
    repo = new InMemoryEstimateTemplateRepository();
    await createTemplate({
      packId: 'hvac-v1',
      verticalType: 'hvac',
      serviceCategory: 'diagnostic',
      name: 'HVAC Diagnostic',
      defaultLineItems: [{ description: 'Diagnostic fee', category: 'labor', quantity: 1, unitPriceCents: 8900, taxable: true, sortOrder: 1 }],
    }, repo);
    await createTemplate({
      packId: 'hvac-v1',
      verticalType: 'hvac',
      serviceCategory: 'repair',
      name: 'HVAC Repair',
      defaultLineItems: [{ description: 'Repair labor', category: 'labor', quantity: 1, unitPriceCents: 15000, taxable: true, sortOrder: 1 }],
    }, repo);
    await createTemplate({
      packId: 'plumbing-v1',
      verticalType: 'plumbing',
      serviceCategory: 'drain',
      name: 'Drain Service',
      defaultLineItems: [{ description: 'Drain cleaning', category: 'labor', quantity: 1, unitPriceCents: 12000, taxable: true, sortOrder: 1 }],
    }, repo);
  });

  it('happy path — retrieves exact match by vertical and category', async () => {
    const template = await findTemplate('hvac', 'diagnostic', repo);
    expect(template).not.toBeNull();
    expect(template!.name).toBe('HVAC Diagnostic');
    expect(template!.serviceCategory).toBe('diagnostic');
  });

  it('happy path — retrieves different vertical template', async () => {
    const template = await findTemplate('plumbing', 'drain', repo);
    expect(template).not.toBeNull();
    expect(template!.name).toBe('Drain Service');
  });

  it('happy path — falls back to vertical default when no category match', async () => {
    // No HVAC emergency template exists, so falls back to lowest-sortOrder HVAC template
    const template = await findTemplate('hvac', 'emergency', repo);
    expect(template).not.toBeNull();
    expect(template!.verticalType).toBe('hvac');
  });

  it('happy path — fallback does not cross verticals', async () => {
    // No plumbing diagnostic template, but falls back to plumbing's drain template
    const template = await findTemplate('plumbing', 'diagnostic', repo);
    expect(template).not.toBeNull();
    expect(template!.verticalType).toBe('plumbing');
    expect(template!.name).toBe('Drain Service');
  });

  it('happy path — returns null when no templates for vertical exist', async () => {
    const emptyRepo = new InMemoryEstimateTemplateRepository();
    const template = await findTemplate('hvac', 'diagnostic', emptyRepo);
    expect(template).toBeNull();
  });

  it('mock provider — findByVertical lists all templates for a vertical', async () => {
    const hvacTemplates = await repo.findByVertical('hvac');
    expect(hvacTemplates).toHaveLength(2);

    const plumbingTemplates = await repo.findByVertical('plumbing');
    expect(plumbingTemplates).toHaveLength(1);
  });
});
