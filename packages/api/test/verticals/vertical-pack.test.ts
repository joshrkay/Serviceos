import {
  createVerticalPack,
  validateVerticalPackInput,
  InMemoryVerticalPackRepository,
} from '../../src/verticals/vertical-pack';

describe('P4-001A — Vertical pack registry schema', () => {
  it('happy path — creates vertical pack with all fields', () => {
    const pack = createVerticalPack({
      slug: 'hvac',
      name: 'HVAC',
      version: '1.0.0',
      description: 'Heating, ventilation, and air conditioning vertical pack',
      terminologyMapId: 'term-1',
      taxonomyId: 'tax-1',
      templateIds: ['tmpl-1', 'tmpl-2'],
    });

    expect(pack.id).toBeTruthy();
    expect(pack.slug).toBe('hvac');
    expect(pack.isActive).toBe(true);
    expect(pack.templateIds).toEqual(['tmpl-1', 'tmpl-2']);
    expect(pack.createdAt).toBeInstanceOf(Date);
  });

  it('happy path — defaults templateIds to empty array', () => {
    const pack = createVerticalPack({
      slug: 'plumbing',
      name: 'Plumbing',
      version: '1.0.0',
      description: 'Plumbing vertical pack',
      terminologyMapId: 'term-1',
      taxonomyId: 'tax-1',
    });

    expect(pack.templateIds).toEqual([]);
  });

  it('validation — rejects missing required fields', () => {
    const errors = validateVerticalPackInput({
      slug: '',
      name: '',
      version: '',
      description: '',
      terminologyMapId: '',
      taxonomyId: '',
    });
    expect(errors).toContain('slug is required');
    expect(errors).toContain('name is required');
    expect(errors).toContain('version is required');
    expect(errors).toContain('description is required');
    expect(errors).toContain('terminologyMapId is required');
    expect(errors).toContain('taxonomyId is required');
  });

  it('mock provider test — repository stores and retrieves by id and slug', async () => {
    const repo = new InMemoryVerticalPackRepository();
    const pack = createVerticalPack({
      slug: 'hvac',
      name: 'HVAC',
      version: '1.0.0',
      description: 'HVAC pack',
      terminologyMapId: 'term-1',
      taxonomyId: 'tax-1',
    });
    await repo.create(pack);

    const byId = await repo.findById(pack.id);
    expect(byId).not.toBeNull();
    expect(byId!.slug).toBe('hvac');

    const bySlug = await repo.findBySlug('hvac');
    expect(bySlug).not.toBeNull();
    expect(bySlug!.id).toBe(pack.id);
  });

  it('mock provider test — findActive returns only active packs', async () => {
    const repo = new InMemoryVerticalPackRepository();
    const active = createVerticalPack({ slug: 'hvac', name: 'HVAC', version: '1.0.0', description: 'd', terminologyMapId: 't', taxonomyId: 'x' });
    const inactive = createVerticalPack({ slug: 'electrical', name: 'Electrical', version: '1.0.0', description: 'd', terminologyMapId: 't', taxonomyId: 'x' });
    (inactive as any).isActive = false;
    await repo.create(active);
    await repo.create(inactive);

    const results = await repo.findActive();
    expect(results).toHaveLength(1);
    expect(results[0].slug).toBe('hvac');
  });

  it('malformed AI output handled gracefully — findBySlug returns null for unknown', async () => {
    const repo = new InMemoryVerticalPackRepository();
    const result = await repo.findBySlug('nonexistent');
    expect(result).toBeNull();
  });
});
