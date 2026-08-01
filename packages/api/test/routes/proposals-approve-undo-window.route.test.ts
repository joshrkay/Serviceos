/**
 * Finding 2 — the approve endpoint response must carry `approvedAt` and a
 * derived `undoExpiresAt` (= approvedAt + UNDO_WINDOW_MS) so the client can
 * drive its undo countdown from the SERVER's real window instead of a fresh
 * client 5s that ignores the round-trip latency already spent.
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
import { UNDO_WINDOW_MS } from '../../src/proposals/lifecycle';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import type { AuthenticatedRequest } from '../../src/auth/clerk';
import type { Role } from '../../src/auth/rbac';

const TEST_TENANT_ID = 'tenant-undo-window';
const TEST_USER_ID = 'user-undo-window';

const baseInput: CreateProposalInput = {
  tenantId: TEST_TENANT_ID,
  proposalType: 'create_customer',
  payload: { name: 'Jane' },
  summary: 'Create customer',
  createdBy: TEST_USER_ID,
};

function buildApp(role: Role = 'owner'): {
  app: Express;
  proposalRepo: InMemoryProposalRepository;
} {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as AuthenticatedRequest).auth = {
      userId: TEST_USER_ID,
      sessionId: 'sess-undo',
      tenantId: TEST_TENANT_ID,
      role,
    };
    next();
  });
  const proposalRepo = new InMemoryProposalRepository();
  const audit = new InMemoryAuditRepository();
  app.use('/api/proposals', createProposalsRouter(proposalRepo, undefined, audit));
  return { app, proposalRepo };
}

async function seedReady(repo: InMemoryProposalRepository): Promise<string> {
  const p = createProposal(baseInput);
  await repo.create(p);
  await repo.updateStatus(TEST_TENANT_ID, p.id, 'ready_for_review');
  return p.id;
}

describe('Finding 2 — POST /api/proposals/:id/approve undo-window response', () => {
  it('carries approvedAt and undoExpiresAt (ISO), with undoExpiresAt = approvedAt + UNDO_WINDOW_MS', async () => {
    const { app, proposalRepo } = buildApp();
    const id = await seedReady(proposalRepo);

    const res = await request(app).post(`/api/proposals/${id}/approve`).send();

    expect(res.status).toBe(200);
    // Existing fields are preserved.
    expect(res.body.id).toBe(id);
    expect(res.body.status).toBe('approved');
    // Both timing fields are present as ISO strings.
    expect(typeof res.body.approvedAt).toBe('string');
    expect(typeof res.body.undoExpiresAt).toBe('string');

    const approvedMs = Date.parse(res.body.approvedAt);
    const expiresMs = Date.parse(res.body.undoExpiresAt);
    expect(Number.isNaN(approvedMs)).toBe(false);
    expect(Number.isNaN(expiresMs)).toBe(false);
    // The window is exactly UNDO_WINDOW_MS after approval.
    expect(expiresMs - approvedMs).toBe(UNDO_WINDOW_MS);
  });

  it('keeps tenant isolation — a foreign tenant cannot approve and get a window', async () => {
    const { app, proposalRepo } = buildApp();
    // Seed under a DIFFERENT tenant than the request auth.
    const foreign = createProposal({ ...baseInput, tenantId: 'other-tenant' });
    await proposalRepo.create(foreign);
    await proposalRepo.updateStatus('other-tenant', foreign.id, 'ready_for_review');

    const res = await request(app).post(`/api/proposals/${foreign.id}/approve`).send();

    // Not found for this tenant — never leaks an approval/undo window.
    expect(res.status).toBe(404);
    expect(res.body.undoExpiresAt).toBeUndefined();
  });
});
