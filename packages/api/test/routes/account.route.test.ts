import request from 'supertest';
import { describe, it, expect, vi } from 'vitest';
import express, { Request, Response, NextFunction } from 'express';
import type { Express } from 'express';
import { createAccountRouter } from '../../src/routes/account';
import { AuthenticatedRequest } from '../../src/auth/clerk';
import { DEPROVISION_TENANT_JOB_TYPE } from '../../src/workers/deprovision-tenant';

const TENANT = '00000000-0000-0000-0000-000000000001';

function buildApp(
  opts: { role?: string; tenantExists?: boolean; tenantId?: string } = {},
): { app: Express; send: ReturnType<typeof vi.fn> } {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as AuthenticatedRequest).auth = {
      userId: 'owner-1',
      sessionId: 's',
      tenantId: opts.tenantId !== undefined ? opts.tenantId : TENANT,
      role: opts.role ?? 'owner',
    };
    next();
  });

  const pool = {
    query: vi.fn(async () => ({
      rowCount: opts.tenantExists === false ? 0 : 1,
      rows: opts.tenantExists === false ? [] : [{ id: TENANT }],
    })),
  };
  const send = vi.fn(async () => 'job-abc');
  const queue = { send } as never;

  app.use('/api/account', createAccountRouter({ pool: pool as never, queue }));
  return { app, send };
}

describe('POST /api/account/delete', () => {
  it('enqueues the deprovision job for the caller’s own tenant and returns 202', async () => {
    const { app, send } = buildApp();
    const res = await request(app).post('/api/account/delete').send({ confirm: true });
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ enqueued: true, jobId: 'job-abc' });
    expect(send).toHaveBeenCalledWith(
      DEPROVISION_TENANT_JOB_TYPE,
      expect.objectContaining({ tenantId: TENANT, actorId: 'owner-1', reason: 'owner_self_serve' }),
      `deprovision-${TENANT}`,
    );
  });

  it('requires confirm:true', async () => {
    const { app, send } = buildApp();
    const res = await request(app).post('/api/account/delete').send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('CONFIRMATION_REQUIRED');
    expect(send).not.toHaveBeenCalled();
  });

  it('rejects a non-owner with 403 and never enqueues', async () => {
    const { app, send } = buildApp({ role: 'technician' });
    const res = await request(app).post('/api/account/delete').send({ confirm: true });
    expect(res.status).toBe(403);
    expect(send).not.toHaveBeenCalled();
  });

  it('rejects a request with no tenant context with 403', async () => {
    const { app, send } = buildApp({ tenantId: '' });
    const res = await request(app).post('/api/account/delete').send({ confirm: true });
    expect(res.status).toBe(403);
    expect(send).not.toHaveBeenCalled();
  });

  it('returns 202 alreadyDeleted (no job) when the tenant is already gone', async () => {
    const { app, send } = buildApp({ tenantExists: false });
    const res = await request(app).post('/api/account/delete').send({ confirm: true });
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ enqueued: false, alreadyDeleted: true });
    expect(send).not.toHaveBeenCalled();
  });

  it('cannot delete a different tenant — the target is always req.auth.tenantId', async () => {
    const { app, send } = buildApp();
    // Even if a caller smuggles a tenantId in the body, the route ignores it.
    await request(app)
      .post('/api/account/delete')
      .send({ confirm: true, tenantId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' });
    expect(send).toHaveBeenCalledWith(
      DEPROVISION_TENANT_JOB_TYPE,
      expect.objectContaining({ tenantId: TENANT }),
      `deprovision-${TENANT}`,
    );
  });
});
