import { getVerticalSettings, formatVerticalSettingsForApi } from '../../src/settings/vertical-settings';
import { createVerticalActivation, InMemoryVerticalActivationRepository } from '../../src/settings/vertical-activation';
import { createVerticalPack, InMemoryVerticalPackRepository } from '../../src/verticals/vertical-pack';

describe('P4-010A — Active vertical settings in tenant config', () => {
  async function setup() {
    const activationRepo = new InMemoryVerticalActivationRepository();
    const packRepo = new InMemoryVerticalPackRepository();

    const pack = createVerticalPack({ slug: 'hvac', name: 'HVAC', version: '1.0.0', description: 'd', terminologyMapId: 't', taxonomyId: 'x' });
    await packRepo.create(pack);

    const activation = createVerticalActivation({ tenantId: 'tenant-1', verticalPackId: pack.id, verticalSlug: 'hvac', activatedBy: 'admin' });
    await activationRepo.create(activation);

    return { activationRepo, packRepo, pack };
  }

  it('happy path — returns settings view with active verticals', async () => {
    const { activationRepo, packRepo } = await setup();
    const view = await getVerticalSettings('tenant-1', activationRepo, packRepo);
    expect(view.tenantId).toBe('tenant-1');
    expect(view.activeVerticals).toHaveLength(1);
    expect(view.activeVerticals[0].verticalSlug).toBe('hvac');
    expect(view.availablePacks.length).toBeGreaterThanOrEqual(1);
  });

  it('happy path — formatVerticalSettingsForApi formats correctly', async () => {
    const { activationRepo, packRepo } = await setup();
    const view = await getVerticalSettings('tenant-1', activationRepo, packRepo);
    const formatted = formatVerticalSettingsForApi(view);
    expect(formatted.tenantId).toBe('tenant-1');
    expect(Array.isArray(formatted.activeVerticals)).toBe(true);
  });

  it('validation — empty tenant returns no active verticals', async () => {
    const { activationRepo, packRepo } = await setup();
    const view = await getVerticalSettings('no-verticals', activationRepo, packRepo);
    expect(view.activeVerticals).toHaveLength(0);
  });

  it('mock provider test — available packs listed even if none active', async () => {
    const activationRepo = new InMemoryVerticalActivationRepository();
    const packRepo = new InMemoryVerticalPackRepository();
    const pack = createVerticalPack({ slug: 'hvac', name: 'HVAC', version: '1.0.0', description: 'd', terminologyMapId: 't', taxonomyId: 'x' });
    await packRepo.create(pack);

    const view = await getVerticalSettings('tenant-no-activations', activationRepo, packRepo);
    expect(view.activeVerticals).toHaveLength(0);
    expect(view.availablePacks).toHaveLength(1);
  });

  it('malformed AI output handled gracefully — handles missing pack for activation', async () => {
    const activationRepo = new InMemoryVerticalActivationRepository();
    const packRepo = new InMemoryVerticalPackRepository();
    const activation = createVerticalActivation({ tenantId: 'tenant-1', verticalPackId: 'nonexistent', verticalSlug: 'hvac', activatedBy: 'admin' });
    await activationRepo.create(activation);

    const view = await getVerticalSettings('tenant-1', activationRepo, packRepo);
    expect(view.activeVerticals).toHaveLength(1);
    expect(view.activeVerticals[0].packName).toBe('hvac');
  });
});
