import express, { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import type { AuthenticatedRequest } from '../../src/auth/clerk';
import {
  InMemoryPrivacyAuditRepository,
  InMemoryTrainingAssetRepository,
} from '../../src/verticals/in-memory-training-assets';
import { TrainingAssetRedactionService } from '../../src/verticals/training-asset-redaction';
import { TrainingAssetService } from '../../src/verticals/training-asset-service';
import { createVerticalTrainingAssetsRouter } from '../../src/routes/vertical-training-assets';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as AuthenticatedRequest).auth = {
      tenantId: 'tenant-1',
      userId: 'user-1',
      sessionId: 'session-1',
      role: 'owner',
    };
    next();
  });

  const service = new TrainingAssetService({
    assetRepo: new InMemoryTrainingAssetRepository(),
    privacyAuditRepo: new InMemoryPrivacyAuditRepository(),
    redaction: new TrainingAssetRedactionService(),
    idGenerator: (() => {
      let n = 0;
      return () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
    })(),
    now: () => new Date('2026-05-15T00:00:00Z'),
  });

  app.use('/api/vertical-training-assets', createVerticalTrainingAssetsRouter(service));
  return app;
}

describe('vertical training assets routes', () => {
  it('creates a redacted training asset', async () => {
    const app = buildApp();

    const res = await request(app)
      .post('/api/vertical-training-assets')
      .send({
        verticalType: 'hvac',
        assetKind: 'labeled_call_example',
        title: 'No heat call',
        rawText: 'Sarah Jones at 415-555-0123 has no heat.',
        labels: { intent: 'emergency_dispatch', shouldEscalate: true },
        provenance: { source: 'tenant_admin', sourceVersion: '1' },
        knownEntities: { names: ['Sarah Jones'] },
      })
      .expect(201);

    expect(res.body.status).toBe('redacted');
    expect(res.body.scrubbedText).toContain('[CALLER_NAME]');
    expect(res.body.rawText).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toContain('Sarah Jones');
    expect(JSON.stringify(res.body)).not.toContain('415-555-0123');
  });

  it('lists assets without raw text', async () => {
    const app = buildApp();

    await request(app)
      .post('/api/vertical-training-assets')
      .send({
        verticalType: 'hvac',
        assetKind: 'prompt_context',
        title: 'Membership prompt',
        rawText: 'Tell Mary Smith at mary@example.com about maintenance plans.',
        labels: {},
        provenance: { source: 'tenant_admin', sourceVersion: '1' },
        knownEntities: { names: ['Mary Smith'], emails: ['mary@example.com'] },
      })
      .expect(201);

    const res = await request(app).get('/api/vertical-training-assets').expect(200);

    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].rawText).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toContain('Mary Smith');
    expect(JSON.stringify(res.body)).not.toContain('mary@example.com');
  });

  it('approves and activates an asset', async () => {
    const app = buildApp();
    const created = await request(app)
      .post('/api/vertical-training-assets')
      .send({
        verticalType: 'plumbing',
        assetKind: 'rag_seed',
        title: 'Shutoff guidance',
        rawText: 'Ask whether the water is shut off.',
        labels: {},
        provenance: { source: 'tenant_admin', sourceVersion: '1' },
      })
      .expect(201);

    await request(app)
      .post(`/api/vertical-training-assets/${created.body.id}/approve`)
      .send({})
      .expect(200);
    const activated = await request(app)
      .post(`/api/vertical-training-assets/${created.body.id}/activate`)
      .send({})
      .expect(200);

    expect(activated.body.status).toBe('active');
  });
});
