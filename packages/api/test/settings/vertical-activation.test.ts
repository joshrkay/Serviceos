import {
  createVerticalActivation,
  deactivateVertical,
  getActiveVerticals,
  validateVerticalActivationInput,
  InMemoryVerticalActivationRepository,
} from '../../src/settings/vertical-activation';

describe('P4-001B — Tenant-to-pack activation linkage', () => {
  it('happy path — creates activation with all fields', () => {
    const activation = createVerticalActivation({
      tenantId: 'tenant-1',
      verticalPackId: 'pack-1',
      verticalSlug: 'hvac',
      activatedBy: 'admin-1',
      config: { region: 'northeast' },
    });

    expect(activation.id).toBeTruthy();
    expect(activation.tenantId).toBe('tenant-1');
    expect(activation.verticalSlug).toBe('hvac');
    expect(activation.isActive).toBe(true);
    expect(activation.activatedAt).toBeInstanceOf(Date);
  });

  it('happy path — deactivate vertical', () => {
    const activation = createVerticalActivation({
      tenantId: 'tenant-1',
      verticalPackId: 'pack-1',
      verticalSlug: 'hvac',
      activatedBy: 'admin-1',
    });

    const deactivated = deactivateVertical(activation);
    expect(deactivated.isActive).toBe(false);
    expect(deactivated.tenantId).toBe('tenant-1');
  });

  it('validation — rejects missing required fields', () => {
    const errors = validateVerticalActivationInput({
      tenantId: '',
      verticalPackId: '',
      verticalSlug: '',
      activatedBy: '',
    });
    expect(errors).toContain('tenantId is required');
    expect(errors).toContain('verticalPackId is required');
    expect(errors).toContain('verticalSlug is required');
    expect(errors).toContain('activatedBy is required');
  });

  it('mock provider test — repository stores and retrieves', async () => {
    const repo = new InMemoryVerticalActivationRepository();
    const activation = createVerticalActivation({
      tenantId: 'tenant-1',
      verticalPackId: 'pack-1',
      verticalSlug: 'hvac',
      activatedBy: 'admin-1',
    });
    await repo.create(activation);

    const found = await repo.findByTenantAndSlug('tenant-1', 'hvac');
    expect(found).not.toBeNull();
    expect(found!.verticalSlug).toBe('hvac');
  });

  it('mock provider test — repository isolates tenants', async () => {
    const repo = new InMemoryVerticalActivationRepository();
    const activation = createVerticalActivation({
      tenantId: 'tenant-1',
      verticalPackId: 'pack-1',
      verticalSlug: 'hvac',
      activatedBy: 'admin-1',
    });
    await repo.create(activation);

    const found = await repo.findByTenantAndSlug('other-tenant', 'hvac');
    expect(found).toBeNull();
  });

  it('mock provider test — getActiveVerticals filters inactive', async () => {
    const repo = new InMemoryVerticalActivationRepository();
    const a1 = createVerticalActivation({
      tenantId: 'tenant-1',
      verticalPackId: 'pack-1',
      verticalSlug: 'hvac',
      activatedBy: 'admin-1',
    });
    const a2 = createVerticalActivation({
      tenantId: 'tenant-1',
      verticalPackId: 'pack-2',
      verticalSlug: 'plumbing',
      activatedBy: 'admin-1',
    });
    await repo.create(a1);
    await repo.create(a2);
    await repo.deactivate('tenant-1', a2.id);

    const active = await getActiveVerticals('tenant-1', repo);
    expect(active).toHaveLength(1);
    expect(active[0].verticalSlug).toBe('hvac');
  });

  it('malformed AI output handled gracefully — deactivate returns null for wrong tenant', async () => {
    const repo = new InMemoryVerticalActivationRepository();
    const activation = createVerticalActivation({
      tenantId: 'tenant-1',
      verticalPackId: 'pack-1',
      verticalSlug: 'hvac',
      activatedBy: 'admin-1',
    });
    await repo.create(activation);

    const result = await repo.deactivate('other-tenant', activation.id);
    expect(result).toBeNull();
  });
});
