/**
 * P12-004 wiring — public one-tap proposal approve route.
 *
 * Token round trip: mint via createOneTapApproveToken, hit the route,
 * proposal approves through the EXISTING approveProposal path (status
 * transition + approvedAt stamp + audit), nonce is single-use (second
 * hit → 410), tampered/missing token → 401, expired → 410.
 */
import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createOneTapApproveRouter } from '../../src/routes/one-tap-approve';
import {
  createOneTapApproveToken,
  createInMemoryNonceStore,
} from '../../src/proposals/auto-approve';
import {
  InMemoryProposalRepository,
  createProposal,
} from '../../src/proposals/proposal';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import {
  InMemoryProposalSmsEventRepository,
  createProposalSmsEvent,
} from '../../src/proposals/sms/sms-event';

const TENANT = 't-1';
const SECRET = 'test-one-tap-secret';

async function makeApp() {
  const proposalRepo = new InMemoryProposalRepository();
  const auditRepo = new InMemoryAuditRepository();
  const smsEventRepo = new InMemoryProposalSmsEventRepository();

  const base = createProposal({
    tenantId: TENANT,
    proposalType: 'create_appointment',
    payload: {
      customerName: 'Mrs Lee',
      scheduledStart: '2026-06-16T19:00:00Z',
      scheduledEnd: '2026-06-16T20:00:00Z',
    },
    summary: 'Book Mrs Lee Tuesday 2pm',
    confidenceScore: 0.97,
    createdBy: 'voice',
  });
  // Simulate the unsupervised hold: proposal queued for review.
  const proposal = await proposalRepo.create({ ...base, status: 'ready_for_review' });

  const app = express();
  app.use(express.json());
  app.use(
    '/public/proposals',
    createOneTapApproveRouter({
      proposalRepo,
      auditRepo,
      secret: SECRET,
      consumeNonce: createInMemoryNonceStore(),
      smsEventRepo,
    }),
  );
  return { app, proposalRepo, auditRepo, smsEventRepo, proposal };
}

function mint(proposalId: string, ttlMs?: number) {
  return createOneTapApproveToken({
    proposalId,
    tenantId: TENANT,
    secret: SECRET,
    ...(ttlMs !== undefined ? { ttlMs } : {}),
  });
}

describe('GET /public/proposals/one-tap-approve', () => {
  it('approves the proposal through the existing approval path and audits the use', async () => {
    const { app, proposalRepo, auditRepo, proposal } = await makeApp();
    const { token } = mint(proposal.id);

    const res = await request(app)
      .get('/public/proposals/one-tap-approve')
      .query({ token });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/html/);
    expect(res.text).toContain('Approved');

    const stored = await proposalRepo.findById(TENANT, proposal.id);
    expect(stored?.status).toBe('approved');
    expect(stored?.approvedAt).toBeInstanceOf(Date);

    const events = await auditRepo.findByEntity(TENANT, 'proposal', proposal.id);
    const types = events.map((e) => e.eventType);
    expect(types).toContain('proposal.approved');
    expect(types).toContain('proposal.one_tap_approved');
  });

  it('returns 409 and does not approve while a manual edit request is pending (P2-034)', async () => {
    const { app, proposalRepo, auditRepo, smsEventRepo, proposal } = await makeApp();
    // The owner asked for a change over SMS that could not be applied.
    await smsEventRepo.create(
      createProposalSmsEvent({
        tenantId: TENANT,
        proposalId: proposal.id,
        direction: 'inbound',
        kind: 'edit_request',
        messageSid: 'SM-edit-1',
        fromPhone: '5125550100',
        body: 'make it $200',
      }),
    );
    const { token } = mint(proposal.id);

    const res = await request(app)
      .get('/public/proposals/one-tap-approve')
      .query({ token });

    expect(res.status).toBe(409);
    expect(res.text).toContain('Review and approve it in your queue');
    expect((await proposalRepo.findById(TENANT, proposal.id))?.status).toBe(
      'ready_for_review',
    );
    const types = (await auditRepo.findByEntity(TENANT, 'proposal', proposal.id)).map(
      (e) => e.eventType,
    );
    expect(types).toContain('proposal.one_tap_blocked_pending_edit');
    expect(types).not.toContain('proposal.approved');
  });

  it('is single-use: the second hit with the same token returns 410', async () => {
    const { app, proposal } = await makeApp();
    const { token } = mint(proposal.id);

    await request(app).get('/public/proposals/one-tap-approve').query({ token }).expect(200);
    const second = await request(app)
      .get('/public/proposals/one-tap-approve')
      .query({ token });
    expect(second.status).toBe(410);
    expect(second.text).toContain('already used');
  });

  it('returns 401 for a tampered token and leaves the proposal untouched', async () => {
    const { app, proposalRepo, proposal } = await makeApp();
    const { token } = mint(proposal.id);
    const tampered = `${token.slice(0, -4)}AAAA`;

    const res = await request(app)
      .get('/public/proposals/one-tap-approve')
      .query({ token: tampered });
    expect(res.status).toBe(401);

    const stored = await proposalRepo.findById(TENANT, proposal.id);
    expect(stored?.status).toBe('ready_for_review');
  });

  it('returns 401 when the token is missing', async () => {
    const { app } = await makeApp();
    const res = await request(app).get('/public/proposals/one-tap-approve');
    expect(res.status).toBe(401);
  });

  it('returns 410 for an expired token', async () => {
    const { app, proposal } = await makeApp();
    const { token } = mint(proposal.id, 0); // expires immediately

    const res = await request(app)
      .get('/public/proposals/one-tap-approve')
      .query({ token });
    expect(res.status).toBe(410);
    expect(res.text).toContain('expired');
  });

  it('returns 503 when no secret is configured', async () => {
    const proposalRepo = new InMemoryProposalRepository();
    const auditRepo = new InMemoryAuditRepository();
    const app = express();
    app.use(
      '/public/proposals',
      createOneTapApproveRouter({
        proposalRepo,
        auditRepo,
        consumeNonce: createInMemoryNonceStore(),
      }),
    );
    const res = await request(app)
      .get('/public/proposals/one-tap-approve')
      .query({ token: 'whatever' });
    expect(res.status).toBe(503);
  });

  it('also accepts POST (one-tap from messaging apps that pre-fetch GETs)', async () => {
    const { app, proposalRepo, proposal } = await makeApp();
    const { token } = mint(proposal.id);

    const res = await request(app)
      .post(`/public/proposals/one-tap-approve?token=${encodeURIComponent(token)}`)
      .send();
    expect(res.status).toBe(200);
    const stored = await proposalRepo.findById(TENANT, proposal.id);
    expect(stored?.status).toBe('approved');
  });
});
