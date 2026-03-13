import {
  createVerticalPack,
  validateVerticalPack,
  resolveTerminology,
  getCategoryHierarchy,
  getChildCategories,
  InMemoryVerticalPackRepository,
  VerticalPack,
  ServiceCategory,
} from '../../src/verticals/registry';

describe('P4-001 — Vertical Pack Registry', () => {
  let repo: InMemoryVerticalPackRepository;
  let hvacPack: VerticalPack;

  const categories: ServiceCategory[] = [
    { id: 'install', name: 'Installation', sortOrder: 1 },
    { id: 'repair', name: 'Repair', sortOrder: 2 },
    { id: 'install-ac', name: 'AC Installation', parentId: 'install', sortOrder: 1 },
    { id: 'install-furnace', name: 'Furnace Installation', parentId: 'install', sortOrder: 2 },
  ];

  beforeEach(async () => {
    repo = new InMemoryVerticalPackRepository();
    hvacPack = createVerticalPack(
      'hvac',
      'HVAC Professional',
      '1.0.0',
      'HVAC service pack',
      categories,
      {
        ac: {
          displayName: 'Air Conditioner',
          aliases: ['air conditioner', 'a/c', 'central air'],
        },
        furnace: {
          displayName: 'Furnace',
          aliases: ['heater', 'heating unit'],
        },
      }
    );
    await repo.create(hvacPack);
  });

  it('happy path — creates and retrieves vertical pack', async () => {
    const found = await repo.findById(hvacPack.id);
    expect(found).not.toBeNull();
    expect(found!.type).toBe('hvac');
    expect(found!.name).toBe('HVAC Professional');
  });

  it('happy path — finds pack by type', async () => {
    const found = await repo.findByType('hvac');
    expect(found).not.toBeNull();
    expect(found!.type).toBe('hvac');
  });

  it('returns null for non-existent type', async () => {
    const found = await repo.findByType('plumbing');
    expect(found).toBeNull();
  });

  it('lists active packs only', async () => {
    const inactive = createVerticalPack('plumbing', 'Plumbing', '1.0.0', 'Plumbing pack', [], {});
    inactive.isActive = false;
    await repo.create(inactive);

    const active = await repo.findActive();
    expect(active).toHaveLength(1);
    expect(active[0].type).toBe('hvac');
  });

  it('validates pack inputs', () => {
    expect(validateVerticalPack({})).toContain('type is required');
    expect(validateVerticalPack({ type: 'invalid' as any })).toContain('type must be hvac or plumbing');
    expect(validateVerticalPack({ type: 'hvac' })).toContain('name is required');
    expect(validateVerticalPack({ type: 'hvac', name: 'Test', version: '1.0' })).toContain(
      'at least one category is required'
    );
  });

  it('resolves terminology by key', () => {
    const resolved = resolveTerminology(hvacPack, 'ac');
    expect(resolved).not.toBeNull();
    expect(resolved!.displayName).toBe('Air Conditioner');
  });

  it('resolves terminology by alias', () => {
    const resolved = resolveTerminology(hvacPack, 'central air');
    expect(resolved).not.toBeNull();
    expect(resolved!.displayName).toBe('Air Conditioner');
  });

  it('resolves terminology case-insensitively', () => {
    const resolved = resolveTerminology(hvacPack, 'A/C');
    expect(resolved).not.toBeNull();
    expect(resolved!.displayName).toBe('Air Conditioner');
  });

  it('returns null for unknown term', () => {
    expect(resolveTerminology(hvacPack, 'unknown-term')).toBeNull();
  });

  it('gets child categories', () => {
    const topLevel = getChildCategories(hvacPack, undefined);
    expect(topLevel).toHaveLength(2);
    expect(topLevel[0].name).toBe('Installation');

    const children = getChildCategories(hvacPack, 'install');
    expect(children).toHaveLength(2);
    expect(children[0].name).toBe('AC Installation');
  });

  it('gets category hierarchy', () => {
    const hierarchy = getCategoryHierarchy(hvacPack, 'install-ac');
    expect(hierarchy).toHaveLength(2);
    expect(hierarchy[0].name).toBe('Installation');
    expect(hierarchy[1].name).toBe('AC Installation');
  });

  it('updates vertical pack', async () => {
    const updated = await repo.update(hvacPack.id, { version: '1.1.0' });
    expect(updated).not.toBeNull();
    expect(updated!.version).toBe('1.1.0');
  });

  it('tenant isolation — findByType only returns active packs', async () => {
    await repo.update(hvacPack.id, { isActive: false });
    const found = await repo.findByType('hvac');
    expect(found).toBeNull();
  });
});
