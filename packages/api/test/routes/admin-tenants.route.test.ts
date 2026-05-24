import request from 'supertest';
import { describe, it, expect, vi } from 'vitest';
import express, { Request, Response, NextFunction } from 'express';
import type { Express } from 'express';
import { createAdminTenantsRouter } from '../../src/routes/admin-tenants';
import { AuthenticatedRequest } from '../../src/auth/clerk';
import {
  InMemoryPlatformAdminChecker,
  requirePlatformAdmin,
} from '../../src/auth/platform-admin';
import { DEPROVISION_TENANT_JOB_TYPE } from '../../src/workers/deprovision-tenant';

const TENANT = '00000000-0000-0000-0000-000000000001';
const TARGET = '11111111-1111-1111-1111-111111111111';

function buildApp(opts: { platformAdmins?: string[]; tenantExists?: boolean } = {}): {
  app: Express;
  send: ReturnType<typeof vi.fn>;
} {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as AuthenticatedRequest).auth = {
      userId: 'user-1',
      sessionId: 's',
      tenantId: TENANT,
      role: 'owner',
    };
    next();
  });

  const pool = {
    query: vi.fn(async () => ({
      rowCount: opts.tenantExists === false ? 0 : 1,
      rows: opts.tenantExists === false ? [] : [{ id: TARGET }],
    })),
  };
  const send = vi.fn(async () => 'job-123');
  const queue = { send } as never;
  const checker = new InMemoryPlatformAdminChecker(opts.platformAdmins ?? []);

  app.use(
    '/api/admin/tenants',
    createAdminTenantsRouter({
      pool: pool as never,
      queue,
      requirePlatformAdmin: requirePlatformAdmin(checker),
    }),
  );
  return { app, send };
}

describe('POST /api/admin/tenants/:tenantId/deprovision', () => {
  it('rejects a non-platform-admin with 403', async () => {
    const { app, send } = buildApp({ platformAdmins: [] });
    const res = await request(app)
      .post(`/api/admin/tenants/${TARGET}/deprovision`)
      .send({ confirm: true });
    expect(res.status).toBe(403);
    expect(send).not.toHaveBeenCalled();
  });

  it('requires confirm:true', async () => {
    const { app, send } = buildApp({ platformAdmins: ['user-1'] });
    const res = await request(app)
      .post(`/api/admin/tenants/${TARGET}/deprovision`)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('CONFIRMATION_REQUIRED');
    expect(send).not.toHaveBeenCalled();
  });

  it('400 on a non-UUID tenant id', async () => {
    const { app } = buildApp({ platformAdmins: ['user-1'] });
    const res = await request(app)
      .post('/api/admin/tenants/not-a-uuid/deprovision')
      .send({ confirm: true });
    expect(res.status).toBe(400);
  });

  it('404 when the tenant does not exist', async () => {
    const { app, send } = buildApp({ platformAdmins: ['user-1'], tenantExists: false });
    const res = await request(app)
      .post(`/api/admin/tenants/${TARGET}/deprovision`)
      .send({ confirm: true });
    expect(res.status).toBe(404);
    expect(send).not.toHaveBeenCalled();
  });

  it('enqueues the deprovision job and returns 202', async () => {
    const { app, send } = buildApp({ platformAdmins: ['user-1'] });
    const res = await request(app)
      .post(`/api/admin/tenants/${TARGET}/deprovision`)
      .send({ confirm: true, reason: 'manual_admin' });
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ enqueued: true, tenantId: TARGET, jobId: 'job-123' });
    expect(send).toHaveBeenCalledWith(
      DEPROVISION_TENANT_JOB_TYPE,
      expect.objectContaining({ tenantId: TARGET, actorId: 'user-1', reason: 'manual_admin' }),
      `deprovision-${TARGET}`,
    );
  });
});
