import {
  InMemorySettingsRepository,
  createSettings,
  updateSettings,
  getSettings,
  validateSettingsInput,
  validateUpdateSettingsInput,
} from '../../src/settings/settings';
import express, { Request, Response, NextFunction } from 'express';
import request from 'supertest';
import { createSettingsRouter } from '../../src/routes/settings';
import { AuthenticatedRequest } from '../../src/auth/clerk';
import { InMemoryPackActivationRepository, activatePack } from '../../src/settings/pack-activation';
import {
  InMemoryVerticalPackRegistry,
  registerPack,
  activatePackStatus,
} from '../../src/shared/vertical-pack-registry';

describe('P4-010A — Active vertical settings in tenant config', () => {
  let repo: InMemorySettingsRepository;

  beforeEach(() => {
    repo = new InMemorySettingsRepository();
  });

  it('happy path — creates settings with active vertical packs', async () => {
    const settings = await createSettings({
      tenantId: 't1',
      businessName: 'HVAC Pro',
      activeVerticalPacks: ['hvac-v1'],
    }, repo);

    expect(settings.activeVerticalPacks).toEqual(['hvac-v1']);
  });

  it('happy path — updates active packs', async () => {
    await createSettings({
      tenantId: 't1',
      businessName: 'Service Co',
    }, repo);

    const updated = await updateSettings('t1', {
      activeVerticalPacks: ['hvac-v1', 'plumbing-v1'],
    }, repo);

    expect(updated).not.toBeNull();
    expect(updated!.activeVerticalPacks).toEqual(['hvac-v1', 'plumbing-v1']);
  });

  it('happy path — retrieves settings with packs', async () => {
    await createSettings({
      tenantId: 't1',
      businessName: 'Service Co',
      activeVerticalPacks: ['plumbing-v1'],
    }, repo);

    const settings = await getSettings('t1', repo);
    expect(settings).not.toBeNull();
    expect(settings!.activeVerticalPacks).toEqual(['plumbing-v1']);
  });

  it('happy path — settings without packs default to undefined', async () => {
    await createSettings({
      tenantId: 't1',
      businessName: 'Service Co',
    }, repo);

    const settings = await getSettings('t1', repo);
    expect(settings!.activeVerticalPacks).toBeUndefined();
  });

  it('validation — can clear active packs', async () => {
    await createSettings({
      tenantId: 't1',
      businessName: 'Service Co',
      activeVerticalPacks: ['hvac-v1'],
    }, repo);

    const updated = await updateSettings('t1', {
      activeVerticalPacks: [],
    }, repo);

    expect(updated!.activeVerticalPacks).toEqual([]);
  });

  it('validation — rejects empty or whitespace-only pack IDs', () => {
    const errors = validateSettingsInput({
      tenantId: 't1',
      businessName: 'Service Co',
      activeVerticalPacks: ['hvac-v1', '   '],
    });

    expect(errors).toContain('activeVerticalPacks[1] must be a non-empty string');
  });

  it('validation — rejects duplicate pack IDs after normalization', () => {
    const errors = validateUpdateSettingsInput({
      activeVerticalPacks: [' HVAC-v1 ', 'hvac-v1'],
    });

    expect(errors).toContain('activeVerticalPacks contains duplicate pack ID: hvac-v1');
  });

  it('validation — accepts multi-pack configuration and normalizes IDs', async () => {
    await createSettings({
      tenantId: 't1',
      businessName: 'Service Co',
    }, repo);

    const updated = await updateSettings('t1', {
      activeVerticalPacks: [' HVAC-v1 ', 'Plumbing-V1'],
    }, repo);

    expect(updated!.activeVerticalPacks).toEqual(['hvac-v1', 'plumbing-v1']);
  });

  it('validation — updateSettings rejects invalid packs before persisting', async () => {
    await createSettings({
      tenantId: 't1',
      businessName: 'Service Co',
      activeVerticalPacks: ['hvac-v1'],
    }, repo);

    await expect(
      updateSettings('t1', {
        activeVerticalPacks: ['hvac-v1', ' HVAC-v1 '],
      }, repo)
    ).rejects.toThrow('activeVerticalPacks contains duplicate pack ID: hvac-v1');

    const settings = await getSettings('t1', repo);
    expect(settings!.activeVerticalPacks).toEqual(['hvac-v1']);
  });

  it('validation — supports constraining pack IDs to known values', () => {
    const errors = validateUpdateSettingsInput(
      { activeVerticalPacks: ['hvac-v1', 'electrical-v1'] },
      { knownPackIds: ['hvac-v1', 'plumbing-v1'] }
    );

    expect(errors).toContain('activeVerticalPacks contains unknown pack ID: electrical-v1');
  });
});

describe('P4-010A — Settings route validation for terminology preferences', () => {
  const tenantId = 'tenant-route-test';
  let app: express.Express;
  let settingsRepo: InMemorySettingsRepository;
  let activationRepo: InMemoryPackActivationRepository;
  let registry: InMemoryVerticalPackRegistry;

  beforeEach(async () => {
    app = express();
    app.use(express.json());

    app.use((req: Request, _res: Response, next: NextFunction) => {
      (req as AuthenticatedRequest).auth = {
        userId: 'user-1',
        sessionId: 'session-1',
        tenantId,
        role: 'owner',
      };
      next();
    });

    settingsRepo = new InMemorySettingsRepository();
    activationRepo = new InMemoryPackActivationRepository();
    registry = new InMemoryVerticalPackRegistry();

    await createSettings({
      tenantId,
      businessName: 'Route Test Co',
    }, settingsRepo);

    const hvacPack = await registerPack({
      packId: 'hvac-v1',
      version: '1.0.0',
      verticalType: 'hvac',
      displayName: 'HVAC Pack',
    }, registry);
    await activatePackStatus(hvacPack.id, registry);
    await activatePack({ tenantId, packId: hvacPack.packId }, activationRepo);

    app.use('/api/settings', createSettingsRouter(settingsRepo, {
      activationRepo,
      verticalPackRegistry: registry,
    }));
  });

  it('accepts valid terminology preference updates', async () => {
    const res = await request(app)
      .put('/api/settings')
      .send({
        terminologyPreferences: {
          furnace: 'Heating System',
          thermostat: 'Temperature Controller',
        },
      });

    expect(res.status).toBe(200);
    expect(res.body.terminologyPreferences).toEqual({
      furnace: 'Heating System',
      thermostat: 'Temperature Controller',
    });
  });

  it('rejects unknown terminology keys with VALIDATION_ERROR', async () => {
    const res = await request(app)
      .put('/api/settings')
      .send({
        terminologyPreferences: {
          notARealTerm: 'Custom Label',
        },
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION_ERROR');
    expect(res.body.details.field).toBe('terminologyPreferences');
    expect(res.body.details.errors).toContain(
      'terminologyPreferences key "notARealTerm" is not a recognized term for the active vertical'
    );
  });

  it('rejects empty terminology values with VALIDATION_ERROR', async () => {
    const res = await request(app)
      .put('/api/settings')
      .send({
        terminologyPreferences: {
          furnace: '   ',
        },
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION_ERROR');
    expect(res.body.details.field).toBe('terminologyPreferences');
    expect(res.body.details.errors).toContain(
      'terminologyPreferences value for "furnace" must be a non-empty string'
    );
  });
});
