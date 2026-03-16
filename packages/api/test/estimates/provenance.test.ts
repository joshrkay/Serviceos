import {
  createProvenance,
  validateProvenanceInput,
  InMemoryProvenanceRepository,
} from '../../src/estimates/provenance';

describe('P1-009B — Estimate provenance metadata', () => {
  let repo: InMemoryProvenanceRepository;

  beforeEach(() => {
    repo = new InMemoryProvenanceRepository();
  });

  it('happy path — creates manual provenance', async () => {
    const prov = await createProvenance(
      {
        tenantId: 'tenant-1',
        estimateId: 'est-1',
        sourceType: 'manual',
        creatorId: 'user-1',
        creatorRole: 'owner',
      },
      repo
    );

    expect(prov.id).toBeTruthy();
    expect(prov.sourceType).toBe('manual');
  });

  it('happy path — creates AI-generated provenance with links', async () => {
    const prov = await createProvenance(
      {
        tenantId: 'tenant-1',
        estimateId: 'est-2',
        sourceType: 'ai_generated',
        creatorId: 'ai-system',
        creatorRole: 'owner',
        aiRunId: 'run-1',
        conversationId: 'conv-1',
      },
      repo
    );

    expect(prov.sourceType).toBe('ai_generated');
    expect(prov.aiRunId).toBe('run-1');
    expect(prov.conversationId).toBe('conv-1');
  });

  it('happy path — retrieves provenance by estimate', async () => {
    await createProvenance(
      { tenantId: 'tenant-1', estimateId: 'est-1', sourceType: 'manual', creatorId: 'u-1', creatorRole: 'owner' },
      repo
    );

    const found = await repo.findByEstimate('tenant-1', 'est-1');
    expect(found).not.toBeNull();
    expect(found!.estimateId).toBe('est-1');
  });

  it('validation — rejects missing fields', () => {
    const errors = validateProvenanceInput({
      tenantId: '',
      estimateId: '',
      sourceType: '' as any,
      creatorId: '',
      creatorRole: '',
    });
    expect(errors).toContain('tenantId is required');
    expect(errors).toContain('estimateId is required');
    expect(errors).toContain('sourceType is required');
    expect(errors).toContain('creatorId is required');
  });

  it('validation — rejects invalid sourceType', () => {
    const errors = validateProvenanceInput({
      tenantId: 'tenant-1',
      estimateId: 'est-1',
      sourceType: 'unknown' as any,
      creatorId: 'u-1',
      creatorRole: 'owner',
    });
    expect(errors).toContain('Invalid sourceType');
  });
});
