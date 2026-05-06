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

  it('picks the most recently activated active pack (deterministic ordering)', async () => {
    // Codex P2 — InMemory preserves insertion order, Pg orders by
    // activated_at DESC. Without an explicit sort the resolver could
    // return different packs in dev vs prod for the same tenant.
    const PACK_OLDER = 'plumbing-pro-v1';
    await registerPack(
      {
        packId: PACK_OLDER,
        version: '1.0.0',
        verticalType: 'plumbing',
        status: 'active',
        displayName: 'Plumbing Pro (older activation)',
        metadata: {
          terminology: { pipe: { displayName: 'Pipe', aliases: [] } },
          categories: [{ id: 'p1', name: 'Pipe Repair', sortOrder: 1 }],
        },
      },
      canonicalPackRegistry,
    );

    // Insert OLDER first, then PACK_ID. InMemory iteration order would
    // return the older one; explicit sort by activatedAt should return
    // the newer (PACK_ID).
    const older = await activatePack({ tenantId: TENANT, packId: PACK_OLDER }, packActivationRepo);
    await packActivationRepo.update(older.id, { activatedAt: new Date('2026-01-01T00:00:00Z') });
    const newer = await activatePack({ tenantId: TENANT, packId: PACK_ID }, packActivationRepo);
    await packActivationRepo.update(newer.id, { activatedAt: new Date('2026-04-01T00:00:00Z') });

    const resolve = buildVerticalPromptResolver({ packActivationRepo, canonicalPackRegistry });
    const section = await resolve(TENANT);
    expect(section).toContain('Service vertical: HVAC Professional');
    expect(section).not.toContain('Plumbing Pro');
  });

  it('skips canonical packs whose registry status is not "active"', async () => {
    // Codex P2 — pack is deprecated upstream while activation remains
    // active. Resolver must not surface deprecated taxonomy.
    const found = await canonicalPackRegistry.getByPackId(PACK_ID);
    if (!found) throw new Error('seed pack missing');
    await canonicalPackRegistry.update(found.id, { status: 'deprecated' });

    await activatePack({ tenantId: TENANT, packId: PACK_ID }, packActivationRepo);
    const resolve = buildVerticalPromptResolver({ packActivationRepo, canonicalPackRegistry });
    expect(await resolve(TENANT)).toBeUndefined();
  });
});
