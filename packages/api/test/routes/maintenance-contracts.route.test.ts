import { describe, it, expect, beforeEach } from 'vitest';
import express, { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { AuthenticatedRequest } from '../../src/auth/clerk';
import { createMaintenanceContractsRouter } from '../../src/routes/maintenance-contracts';
import { InMemoryMaintenanceContractRepository } from '../../src/maintenance-contracts/maintenance-contract';
import { InMemoryAuditRepository } from '../../src/audit/audit';

function buildApp() {
  const repo = new InMemoryMaintenanceContractRepository();
  const auditRepo = new InMemoryAuditRepository();
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as AuthenticatedRequest).auth = {
      userId: 'user-1',
      sessionId: 'sess-1',
      tenantId: 'tenant-1',
      role: 'owner',
    };
    next();
  });
  app.use('/api/maintenance-contracts', createMaintenanceContractsRouter(repo, auditRepo));
  return { app, repo, auditRepo };
}

describe('Maintenance contracts router (persisted)', () => {
  let h: ReturnType<typeof buildApp>;
  beforeEach(() => {
    h = buildApp();
  });

  it('lists empty initially', async () => {
    const res = await request(h.app).get('/api/maintenance-contracts');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: [], total: 0 });
  });

  it('creates a contract, persists it, and reads it back by id', async () => {
    const create = await request(h.app)
      .post('/api/maintenance-contracts')
      .send({ title: 'Quarterly HVAC', customer: 'Acme Co', location: '123 Main St', cadence: 'quarterly' });
    expect(create.status).toBe(201);
    expect(create.body).toMatchObject({
      title: 'Quarterly HVAC',
      status: 'active',
      customer: { displayName: 'Acme Co' },
      location: { street1: '123 Main St' },
      cadence: 'quarterly',
    });
    const id = create.body.id as string;

    // Persisted (a SEPARATE request reads it back — not just in-request state).
    const list = await request(h.app).get('/api/maintenance-contracts');
    expect(list.body.total).toBe(1);
    expect(list.body.data[0].id).toBe(id);

    const byId = await request(h.app).get(`/api/maintenance-contracts/${id}`);
    expect(byId.status).toBe(200);
    expect(byId.body.title).toBe('Quarterly HVAC');
  });

  it('emits an audit event on create', async () => {
    await request(h.app).post('/api/maintenance-contracts').send({ title: 'Plan A' });
    const events = h.auditRepo.getAll();
    expect(events.some((e) => e.eventType === 'maintenance_contract.created')).toBe(true);
  });

  it('rejects a missing title with 400', async () => {
    const res = await request(h.app).post('/api/maintenance-contracts').send({ title: '  ' });
    expect(res.status).toBe(400);
  });

  it('404s an unknown contract', async () => {
    const res = await request(h.app).get('/api/maintenance-contracts/nope');
    expect(res.status).toBe(404);
  });
});
