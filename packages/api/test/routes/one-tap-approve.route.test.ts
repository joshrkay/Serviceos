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
import { applyChainMetadata } from '../../src/proposals/chain';
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

  it('approves eligible capture members when the token targets a chain head', async () => {
    const proposalRepo = new InMemoryProposalRepository();
    const auditRepo = new InMemoryAuditRepository();
    const smsEventRepo = new InMemoryProposalSmsEventRepository();
    const chainId = 'one-tap-chain-1';
    const head = createProposal({
      tenantId: TENANT,
      proposalType: 'create_customer',
      payload: { name: 'Jane Chain' },
      summary: 'Create Jane Chain',
      createdBy: 'voice',
    });
    applyChainMetadata(head, {
      chainId,
      chainIndex: 0,
      chainLength: 3,
      dependsOnChainIndices: [],
      chainRefs: [],
    });
    const job = createProposal({
      tenantId: TENANT,
      proposalType: 'create_job',
      payload: { customerId: 'placeholder', title: 'Install' },
      summary: 'Create install job',
      createdBy: 'voice',
    });
    applyChainMetadata(job, {
      chainId,
      chainIndex: 1,
      chainLength: 3,
      dependsOnChainIndices: [0],
      chainRefs: [{ payloadPath: 'customerId', parentChainIndex: 0, entityKind: 'customerId' }],
    });
    const sendEstimate = createProposal({
      tenantId: TENANT,
      proposalType: 'send_estimate',
      payload: { estimateId: '550e8400-e29b-41d4-a716-446655440001' },
      summary: 'Send estimate',
      createdBy: 'voice',
    });
    applyChainMetadata(sendEstimate, {
      chainId,
      chainIndex: 2,
      chainLength: 3,
      dependsOnChainIndices: [1],
      chainRefs: [{ payloadPath: 'estimateId', parentChainIndex: 1, entityKind: 'estimateId' }],
    });
    await proposalRepo.createMany([
      { ...head, status: 'ready_for_review' },
      { ...job, status: 'draft' },
      { ...sendEstimate, status: 'draft' },
    ]);
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
    const { token } = mint(head.id);

    const res = await request(app)
      .get('/public/proposals/one-tap-approve')
      .query({ token });

    expect(res.status).toBe(200);
    expect(res.text).toContain('Approved 2 linked actions');
    expect(res.text).toContain('1 follows separately');
    expect((await proposalRepo.findById(TENANT, head.id))?.status).toBe('approved');
    expect((await proposalRepo.findById(TENANT, job.id))?.status).toBe('approved');
    expect((await proposalRepo.findById(TENANT, sendEstimate.id))?.status).toBe('draft');
    expect(auditRepo.getAll()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          eventType: 'proposal.one_tap_approved',
          metadata: expect.objectContaining({
            approvedCount: 2,
            skippedCount: 1,
            skipped: [{ id: sendEstimate.id, reason: 'non_capture' }],
          }),
        }),
      ]),
    );
  });

  it('approving a non-head chain member shows the normal single-approval success page', async () => {
    const proposalRepo = new InMemoryProposalRepository();
    const auditRepo = new InMemoryAuditRepository();
    const smsEventRepo = new InMemoryProposalSmsEventRepository();
    const chainId = 'one-tap-chain-member';
    const head = createProposal({
      tenantId: TENANT,
      proposalType: 'create_customer',
      payload: { name: 'Jane Chain' },
      summary: 'Create Jane Chain',
      createdBy: 'voice',
    });
    applyChainMetadata(head, {
      chainId,
      chainIndex: 0,
      chainLength: 2,
      dependsOnChainIndices: [],
      chainRefs: [],
    });
    const job = createProposal({
      tenantId: TENANT,
      proposalType: 'create_job',
      payload: { customerId: 'placeholder', title: 'Install' },
      summary: 'Create install job',
      createdBy: 'voice',
    });
    applyChainMetadata(job, {
      chainId,
      chainIndex: 1,
      chainLength: 2,
      dependsOnChainIndices: [0],
      chainRefs: [{ payloadPath: 'customerId', parentChainIndex: 0, entityKind: 'customerId' }],
    });
    await proposalRepo.createMany([
      { ...head, status: 'ready_for_review' },
      { ...job, status: 'draft' },
    ]);
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
    const { token } = mint(job.id);

    const res = await request(app)
      .get('/public/proposals/one-tap-approve')
      .query({ token });

    expect(res.status).toBe(200);
    expect(res.text).toContain('Create install job');
    expect(res.text).not.toContain('linked');
    expect(res.text).not.toContain('follows separately');
    expect((await proposalRepo.findById(TENANT, head.id))?.status).toBe('ready_for_review');
    expect((await proposalRepo.findById(TENANT, job.id))?.status).toBe('approved');
  });
});

describe('approve-success HTML escaping', () => {
  it('escapes a <script> tag in proposal summary — no raw HTML in the success page', async () => {
    const proposalRepo = new InMemoryProposalRepository();
    const auditRepo = new InMemoryAuditRepository();
    const smsEventRepo = new InMemoryProposalSmsEventRepository();

    const base = createProposal({
      tenantId: TENANT,
      proposalType: 'create_appointment',
      payload: {},
      summary: '<script>alert(1)</script>',
      confidenceScore: 0.97,
      createdBy: 'voice',
    });
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

    const { token } = mint(proposal.id);
    const res = await request(app)
      .get('/public/proposals/one-tap-approve')
      .query({ token });

    expect(res.status).toBe(200);
    // Raw script tag must not appear in the response body.
    expect(res.text).not.toContain('<script>');
    // Escaped form must be present.
    expect(res.text).toContain('&lt;script&gt;');
  });
});

describe('RV-073 — one-tap approvals tag channel one_tap', () => {
  it('proposal.approved audit metadata carries channel one_tap', async () => {
    const { app, auditRepo, proposal } = await makeApp();
    const { token } = mint(proposal.id);

    const res = await request(app)
      .get('/public/proposals/one-tap-approve')
      .query({ token });
    expect(res.status).toBe(200);

    const events = await auditRepo.findByEntity(TENANT, 'proposal', proposal.id);
    const approvedEvent = events.find((e) => e.eventType === 'proposal.approved');
    expect(approvedEvent).toBeDefined();
    expect(approvedEvent!.metadata).toMatchObject({ channel: 'one_tap' });
  });
});
