import {
  InMemoryVerticalPackRegistry,
  registerPack,
  activatePackStatus,
  deprecatePack,
  validatePackInput,
  CreatePackInput,
} from '../../src/shared/vertical-pack-registry';
import { PgVerticalPackRegistry } from '../../src/shared/pg-vertical-pack-registry';

describe('P4-001A — Canonical vertical pack registry model', () => {
  let registry: InMemoryVerticalPackRegistry;

  beforeEach(() => {
    registry = new InMemoryVerticalPackRegistry();
  });

  it('happy path — registers and retrieves a pack', async () => {
    const input: CreatePackInput = {
      packId: 'hvac-v1',
      version: '1.0.0',
      verticalType: 'hvac',
      displayName: 'HVAC Pack',
      description: 'Core HVAC vertical pack',
    };

    const pack = await registerPack(input, registry);

    expect(pack.id).toBeDefined();
    expect(pack.packId).toBe('hvac-v1');
    expect(pack.verticalType).toBe('hvac');
    expect(pack.status).toBe('draft');
    expect(pack.displayName).toBe('HVAC Pack');

    const retrieved = await registry.get(pack.id);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.packId).toBe('hvac-v1');
  });

  it('happy path — retrieves by packId', async () => {
    await registerPack({
      packId: 'plumbing-v1',
      version: '1.0.0',
      verticalType: 'plumbing',
      displayName: 'Plumbing Pack',
    }, registry);

    const found = await registry.getByPackId('plumbing-v1');
    expect(found).not.toBeNull();
    expect(found!.verticalType).toBe('plumbing');
  });

  it('happy path — lists packs by vertical type', async () => {
    await registerPack({
      packId: 'hvac-v1',
      version: '1.0.0',
      verticalType: 'hvac',
      displayName: 'HVAC Pack',
    }, registry);

    await registerPack({
      packId: 'plumbing-v1',
      version: '1.0.0',
      verticalType: 'plumbing',
      displayName: 'Plumbing Pack',
    }, registry);

    const hvacPacks = await registry.findByVertical('hvac');
    expect(hvacPacks).toHaveLength(1);
    expect(hvacPacks[0].verticalType).toBe('hvac');

    const allPacks = await registry.list();
    expect(allPacks).toHaveLength(2);
  });


  it('uses canonical field names only', async () => {
    const pack = await registerPack({
      packId: 'canonical-hvac-v1',
      version: '1.0.0',
      verticalType: 'hvac',
      displayName: 'HVAC Pack',
      status: 'active',
    }, registry);

    expect(pack.verticalType).toBe('hvac');
    expect(pack.status).toBe('active');
    expect((pack as any).type).toBeUndefined();
    expect((pack as any).isActive).toBeUndefined();
  });

  it('happy path — activates and deprecates a pack', async () => {
    const pack = await registerPack({
      packId: 'hvac-v1',
      version: '1.0.0',
      verticalType: 'hvac',
      displayName: 'HVAC Pack',
    }, registry);

    const activated = await activatePackStatus(pack.id, registry);
    expect(activated!.status).toBe('active');

    const deprecated = await deprecatePack(pack.id, registry);
    expect(deprecated!.status).toBe('deprecated');
  });

  it('validation — rejects missing packId', () => {
    const errors = validatePackInput({
      packId: '',
      version: '1.0.0',
      verticalType: 'hvac',
      displayName: 'Test',
    });
    expect(errors).toContain('packId is required');
  });

  it('validation — rejects invalid verticalType', () => {
    const errors = validatePackInput({
      packId: 'test',
      version: '1.0.0',
      verticalType: 'roofing' as any,
      displayName: 'Test',
    });
    expect(errors).toContain('Invalid verticalType');
  });

  it('validation — rejects missing version', () => {
    const errors = validatePackInput({
      packId: 'test',
      version: '',
      verticalType: 'hvac',
      displayName: 'Test',
    });
    expect(errors).toContain('version is required');
  });

  it('validation — rejects missing displayName', () => {
    const errors = validatePackInput({
      packId: 'test',
      version: '1.0.0',
      verticalType: 'hvac',
      displayName: '',
    });
    expect(errors).toContain('displayName is required');
  });

  it('validation — rejects invalid status', () => {
    const errors = validatePackInput({
      packId: 'test',
      version: '1.0.0',
      verticalType: 'hvac',
      displayName: 'Test',
      status: 'invalid' as any,
    });
    expect(errors).toContain('Invalid status');
  });

  it('edge case — get returns null for unknown id', async () => {
    const result = await registry.get('nonexistent');
    expect(result).toBeNull();
  });

  it('edge case — update returns null for unknown id', async () => {
    const result = await registry.update('nonexistent', { status: 'active' });
    expect(result).toBeNull();
  });

  it('edge case — stores and returns metadata', async () => {
    const pack = await registerPack({
      packId: 'hvac-v1',
      version: '1.0.0',
      verticalType: 'hvac',
      displayName: 'HVAC Pack',
      metadata: { region: 'US', tier: 'standard' },
    }, registry);

    expect(pack.metadata).toEqual({ region: 'US', tier: 'standard' });
  });

  it('does not replace a canonical in-memory pack with non-canonical input for the same packId', async () => {
    const now = new Date('2026-05-15T00:00:00Z');
    await registry.register({
      id: 'canonical-hvac',
      packId: 'hvac-v1',
      version: '1.0.0',
      verticalType: 'hvac',
      status: 'active',
      displayName: 'HVAC Canonical',
      metadata: { canonical: true, seededBy: 'createApp', training_tier: 'first_class' },
      createdAt: now,
      updatedAt: now,
    });

    await registry.register({
      id: 'custom-hvac',
      packId: 'hvac-v1',
      version: '9.9.9',
      verticalType: 'hvac',
      status: 'active',
      displayName: 'Tenant Custom HVAC',
      metadata: { custom: true },
      createdAt: now,
      updatedAt: now,
    });

    const found = await registry.getByPackId('hvac-v1');
    expect(found!.id).toBe('canonical-hvac');
    expect(found!.displayName).toBe('HVAC Canonical');
    expect(found!.metadata).toMatchObject({ canonical: true, seededBy: 'createApp' });
  });
});

describe('PgVerticalPackRegistry canonical conflict handling', () => {
  it('updates existing canonical rows on type conflict without dumping metadata in SQL', async () => {
    const calls: Array<{ sql: string; params?: unknown[] }> = [];
    const now = new Date('2026-05-15T00:00:00Z');
    const client = {
      query: async (sql: string, params?: unknown[]) => {
        calls.push({ sql, params });
        return {
          rows: [
            {
              id: 'pack-1',
              type: 'hvac-v1',
              name: 'HVAC Professional',
              version: '1.0.0',
              description: 'Heating, ventilation, and air conditioning',
              is_active: true,
              terminology: {
                _verticalType: 'hvac',
                canonical: true,
                seededBy: 'createApp',
                training_tier: 'first_class',
                training_assets: [],
              },
              created_at: now,
              updated_at: now,
            },
          ],
        };
      },
      release: () => undefined,
    };
    const pool = {
      connect: async () => client,
    };
    const registry = new PgVerticalPackRegistry(pool as never);

    await registry.register({
      id: 'pack-1',
      packId: 'hvac-v1',
      version: '1.0.0',
      verticalType: 'hvac',
      status: 'active',
      displayName: 'HVAC Professional',
      metadata: {
        canonical: true,
        seededBy: 'createApp',
        training_tier: 'first_class',
        training_assets: [],
      },
      createdAt: now,
      updatedAt: now,
    });

    expect(calls[0].sql).toContain('ON CONFLICT (type) DO UPDATE');
    expect(calls[0].sql).toContain("terminology->>'seededBy' = 'createApp'");
    expect(calls[0].sql).toContain("EXCLUDED.terminology->>'seededBy' = 'createApp'");
    expect(calls[0].sql).toContain('EXCLUDED.terminology @>');
    expect(calls[0].sql).toContain('terminology = EXCLUDED.terminology');
    expect(calls[0].sql).not.toContain('training_assets');
  });
});
