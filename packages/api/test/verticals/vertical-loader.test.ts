import { createVerticalPack, InMemoryVerticalPackRepository } from '../../src/verticals/vertical-pack';
import { createTerminologyMap, InMemoryTerminologyMapRepository } from '../../src/verticals/terminology-map';
import { createServiceTaxonomy, InMemoryServiceTaxonomyRepository } from '../../src/verticals/service-taxonomy';
import { createVerticalActivation, InMemoryVerticalActivationRepository } from '../../src/settings/vertical-activation';
import { createVerticalLoader, validatePackIntegrity } from '../../src/verticals/vertical-loader';
import { hvacTerminologyEntries } from '../../src/verticals/data/hvac-terminology';
import { hvacCategories } from '../../src/verticals/data/hvac-taxonomy';

describe('P4-001C — Vertical pack config loading', () => {
  async function setupTestData() {
    const packRepo = new InMemoryVerticalPackRepository();
    const termRepo = new InMemoryTerminologyMapRepository();
    const taxRepo = new InMemoryServiceTaxonomyRepository();
    const activationRepo = new InMemoryVerticalActivationRepository();

    const terminology = createTerminologyMap({
      verticalSlug: 'hvac',
      version: '1.0.0',
      entries: hvacTerminologyEntries,
    });
    await termRepo.create(terminology);

    const taxonomy = createServiceTaxonomy({
      verticalSlug: 'hvac',
      version: '1.0.0',
      categories: hvacCategories,
    });
    await taxRepo.create(taxonomy);

    const pack = createVerticalPack({
      slug: 'hvac',
      name: 'HVAC',
      version: '1.0.0',
      description: 'HVAC vertical pack',
      terminologyMapId: terminology.id,
      taxonomyId: taxonomy.id,
    });
    await packRepo.create(pack);

    return { packRepo, termRepo, taxRepo, activationRepo, pack, terminology, taxonomy };
  }

  it('happy path — loads all active packs for tenant', async () => {
    const { packRepo, termRepo, taxRepo, activationRepo, pack } = await setupTestData();

    const activation = createVerticalActivation({
      tenantId: 'tenant-1',
      verticalPackId: pack.id,
      verticalSlug: 'hvac',
      activatedBy: 'admin-1',
    });
    await activationRepo.create(activation);

    const loader = createVerticalLoader(packRepo, termRepo, taxRepo, activationRepo);
    const loaded = await loader.loadForTenant('tenant-1');

    expect(loaded).toHaveLength(1);
    expect(loaded[0].pack.slug).toBe('hvac');
    expect(loaded[0].terminology.entries.length).toBeGreaterThan(0);
    expect(loaded[0].taxonomy.categories.length).toBeGreaterThan(0);
  });

  it('happy path — loadBySlug returns pack', async () => {
    const { packRepo, termRepo, taxRepo, activationRepo } = await setupTestData();
    const loader = createVerticalLoader(packRepo, termRepo, taxRepo, activationRepo);
    const loaded = await loader.loadBySlug('hvac');

    expect(loaded).not.toBeNull();
    expect(loaded!.pack.slug).toBe('hvac');
  });

  it('validation — validatePackIntegrity detects mismatches', async () => {
    const { pack, terminology, taxonomy } = await setupTestData();
    const badTerminology = { ...terminology, verticalSlug: 'plumbing' };
    const errors = validatePackIntegrity({ pack, terminology: badTerminology, taxonomy });
    expect(errors).toContain('Terminology vertical slug does not match pack slug');
  });

  it('mock provider test — loadBySlug returns null for unknown slug', async () => {
    const { packRepo, termRepo, taxRepo, activationRepo } = await setupTestData();
    const loader = createVerticalLoader(packRepo, termRepo, taxRepo, activationRepo);
    const result = await loader.loadBySlug('nonexistent');
    expect(result).toBeNull();
  });

  it('mock provider test — loadForTenant returns empty for tenant with no activations', async () => {
    const { packRepo, termRepo, taxRepo, activationRepo } = await setupTestData();
    const loader = createVerticalLoader(packRepo, termRepo, taxRepo, activationRepo);
    const loaded = await loader.loadForTenant('no-activations-tenant');
    expect(loaded).toHaveLength(0);
  });

  it('malformed AI output handled gracefully — validatePackIntegrity detects empty entries', () => {
    const errors = validatePackIntegrity({
      pack: { id: '1', slug: 'hvac', name: 'HVAC', version: '1', description: 'd', terminologyMapId: 't1', taxonomyId: 'x1', templateIds: [], isActive: true, createdAt: new Date() },
      terminology: { id: 't1', verticalSlug: 'hvac', version: '1', entries: [], createdAt: new Date() },
      taxonomy: { id: 'x1', verticalSlug: 'hvac', version: '1', categories: [], createdAt: new Date() },
    });
    expect(errors).toContain('Terminology map has no entries');
    expect(errors).toContain('Taxonomy has no categories');
  });
});
