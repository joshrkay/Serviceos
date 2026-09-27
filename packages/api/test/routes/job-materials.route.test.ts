/**
 * #1406 D3 — GET/PUT /api/jobs/:id/materials (the job-detail Parts sheet).
 *
 * Seam: createJobMaterialsRouter over in-memory repos (the real-Postgres leg
 * is test/integration/job-materials.test.ts).
 */
import express, { Request, Response, NextFunction, type Express } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { AuthenticatedRequest } from '../../src/auth/clerk';
import type { Job, JobRepository } from '../../src/jobs/job';
import { InMemoryMaterialItemRepository } from '../../src/materials/material-item';
import { createJobMaterialsRouter } from '../../src/routes/job-materials';

const TENANT = 'tenant-job-materials';
const JOB_ID = '5b0c8a36-8d0e-4f5e-9d7f-3f1d2a0c9b11';
const UNKNOWN_JOB_ID = '5b0c8a36-8d0e-4f5e-9d7f-3f1d2a0c9b99';

const jobRepo: Pick<JobRepository, 'findById'> = {
  findById: async (_tenantId, id) => (id === JOB_ID ? ({ id } as Job) : null),
};

function buildApp(role = 'owner'): { app: Express; audit: InMemoryAuditRepository } {
  const audit = new InMemoryAuditRepository();
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as AuthenticatedRequest).auth = {
      userId: 'user-1',
      sessionId: 'session-1',
      tenantId: TENANT,
      role,
    } as AuthenticatedRequest['auth'];
    next();
  });
  app.use(
    '/api/jobs',
    createJobMaterialsRouter({
      materialItemRepo: new InMemoryMaterialItemRepository(),
      auditRepo: audit,
      jobRepo,
    }),
  );
  return { app, audit };
}

describe('job materials routes (#1406 D3)', () => {
  let app: Express;
  let audit: InMemoryAuditRepository;

  beforeEach(() => {
    ({ app, audit } = buildApp());
  });

  it('PUT saves the sheet and GET reads it back in cents', async () => {
    const put = await request(app)
      .put(`/api/jobs/${JOB_ID}/materials`)
      .send({
        items: [
          { name: 'Contactor 40A 24V Coil', partNumber: 'CONT-2P-40A', quantity: 2, unitCostCents: 2200, category: 'Part' },
        ],
      });
    expect(put.status).toBe(200);

    const get = await request(app).get(`/api/jobs/${JOB_ID}/materials`);
    expect(get.status).toBe(200);
    expect(get.body.data).toEqual([
      expect.objectContaining({
        name: 'Contactor 40A 24V Coil',
        partNumber: 'CONT-2P-40A',
        quantity: 2,
        unitCostCents: 2200,
        category: 'Part',
      }),
    ]);
    expect(audit.getAll().map((e) => e.eventType)).toEqual(['material_item.created']);
  });

  it('an unknown job 404s and writes nothing', async () => {
    const put = await request(app)
      .put(`/api/jobs/${UNKNOWN_JOB_ID}/materials`)
      .send({ items: [{ name: 'Filter', quantity: 1 }] });
    expect(put.status).toBe(404);
    expect(audit.getAll()).toEqual([]);
  });

  it('rejects a fractional-dollar cost (money is integer cents)', async () => {
    const put = await request(app)
      .put(`/api/jobs/${JOB_ID}/materials`)
      .send({ items: [{ name: 'Filter', quantity: 1, unitCostCents: 9.5 }] });
    expect(put.status).toBe(400);
  });
});
