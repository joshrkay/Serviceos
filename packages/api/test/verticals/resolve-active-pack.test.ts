import { describe, it, expect, beforeEach } from 'vitest';
import { buildVerticalPromptResolver } from '../../src/verticals/resolve-active-pack';
import {
  InMemoryPackActivationRepository,
  activatePack,
} from '../../src/settings/pack-activation';
import {
  InMemoryVerticalPackRegistry,
  registerPack,
} from '../../src/shared/vertical-pack-registry';

const TENANT = 'tenant-resolve';
const PACK_ID = 'hvac-pro-v1';

async function seedRegistry(): Promise<InMemoryVerticalPackRegistry> {
  const registry = new InMemoryVerticalPackRegistry();
  await registerPack(
    {
      packId: PACK_ID,
      version: '1.0.0',
      verticalType: 'hvac',
      status: 'active',
      displayName: 'HVAC Professional',
      description: 'Heating, ventilation, and air conditioning',
      metadata: {
        terminology: {
          furnace: { displayName: 'Furnace', aliases: ['heater', 'heating unit'] },
          ac: { displayName: 'Air Conditioner', aliases: ['a/c', 'central air'] },
        },
        categories: [
          { id: 'install', name: 'Installation', sortOrder: 1 },
          { id: 'repair', name: 'Repair', sortOrder: 2 },
        ],
      },
    },
    registry,
  );
  return registry;
}

describe('buildVerticalPromptResolver', () => {
  let packActivationRepo: InMemoryPackActivationRepository;
  let canonicalPackRegistry: InMemoryVerticalPackRegistry;

  beforeEach(async () => {
    packActivationRepo = new InMemoryPackActivationRepository();
    canonicalPackRegistry = await seedRegistry();
  });

  it('returns undefined when the tenant has no activations', async () => {
    const resolve = buildVerticalPromptResolver({ packActivationRepo, canonicalPackRegistry });
    expect(await resolve(TENANT)).toBeUndefined();
  });

  it('returns undefined when the tenant has only deactivated packs', async () => {
    const activation = await activatePack({ tenantId: TENANT, packId: PACK_ID }, packActivationRepo);
    await packActivationRepo.update(activation.id, { status: 'deactivated' });
    const resolve = buildVerticalPromptResolver({ packActivationRepo, canonicalPackRegistry });
    expect(await resolve(TENANT)).toBeUndefined();
  });

  it('returns the formatted vertical section for an active pack', async () => {
    await activatePack({ tenantId: TENANT, packId: PACK_ID }, packActivationRepo);
    const resolve = buildVerticalPromptResolver({ packActivationRepo, canonicalPackRegistry });
    const section = await resolve(TENANT);
    expect(section).toBeDefined();
    expect(section).toContain('Service vertical: HVAC Professional');
    expect(section).toContain('Furnace (heater, heating unit)');
    expect(section).toContain('Air Conditioner (a/c, central air)');
    expect(section).toContain('Service types offered:');
    expect(section).toContain('Installation');
    expect(section).toContain('Repair');
  });

  it('returns undefined when the activated packId is missing from the registry', async () => {
    await activatePack({ tenantId: TENANT, packId: 'unknown-pack' }, packActivationRepo);
    const resolve = buildVerticalPromptResolver({ packActivationRepo, canonicalPackRegistry });
    expect(await resolve(TENANT)).toBeUndefined();
  });

  it('isolates tenants — A’s active pack is invisible to B', async () => {
    await activatePack({ tenantId: TENANT, packId: PACK_ID }, packActivationRepo);
    const resolve = buildVerticalPromptResolver({ packActivationRepo, canonicalPackRegistry });
    expect(await resolve('tenant-other')).toBeUndefined();
  });
});
