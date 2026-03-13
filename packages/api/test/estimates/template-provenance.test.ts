import {
  InMemoryProvenanceRepository,
  createProvenance,
  validateProvenanceInput,
} from '../../src/estimates/provenance';

describe('P4-004C — Template provenance tagging', () => {
  let repo: InMemoryProvenanceRepository;

  beforeEach(() => {
    repo = new InMemoryProvenanceRepository();
  });

  it('happy path — creates provenance with vertical_template source type', async () => {
    const provenance = await createProvenance({
      tenantId: 't1',
      estimateId: 'est-1',
      sourceType: 'vertical_template',
      creatorId: 'user-1',
      creatorRole: 'dispatcher',
      templateId: 'template-1',
      verticalType: 'hvac',
    }, repo);

    expect(provenance.sourceType).toBe('vertical_template');
    expect(provenance.templateId).toBe('template-1');
    expect(provenance.verticalType).toBe('hvac');
  });

  it('happy path — retrieves provenance by estimate', async () => {
    await createProvenance({
      tenantId: 't1',
      estimateId: 'est-1',
      sourceType: 'vertical_template',
      creatorId: 'user-1',
      creatorRole: 'dispatcher',
      templateId: 'tmpl-1',
      verticalType: 'plumbing',
    }, repo);

    const found = await repo.findByEstimate('t1', 'est-1');
    expect(found).not.toBeNull();
    expect(found!.sourceType).toBe('vertical_template');
    expect(found!.templateId).toBe('tmpl-1');
  });

  it('validation — vertical_template is a valid source type', () => {
    const errors = validateProvenanceInput({
      tenantId: 't1',
      estimateId: 'est-1',
      sourceType: 'vertical_template',
      creatorId: 'user-1',
      creatorRole: 'dispatcher',
    });
    expect(errors).toHaveLength(0);
  });

  it('validation — existing source types still work', () => {
    for (const sourceType of ['manual', 'ai_generated', 'ai_revised', 'template', 'cloned'] as const) {
      const errors = validateProvenanceInput({
        tenantId: 't1',
        estimateId: 'est-1',
        sourceType,
        creatorId: 'user-1',
        creatorRole: 'dispatcher',
      });
      expect(errors).toHaveLength(0);
    }
  });

  it('validation — invalid source type still rejected', () => {
    const errors = validateProvenanceInput({
      tenantId: 't1',
      estimateId: 'est-1',
      sourceType: 'invalid' as any,
      creatorId: 'user-1',
      creatorRole: 'dispatcher',
    });
    expect(errors).toContain('Invalid sourceType');
  });
});
