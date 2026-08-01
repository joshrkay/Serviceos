/**
 * Handler-level — the pack-activation route keeps the tenant_settings
 * `_activeVerticalPacks` mirror in sync with the authoritative
 * pack_activations table on every activate/deactivate.
 *
 * Uses in-memory repos (fast, no DB); the DB-level sync + the 236 backfill
 * are pinned separately in test/integration/pack-activation-mirror-sync.test.ts.
 */
import express, { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { randomUUID } from 'crypto';
import { beforeEach, describe, expect, it } from 'vitest';

import { AuthenticatedRequest } from '../../src/auth/clerk';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { InMemoryPackActivationRepository } from '../../src/settings/pack-activation';
import { InMemorySettingsRepository, TenantSettings } from '../../src/settings/settings';
import { InMemoryVerticalPackRegistry, registerPack } from '../../src/shared/vertical-pack-registry';
import { createPackActivationRouter } from '../../src/routes/pack-activation';

async function makeHarness() {
  const tenantId = randomUUID();
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as AuthenticatedRequest).auth = {
      userId: 'user-sync-1',
      sessionId: 'session-sync-1',
      tenantId,
      role: 'owner',
    };
    next();
  });

  const auditRepo = new InMemoryAuditRepository();
  const packActivationRepo = new InMemoryPackActivationRepository();
  const settingsRepo = new InMemorySettingsRepository();
  const verticalPackRegistry = new InMemoryVerticalPackRegistry();

  const now = new Date();
  const seed: TenantSettings = {
    id: randomUUID(),
    tenantId,
    businessName: 'Sync Co',
    timezone: 'America/New_York',
    estimatePrefix: 'EST-',
    invoicePrefix: 'INV-',
    nextEstimateNumber: 1001,
    nextInvoiceNumber: 1001,
    defaultPaymentTermDays: 30,
    createdAt: now,
    updatedAt: now,
  };
  await settingsRepo.create(seed);

  for (const packId of ['hvac', 'plumbing']) {
    await registerPack(
      { packId, version: '1.0.0', verticalType: packId, status: 'active', displayName: packId },
      verticalPackRegistry,
    );
  }

  app.use(
    '/api/settings/packs',
    createPackActivationRouter(packActivationRepo, verticalPackRegistry, auditRepo, settingsRepo),
  );

  return { app, tenantId, settingsRepo };
}

async function mirror(settingsRepo: InMemorySettingsRepository, tenantId: string): Promise<string[]> {
  const s = await settingsRepo.findByTenant(tenantId);
  return s?.activeVerticalPacks ?? [];
}

describe('pack-activation route — settings mirror stays in sync', () => {
  let harness: Awaited<ReturnType<typeof makeHarness>>;

  beforeEach(async () => {
    harness = await makeHarness();
  });

  it('PUT /:packId/activate mirrors the pack into tenant_settings', async () => {
    await request(harness.app).put('/api/settings/packs/hvac/activate').expect(201);
    expect(await mirror(harness.settingsRepo, harness.tenantId)).toEqual(['hvac']);

    await request(harness.app).put('/api/settings/packs/plumbing/activate').expect(201);
    expect([...(await mirror(harness.settingsRepo, harness.tenantId))].sort()).toEqual([
      'hvac',
      'plumbing',
    ]);
  });

  it('DELETE /:packId drops the pack from the mirror', async () => {
    await request(harness.app).put('/api/settings/packs/hvac/activate').expect(201);
    await request(harness.app).put('/api/settings/packs/plumbing/activate').expect(201);

    await request(harness.app).delete('/api/settings/packs/hvac').expect(200);
    expect(await mirror(harness.settingsRepo, harness.tenantId)).toEqual(['plumbing']);

    await request(harness.app).delete('/api/settings/packs/plumbing').expect(200);
    expect(await mirror(harness.settingsRepo, harness.tenantId)).toEqual([]);
  });
});
