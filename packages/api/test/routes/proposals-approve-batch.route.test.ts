/**
 * P2-035 — HTTP route shape tests for POST /api/proposals/approve-batch.
 *
 * Covers Zod validation (empty array, over-50 cap, non-UUID), per-proposal
 * RBAC, partial-success response shape, and 403 for non-approver roles.
 */
import request from 'supertest';
import { describe, it, expect } from 'vitest';
import express, { type Express, type Request, type Response, type NextFunction } from 'express';
import { createProposalsRouter } from '../../src/routes/proposals';
import {
  createProposal,
  InMemoryProposalRepository,
  type CreateProposalInput,
} from '../../src/proposals/proposal';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import type { AuthenticatedRequest } from '../../src/auth/clerk';
import type { Role } from '../../src/auth/rbac';

const TEST_TENANT_ID = 'tenant-route-batch';
const TEST_USER_ID = 'user-route-batch';

const baseInput: CreateProposalInput = {
  tenantId: TEST_TENANT_ID,
  proposalType: 'create_customer',
  payload: { name: 'Jane' },
  summary: 'Create customer',
  createdBy: TEST_USER_ID,
};

function buildApp(role: Role): {
  app: Express;
  proposalRepo: InMemoryProposalRepository;
  audit: InMemoryAuditRepository;
} {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as AuthenticatedRequest).auth = {
      userId: TEST_USER_ID,
      sessionId: 'sess-batch',
      tenantId: TEST_TENANT_ID,
      role,
    };
    next();
  });
  const proposalRepo = new InMemoryProposalRepository();
  const audit = new InMemoryAuditRepository();
  app.use('/api/proposals', createProposalsRouter(proposalRepo, undefined, audit));
  return { app, proposalRepo, audit };
}

async function seedReady(repo: InMemoryProposalRepository, idx = 0): Promise<string> {
  const p = createProposal({ ...baseInput, summary: `P-${idx}` });
  await repo.create(p);
  await repo.updateStatus(TEST_TENANT_ID, p.id, 'ready_for_review');
  return p.id;
}

describe('P2-035 — POST /api/proposals/approve-batch', () => {
  it('happy path — 200 with {approved, failed} body', async () => {
    const { app, proposalRepo } = buildApp('owner');
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) ids.push(await seedReady(proposalRepo, i));

    const res = await request(app).post('/api/proposals/approve-batch').send({ proposalIds: ids });

    expect(res.status).toBe(200);
    expect(res.body.approved.sort()).toEqual([...ids].sort());
    expect(res.body.failed).toEqual([]);
  });

  it('returns 400 on empty array', async () => {
    const { app } = buildApp('owner');
    const res = await request(app).post('/api/proposals/approve-batch').send({ proposalIds: [] });
    expect(res.status).toBe(400);
  });

  it('returns 400 on more than 50 IDs', async () => {
    const { app } = buildApp('owner');
    const ids = Array.from({ length: 51 }, (_, i) =>
      `550e8400-e29b-41d4-a716-44665544${String(i).padStart(4, '0')}`,
    );
    const res = await request(app).post('/api/proposals/approve-batch').send({ proposalIds: ids });
    expect(res.status).toBe(400);
  });

  it('returns 400 on missing/non-array proposalIds', async () => {
    const { app } = buildApp('owner');
    const res = await request(app).post('/api/proposals/approve-batch').send({});
    expect(res.status).toBe(400);
  });

  it('returns 400 when an ID is not a UUID', async () => {
    const { app } = buildApp('owner');
    const res = await request(app)
      .post('/api/proposals/approve-batch')
      .send({ proposalIds: ['not-a-uuid'] });
    expect(res.status).toBe(400);
  });

  it('returns 403 when role lacks proposals:approve', async () => {
    const { app, proposalRepo } = buildApp('technician');
    const id = await seedReady(proposalRepo);
    const res = await request(app)
      .post('/api/proposals/approve-batch')
      .send({ proposalIds: [id] });
    expect(res.status).toBe(403);
  });

  it('partial — one wrong-status ID is reported as failed; others approved (200)', async () => {
    const { app, proposalRepo } = buildApp('owner');
    const ok = await seedReady(proposalRepo, 1);

    // draft (not ready_for_review)
    const draft = createProposal(baseInput);
    await proposalRepo.create(draft);

    const res = await request(app)
      .post('/api/proposals/approve-batch')
      .send({ proposalIds: [ok, draft.id] });

    expect(res.status).toBe(200);
    expect(res.body.approved).toEqual([ok]);
    expect(res.body.failed).toHaveLength(1);
    expect(res.body.failed[0].id).toBe(draft.id);
    expect(res.body.failed[0].reason).toBeTruthy();
  });
});
