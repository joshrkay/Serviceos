import {
  InMemoryPackActivationRepository,
  activatePack,
  deactivatePack,
  getActivePacks,
  validateActivationInput,
} from '../../src/settings/pack-activation';

describe('P4-001B — Tenant-to-pack activation linkage', () => {
  let repo: InMemoryPackActivationRepository;

  beforeEach(() => {
    repo = new InMemoryPackActivationRepository();
  });

  it('happy path — activates a pack for a tenant', async () => {
    const activation = await activatePack({ tenantId: 't1', packId: 'hvac-v1' }, repo);

    expect(activation.id).toBeDefined();
    expect(activation.tenantId).toBe('t1');
    expect(activation.packId).toBe('hvac-v1');
    expect(activation.status).toBe('active');
    expect(activation.activatedAt).toBeInstanceOf(Date);
  });

  it('happy path — activates both HVAC and plumbing', async () => {
    await activatePack({ tenantId: 't1', packId: 'hvac-v1' }, repo);
    await activatePack({ tenantId: 't1', packId: 'plumbing-v1' }, repo);

    const active = await getActivePacks('t1', repo);
    expect(active).toHaveLength(2);
    expect(active.map((a) => a.packId).sort()).toEqual(['hvac-v1', 'plumbing-v1']);
  });

  it('happy path — deactivates a pack', async () => {
    await activatePack({ tenantId: 't1', packId: 'hvac-v1' }, repo);
    const deactivated = await deactivatePack('t1', 'hvac-v1', repo);

    expect(deactivated).not.toBeNull();
    expect(deactivated!.status).toBe('deactivated');
    expect(deactivated!.deactivatedAt).toBeInstanceOf(Date);

    const active = await getActivePacks('t1', repo);
    expect(active).toHaveLength(0);
  });

  it('happy path — reactivates a deactivated pack', async () => {
    await activatePack({ tenantId: 't1', packId: 'hvac-v1' }, repo);
    await deactivatePack('t1', 'hvac-v1', repo);
    const reactivated = await activatePack({ tenantId: 't1', packId: 'hvac-v1' }, repo);

    expect(reactivated.status).toBe('active');
  });

  it('validation — rejects missing tenantId', () => {
    const errors = validateActivationInput({ tenantId: '', packId: 'hvac-v1' });
    expect(errors).toContain('tenantId is required');
  });

  it('validation — rejects missing packId', () => {
    const errors = validateActivationInput({ tenantId: 't1', packId: '' });
    expect(errors).toContain('packId is required');
  });

  it('edge case — throws if pack already active', async () => {
    await activatePack({ tenantId: 't1', packId: 'hvac-v1' }, repo);
    await expect(activatePack({ tenantId: 't1', packId: 'hvac-v1' }, repo))
      .rejects.toThrow('Pack already activated for this tenant');
  });

  it('edge case — deactivate unknown pack returns null', async () => {
    const result = await deactivatePack('t1', 'nonexistent', repo);
    expect(result).toBeNull();
  });

  it('tenant isolation — packs are scoped to tenant', async () => {
    await activatePack({ tenantId: 't1', packId: 'hvac-v1' }, repo);
    await activatePack({ tenantId: 't2', packId: 'plumbing-v1' }, repo);

    const t1Packs = await getActivePacks('t1', repo);
    expect(t1Packs).toHaveLength(1);
    expect(t1Packs[0].packId).toBe('hvac-v1');

    const t2Packs = await getActivePacks('t2', repo);
    expect(t2Packs).toHaveLength(1);
    expect(t2Packs[0].packId).toBe('plumbing-v1');
  });
});
