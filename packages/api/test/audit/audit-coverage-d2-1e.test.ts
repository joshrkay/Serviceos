/**
 * D2-1e — Audit-coverage smoke test for the two remaining route files
 * surfaced by the D2-1 Phase 1 audit:
 *
 *   - PUT /api/pack-activation/:packId/activate   → pack_activation.activated
 *   - POST /api/maintenance-contracts             → maintenance_contract.created
 *
 * Builds a minimal Express app with both routers, a fake-auth middleware,
 * and an InMemoryAuditRepository we can inspect directly. We don't reach
 * for createApp() here because we need the audit repo handle to assert on.
 */
import express, { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { randomUUID } from 'crypto';
import { beforeEach, describe, expect, it } from 'vitest';

import { AuthenticatedRequest } from '../../src/auth/clerk';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { InMemoryPackActivationRepository } from '../../src/settings/pack-activation';
import { InMemorySettingsRepository } from '../../src/settings/settings';
import {
  InMemoryVerticalPackRegistry,
  registerPack,
} from '../../src/shared/vertical-pack-registry';
import { createPackActivationRouter } from '../../src/routes/pack-activation';
import { createMaintenanceContractsRouter } from '../../src/routes/maintenance-contracts';
import { InMemoryMaintenanceContractRepository } from '../../src/maintenance-contracts/maintenance-contract';

interface Harness {
  app: express.Express;
  auditRepo: InMemoryAuditRepository;
  tenantId: string;
}

async function buildHarness(): Promise<Harness> {
  // Unique tenant per test isolates us from the module-level Map in
  // maintenance-contracts.ts (it persists across tests within a worker).
  const tenantId = `tenant-d21e-${randomUUID()}`;

  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as AuthenticatedRequest).auth = {
      userId: 'user-d21e-1',
      sessionId: 'session-d21e-1',
      tenantId,
      role: 'owner',
    };
    next();
  });

  const auditRepo = new InMemoryAuditRepository();
  const packActivationRepo = new InMemoryPackActivationRepository();
  const verticalPackRegistry = new InMemoryVerticalPackRegistry();

  // Seed a canonical pack so PUT /:packId/activate clears the
  // "Active pack not found" 404 guard.
  await registerPack(
    {
      packId: 'hvac-v1',
      version: '1.0.0',
      verticalType: 'hvac',
      status: 'active',
      displayName: 'HVAC',
    },
    verticalPackRegistry
  );

  app.use(
    '/api/pack-activation',
    createPackActivationRouter(packActivationRepo, verticalPackRegistry, auditRepo, new InMemorySettingsRepository())
  );
  app.use(
    '/api/maintenance-contracts',
    createMaintenanceContractsRouter(new InMemoryMaintenanceContractRepository(), auditRepo)
  );

  return { app, auditRepo, tenantId };
}

describe('D2-1e — audit coverage for pack-activation + maintenance-contracts', () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await buildHarness();
  });

  it('PUT /api/pack-activation/:packId/activate writes pack_activation.activated', async () => {
    const res = await request(harness.app)
      .put('/api/pack-activation/hvac-v1/activate')
      .send();

    expect(res.status).toBe(201);
    expect(res.body.packId).toBe('hvac-v1');
    expect(res.body.status).toBe('active');

    const events = harness.auditRepo.getAll();
    const activated = events.filter((e) => e.eventType === 'pack_activation.activated');
    expect(activated).toHaveLength(1);
    expect(activated[0].tenantId).toBe(harness.tenantId);
    expect(activated[0].entityType).toBe('pack_activation');
    expect(activated[0].entityId).toBe(res.body.id);
    expect(activated[0].actorId).toBe('user-d21e-1');
    expect(activated[0].metadata).toMatchObject({ packId: 'hvac-v1' });
  });

  it('DELETE /api/pack-activation/:packId writes pack_activation.deactivated', async () => {
    await request(harness.app).put('/api/pack-activation/hvac-v1/activate').send();
    harness.auditRepo.clear();

    const res = await request(harness.app).delete('/api/pack-activation/hvac-v1').send();
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('deactivated');

    const deactivated = harness.auditRepo
      .getAll()
      .filter((e) => e.eventType === 'pack_activation.deactivated');
    expect(deactivated).toHaveLength(1);
    expect(deactivated[0].entityType).toBe('pack_activation');
    expect(deactivated[0].metadata).toMatchObject({ packId: 'hvac-v1' });
  });

  it('POST /api/maintenance-contracts writes maintenance_contract.created', async () => {
    const res = await request(harness.app)
      .post('/api/maintenance-contracts')
      .send({ title: 'Quarterly HVAC visits', cadence: 'quarterly' });

    expect(res.status).toBe(201);
    expect(res.body.title).toBe('Quarterly HVAC visits');

    const events = harness.auditRepo.getAll();
    const created = events.filter((e) => e.eventType === 'maintenance_contract.created');
    expect(created).toHaveLength(1);
    expect(created[0].tenantId).toBe(harness.tenantId);
    expect(created[0].entityType).toBe('maintenance_contract');
    expect(created[0].entityId).toBe(res.body.id);
    expect(created[0].actorId).toBe('user-d21e-1');
    expect(created[0].metadata).toMatchObject({
      title: 'Quarterly HVAC visits',
      cadence: 'quarterly',
    });
  });
});
