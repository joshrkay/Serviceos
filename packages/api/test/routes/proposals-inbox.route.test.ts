import { describe, it, expect } from 'vitest';
import express, { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { AuthenticatedRequest } from '../../src/auth/clerk';
import { createProposalsRouter } from '../../src/routes/proposals';
import { InMemoryProposalRepository, createProposal } from '../../src/proposals/proposal';

function buildApp() {
  const proposalRepo = new InMemoryProposalRepository();
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as AuthenticatedRequest).auth = {
      userId: 'user-i1',
      sessionId: 'session-i1',
      tenantId: 'tenant-i1',
      role: 'owner',
    };
    next();
  });
  app.use('/api/proposals', createProposalsRouter(proposalRepo));
  return { app, proposalRepo };
}

describe('GET /api/proposals/inbox', () => {
  it('returns ready_for_review proposals sorted by urgency under data + summary', async () => {
    const { app, proposalRepo } = buildApp();
    const soon = new Date(Date.now() + 30 * 60 * 1000);
    const critical = createProposal({
      tenantId: 'tenant-i1',
      proposalType: 'draft_invoice',
      payload: {},
      summary: 'Critical — expires soon',
      createdBy: 'user-i1',
      expiresAt: soon,
    });
    const normal = createProposal({
      tenantId: 'tenant-i1',
      proposalType: 'draft_invoice',
      payload: {},
      summary: 'Normal',
      createdBy: 'user-i1',
    });
    await proposalRepo.create({ ...critical, status: 'ready_for_review' });
    await proposalRepo.create({ ...normal, status: 'ready_for_review' });

    const res = await request(app).get('/api/proposals/inbox');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.data[0].proposal.summary).toMatch(/critical/i);
    expect(res.body.data[0].urgency).toBe('critical');
    expect(res.body.summary).toMatchObject({
      totalCount: 2,
      criticalCount: 1,
      normalCount: 1,
      truncated: false,
    });
  });

  it('surfaces draft proposals (voice proposals are created in draft)', async () => {
    const { app, proposalRepo } = buildApp();
    const draft = createProposal({
      tenantId: 'tenant-i1',
      proposalType: 'add_note',
      payload: {},
      summary: 'Draft — awaiting operator approval',
      createdBy: 'user-i1',
    });
    await proposalRepo.create(draft);
    const res = await request(app).get('/api/proposals/inbox');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].proposal.summary).toBe('Draft — awaiting operator approval');
  });

  it('excludes proposals in terminal/closed statuses', async () => {
    const { app, proposalRepo } = buildApp();
    const executed = createProposal({
      tenantId: 'tenant-i1',
      proposalType: 'add_note',
      payload: {},
      summary: 'Already executed — should not surface',
      createdBy: 'user-i1',
    });
    await proposalRepo.create({ ...executed, status: 'executed' });
    const res = await request(app).get('/api/proposals/inbox');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(0);
  });

  it('does not leak proposals from other tenants', async () => {
    const { app, proposalRepo } = buildApp();
    const otherTenant = createProposal({
      tenantId: 'tenant-other',
      proposalType: 'add_note',
      payload: {},
      summary: 'From another tenant',
      createdBy: 'user-x',
    });
    await proposalRepo.create({ ...otherTenant, status: 'ready_for_review' });
    const res = await request(app).get('/api/proposals/inbox');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(0);
  });
});
