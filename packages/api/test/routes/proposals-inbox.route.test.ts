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

  it('§5.5 — surfaces expired schedule cards under `expired`, excluding non-schedule expired', async () => {
    const { app, proposalRepo } = buildApp();
    const past = new Date(Date.now() - 60 * 60 * 1000);
    const lapsed = createProposal({
      tenantId: 'tenant-i1',
      proposalType: 'create_appointment',
      payload: {},
      summary: 'Lapsed booking',
      createdBy: 'user-i1',
      expiresAt: past,
    });
    await proposalRepo.create({ ...lapsed, status: 'expired' });
    // a non-schedule proposal that somehow reached 'expired' must NOT surface
    const otherExpired = createProposal({
      tenantId: 'tenant-i1',
      proposalType: 'add_note',
      payload: {},
      summary: 'not a schedule card',
      createdBy: 'user-i1',
    });
    await proposalRepo.create({ ...otherExpired, status: 'expired' });

    const res = await request(app).get('/api/proposals/inbox');
    expect(res.status).toBe(200);
    expect(res.body.expired).toHaveLength(1);
    expect(res.body.expired[0]).toMatchObject({
      summary: 'Lapsed booking',
      proposalType: 'create_appointment',
      status: 'expired',
    });
  });

  it('§5.5 — does not surface schedule cards that expired outside the recent window', async () => {
    const { app, proposalRepo } = buildApp();
    const longAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000); // 8 days ago
    const ancient = createProposal({
      tenantId: 'tenant-i1',
      proposalType: 'create_booking',
      payload: {},
      summary: 'Ancient lapsed booking',
      createdBy: 'user-i1',
      expiresAt: longAgo,
    });
    await proposalRepo.create({ ...ancient, status: 'expired' });

    const res = await request(app).get('/api/proposals/inbox');
    expect(res.status).toBe(200);
    expect(res.body.expired).toHaveLength(0);
  });
});

describe('POST /api/proposals/:id/re-propose (§5.5)', () => {
  it('clones an expired schedule proposal into a fresh draft with a new 48h expiry', async () => {
    const { app, proposalRepo } = buildApp();
    const past = new Date(Date.now() - 60 * 60 * 1000);
    const lapsed = createProposal({
      tenantId: 'tenant-i1',
      proposalType: 'create_booking',
      payload: { slot: 'x' },
      summary: 'Book it',
      createdBy: 'user-i1',
      expiresAt: past,
    });
    await proposalRepo.create({ ...lapsed, status: 'expired' });

    const res = await request(app).post(`/api/proposals/${lapsed.id}/re-propose`);
    expect(res.status).toBe(201);
    expect(res.body.id).not.toBe(lapsed.id);
    expect(res.body.status).toBe('draft');
    expect(res.body.proposalType).toBe('create_booking');
    expect(res.body.summary).toBe('Book it');
    expect(res.body.payload).toEqual({ slot: 'x' });
    const freshMs = new Date(res.body.expiresAt).getTime() - Date.now();
    expect(freshMs).toBeGreaterThan(47 * 60 * 60 * 1000);

    // the expired source is left untouched
    expect((await proposalRepo.findById('tenant-i1', lapsed.id))?.status).toBe('expired');
  });

  it('carries the source missingFields forward so an incomplete card stays gated', async () => {
    const { app, proposalRepo } = buildApp();
    const past = new Date(Date.now() - 60 * 60 * 1000);
    const incomplete = createProposal({
      tenantId: 'tenant-i1',
      proposalType: 'create_appointment',
      payload: {},
      summary: 'Needs a time',
      createdBy: 'user-i1',
      expiresAt: past,
      missingFields: ['scheduledStart'],
    });
    await proposalRepo.create({ ...incomplete, status: 'expired' });

    const res = await request(app).post(`/api/proposals/${incomplete.id}/re-propose`);
    expect(res.status).toBe(201);
    // missingFields ride in sourceContext; a re-proposed incomplete draft must
    // still surface them so approveProposal keeps refusing it until filled.
    expect(res.body.sourceContext?.missingFields).toEqual(['scheduledStart']);
  });

  it('returns 409 when the proposal is not expired', async () => {
    const { app, proposalRepo } = buildApp();
    const draft = createProposal({
      tenantId: 'tenant-i1',
      proposalType: 'create_appointment',
      payload: {},
      summary: 'still pending',
      createdBy: 'user-i1',
    });
    await proposalRepo.create(draft);
    const res = await request(app).post(`/api/proposals/${draft.id}/re-propose`);
    expect(res.status).toBe(409);
  });

  it('returns 404 for an expired proposal owned by another tenant', async () => {
    const { app, proposalRepo } = buildApp();
    const other = createProposal({
      tenantId: 'tenant-other',
      proposalType: 'create_appointment',
      payload: {},
      summary: 's',
      createdBy: 'u',
      expiresAt: new Date(Date.now() - 1000),
    });
    await proposalRepo.create({ ...other, status: 'expired' });
    const res = await request(app).post(`/api/proposals/${other.id}/re-propose`);
    expect(res.status).toBe(404);
  });
});
