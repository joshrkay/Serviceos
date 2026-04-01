import {
  InMemoryVerticalPackRegistry,
  registerPack,
  activatePackStatus,
  deprecatePack,
  validatePackInput,
  CreatePackInput,
} from '../../src/shared/vertical-pack-registry';
import { ValidationError } from '../../src/shared/errors';

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

  it('validation — write path rejects missing packId with structured errors', async () => {
    await expect(registerPack({
      packId: '',
      version: '1.0.0',
      verticalType: 'hvac',
      displayName: 'Test',
    }, registry)).rejects.toMatchObject({
      name: 'ValidationError',
      message: 'Invalid pack input',
      details: { errors: ['packId is required'] },
    } satisfies Partial<ValidationError>);
  });

  it('validation — rejects invalid verticalType', () => {
    const errors = validatePackInput({
      packId: 'test',
      version: '1.0.0',
      verticalType: 'electrical' as any,
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
});
