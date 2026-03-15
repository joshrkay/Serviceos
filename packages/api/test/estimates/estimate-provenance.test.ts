import {
  createEstimateProvenance,
  validateEstimateProvenanceInput,
  InMemoryEstimateProvenanceRepository,
} from '../../src/estimates/estimate-provenance';

describe('P1-009B — Estimate provenance stub', () => {
  it('happy path — creates provenance with all fields', () => {
    const prov = createEstimateProvenance({
      tenantId: 'tenant-1',
      estimateId: 'est-1',
      templateId: 'tmpl-1',
      sourceSignals: ['approved_history', 'template'],
      aiRunId: 'run-1',
    });

    expect(prov.id).toBeTruthy();
    expect(prov.tenantId).toBe('tenant-1');
    expect(prov.sourceSignals).toEqual(['approved_history', 'template']);
    expect(prov.createdAt).toBeInstanceOf(Date);
  });

  it('validation — rejects missing required fields', () => {
    const errors = validateEstimateProvenanceInput({
      tenantId: '',
      estimateId: '',
      sourceSignals: null as any,
    });
    expect(errors).toContain('tenantId is required');
    expect(errors).toContain('estimateId is required');
    expect(errors).toContain('sourceSignals must be an array');
  });

  it('mock provider test — repository stores and retrieves by estimate', async () => {
    const repo = new InMemoryEstimateProvenanceRepository();
    const prov = createEstimateProvenance({
      tenantId: 'tenant-1',
      estimateId: 'est-1',
      sourceSignals: ['template'],
    });
    await repo.create(prov);

    const found = await repo.findByEstimate('tenant-1', 'est-1');
    expect(found).toHaveLength(1);
    expect(found[0].estimateId).toBe('est-1');
  });

  it('mock provider test — repository isolates tenants', async () => {
    const repo = new InMemoryEstimateProvenanceRepository();
    const prov = createEstimateProvenance({
      tenantId: 'tenant-1',
      estimateId: 'est-1',
      sourceSignals: [],
    });
    await repo.create(prov);

    const found = await repo.findByEstimate('other-tenant', 'est-1');
    expect(found).toHaveLength(0);
  });

  it('malformed AI output handled gracefully — handles empty sourceSignals', () => {
    const prov = createEstimateProvenance({
      tenantId: 'tenant-1',
      estimateId: 'est-1',
      sourceSignals: [],
    });
    expect(prov.sourceSignals).toEqual([]);
  });
});
