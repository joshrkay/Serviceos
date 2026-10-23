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
import { jobReferenceCheck } from '../../src/proposals/approval-reference-checks';
import {
  resolveBackupSupervisorApprover,
  type ResolvedApprover,
} from '../../src/proposals/approver-identity';
import { InMemorySettingsRepository, createSettings } from '../../src/settings/settings';
import { InMemoryUserRepository, type User } from '../../src/users/user';
import { InMemoryJobRepository, createJob } from '../../src/jobs/job';
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

describe('one-tap money-gating (Track-E redeem-side defense-in-depth)', () => {
  async function makeAppWithProposal(
    proposalType: 'issue_invoice' | 'send_invoice' | 'cancel_appointment',
    payload: Record<string, unknown>,
  ) {
    const proposalRepo = new InMemoryProposalRepository();
    const auditRepo = new InMemoryAuditRepository();
    const base = createProposal({
      tenantId: TENANT,
      proposalType,
      payload,
      summary: `${proposalType} action`,
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
      }),
    );
    return { app, proposalRepo, auditRepo, proposal };
  }

  it('refuses a plain one-tap token for a money proposal and does not approve it', async () => {
    const { app, proposalRepo, auditRepo, proposal } = await makeAppWithProposal(
      'issue_invoice',
      { invoiceId: 'inv-1', amountCents: 12000 },
    );
    const { token } = createOneTapApproveToken({
      proposalId: proposal.id,
      tenantId: TENANT,
      secret: SECRET,
    });

    const res = await request(app).get('/public/proposals/one-tap-approve').query({ token });

    expect(res.status).toBe(403);
    expect((await proposalRepo.findById(TENANT, proposal.id))?.status).toBe('ready_for_review');
    const types = (await auditRepo.findByEntity(TENANT, 'proposal', proposal.id)).map(
      (e) => e.eventType,
    );
    expect(types).toContain('proposal.one_tap_blocked_action_class');
    expect(types).not.toContain('proposal.approved');
  });

  it('refuses a plain one-tap token for a comms proposal (send_invoice)', async () => {
    const { app, proposalRepo, proposal } = await makeAppWithProposal('send_invoice', {
      invoiceId: 'inv-2',
    });
    const { token } = createOneTapApproveToken({
      proposalId: proposal.id,
      tenantId: TENANT,
      secret: SECRET,
    });

    const res = await request(app).get('/public/proposals/one-tap-approve').query({ token });

    expect(res.status).toBe(403);
    expect((await proposalRepo.findById(TENANT, proposal.id))?.status).toBe('ready_for_review');
  });

  it('refuses a plain one-tap token for an irreversible proposal (cancel_appointment)', async () => {
    const { app, proposalRepo, proposal } = await makeAppWithProposal('cancel_appointment', {
      appointmentId: 'appt-1',
    });
    const { token } = createOneTapApproveToken({
      proposalId: proposal.id,
      tenantId: TENANT,
      secret: SECRET,
    });

    const res = await request(app).get('/public/proposals/one-tap-approve').query({ token });

    expect(res.status).toBe(403);
    expect((await proposalRepo.findById(TENANT, proposal.id))?.status).toBe('ready_for_review');
  });

  it('does NOT burn the single-use nonce when refusing (pre-consume gate)', async () => {
    const { app, proposal } = await makeAppWithProposal('issue_invoice', { invoiceId: 'inv-3' });
    const { token } = createOneTapApproveToken({
      proposalId: proposal.id,
      tenantId: TENANT,
      secret: SECRET,
    });

    await request(app).get('/public/proposals/one-tap-approve').query({ token }).expect(403);
    // A burned nonce would 410 "already used"; the refusal must be pre-consume.
    const second = await request(app).get('/public/proposals/one-tap-approve').query({ token });
    expect(second.status).toBe(403);
    expect(second.text).not.toContain('already used');
  });

  it('approves a money proposal via a CONFIRM-flagged token (sanctioned voice-fallback path)', async () => {
    const { app, proposalRepo, proposal } = await makeAppWithProposal('issue_invoice', {
      invoiceId: 'inv-4',
      amountCents: 9900,
    });
    const { token } = createOneTapApproveToken({
      proposalId: proposal.id,
      tenantId: TENANT,
      secret: SECRET,
      confirm: true,
    });

    const res = await request(app).get('/public/proposals/one-tap-approve').query({ token });

    expect(res.status).toBe(200);
    expect((await proposalRepo.findById(TENANT, proposal.id))?.status).toBe('approved');
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

// B4 — the one-tap link runs the SAME approval-time reference checks as the
// dashboard approve route. A card the checks hold (its job belongs to a
// different customer) gets a plain "needs a closer look" page, never an
// "Approved" that then fails at execution.
describe('B4 — one-tap approval runs the approval-time reference checks', () => {
  it('holds a card the checks flag: 409 plain page, nothing approved', async () => {
    const proposalRepo = new InMemoryProposalRepository();
    const auditRepo = new InMemoryAuditRepository();
    const jobRepo = new InMemoryJobRepository();
    const jobOfOther = (
      await createJob(
        {
          tenantId: TENANT,
          customerId: '7a1b2c3d-2222-4222-8222-222222222222',
          locationId: 'loc-other',
          summary: 'Their furnace',
          createdBy: 'seed',
        },
        jobRepo,
      )
    ).id;
    const proposal = await proposalRepo.create({
      ...createProposal({
        tenantId: TENANT,
        proposalType: 'create_appointment',
        payload: {
          customerId: '7a1b2c3d-1111-4111-8111-111111111111',
          jobId: jobOfOther,
          scheduledStart: '2026-06-16T19:00:00Z',
          scheduledEnd: '2026-06-16T20:00:00Z',
        },
        summary: 'Book Mrs Lee Tuesday 2pm',
        confidenceScore: 0.97,
        createdBy: 'voice',
      }),
      status: 'ready_for_review',
    });
    const app = express();
    app.use(
      '/public/proposals',
      createOneTapApproveRouter({
        proposalRepo,
        auditRepo,
        secret: SECRET,
        consumeNonce: createInMemoryNonceStore(),
        approvalReferenceChecks: [jobReferenceCheck(jobRepo)],
      }),
    );

    const res = await request(app)
      .get('/public/proposals/one-tap-approve')
      .query({ token: mint(proposal.id).token });

    expect(res.status).toBe(409);
    expect(res.text).toContain('Needs a closer look');
    expect(res.text).toContain('something on it needs fixing first');
    expect(res.text).not.toContain('Approved');
    expect((await proposalRepo.findById(TENANT, proposal.id))?.status).toBe('ready_for_review');
    const types = (await auditRepo.findByEntity(TENANT, 'proposal', proposal.id)).map((e) => e.eventType);
    expect(types).not.toContain('proposal.approved');
    expect(types).not.toContain('proposal.one_tap_approved');
  });
});

// B1 follow-up — a linked step (e.g. "send the estimate") whose earlier step
// has not run yet is held by approveProposal's linked-step gate. The 409 page
// said "something on it needs fixing", which is not what the owner has to do:
// each linked-step hold says its own next step.
describe('B4 follow-up — one-tap on a linked step says what to do about the earlier step', () => {
  async function linkedStep(parentType: 'draft_estimate' | 'draft_invoice', parentStatus: 'ready_for_review' | 'approved' | 'rejected') {
    const proposalRepo = new InMemoryProposalRepository();
    const auditRepo = new InMemoryAuditRepository();
    const chainId = '33333333-3333-4333-8333-333333333333';
    const kind = parentType === 'draft_invoice' ? 'invoiceId' : 'estimateId';
    const parent = createProposal({
      tenantId: TENANT,
      proposalType: parentType,
      payload: { customerId: '44444444-4444-4444-8444-444444444444', lineItems: [] },
      summary: 'Estimate for Mrs Lee',
      createdBy: 'voice',
    });
    applyChainMetadata(parent, { chainId, chainIndex: 0, chainLength: 2, dependsOnChainIndices: [], chainRefs: [] });
    const child = createProposal({
      tenantId: TENANT,
      proposalType: parentType === 'draft_invoice' ? 'send_invoice' : 'send_estimate',
      payload: { channel: 'sms' },
      summary: 'Send it to Mrs Lee',
      createdBy: 'voice',
    });
    applyChainMetadata(child, {
      chainId,
      chainIndex: 1,
      chainLength: 2,
      dependsOnChainIndices: [0],
      chainRefs: [{ payloadPath: kind, parentChainIndex: 0, entityKind: kind }],
    });
    await proposalRepo.create({ ...parent, status: parentStatus });
    await proposalRepo.create({ ...child, status: 'ready_for_review' });
    const app = express();
    app.use(
      '/public/proposals',
      createOneTapApproveRouter({ proposalRepo, auditRepo, secret: SECRET, consumeNonce: createInMemoryNonceStore() }),
    );
    // The voice fallback mints the only non-capture links, with `confirm`.
    const { token } = createOneTapApproveToken({ proposalId: child.id, tenantId: TENANT, secret: SECRET, confirm: true });
    const res = await request(app).post('/public/proposals/one-tap-approve').type('form').send({ token });
    return { res, status: (await proposalRepo.findById(TENANT, child.id))?.status };
  }

  it('earlier step not approved yet: approve that one first', async () => {
    const { res, status } = await linkedStep('draft_estimate', 'ready_for_review');
    expect(res.status).toBe(409);
    expect(res.text).toContain('Approve the earlier step first');
    expect(res.text).toContain('This one depends on an earlier step that hasn’t run yet. Approve that one first');
    expect(res.text).not.toContain('needs fixing');
    expect(status).toBe('ready_for_review');
  });

  it('a send linked to an invoice that will be a draft: issue the invoice first', async () => {
    const { res, status } = await linkedStep('draft_invoice', 'approved');
    expect(res.status).toBe(409);
    expect(res.text).toContain('Issue the invoice first');
    // The same next step the voice line speaks: where to issue it, and then what.
    expect(res.text).toContain(
      'The invoice this sends has to be issued first. Issue it in the app, then approve this one from your review queue.',
    );
    expect(res.text).not.toContain('Once it exists');
    expect(res.text).not.toContain('needs fixing');
    expect(status).toBe('ready_for_review');
  });

  it('earlier step did not run: nothing for this one to act on', async () => {
    const { res, status } = await linkedStep('draft_estimate', 'rejected');
    expect(res.status).toBe(409);
    expect(res.text).toContain('The earlier step this one depends on didn’t run');
    expect(res.text).not.toContain('needs fixing');
    expect(res.text).not.toContain('Approve the earlier step first');
    expect(status).toBe('ready_for_review');
  });
});

// B1 — a link sent to the backup supervisor (the tenant has no owner phone)
// carries their user id and role, and the tap approves as them — not 'owner'.
describe('B1 — a one-tap link approves as its recipient', () => {
  async function appWith(
    proposalType: 'draft_estimate' | 'update_catalog_item',
    resolveBackupApprover?: (tenantId: string) => Promise<ResolvedApprover | null>,
  ) {
    const proposalRepo = new InMemoryProposalRepository();
    const auditRepo = new InMemoryAuditRepository();
    const proposal = await proposalRepo.create({
      ...createProposal({
        tenantId: TENANT,
        proposalType,
        payload:
          proposalType === 'draft_estimate'
            ? {
                customerId: '7a1b2c3d-1111-4111-8111-111111111111',
                lineItems: [{ description: 'Labor', quantity: 1, unitPrice: 11500 }],
              }
            : { catalogItemId: '7a1b2c3d-3333-4333-8333-333333333333', unitPriceCents: 9900 },
        summary: 'Estimate for Mrs Lee',
        confidenceScore: 0.97,
        createdBy: 'voice',
      }),
      status: 'ready_for_review',
    });
    const app = express();
    app.use(
      '/public/proposals',
      createOneTapApproveRouter({
        proposalRepo,
        auditRepo,
        secret: SECRET,
        consumeNonce: createInMemoryNonceStore(),
        ...(resolveBackupApprover ? { resolveBackupApprover } : {}),
      }),
    );
    return { app, proposalRepo, auditRepo, proposal };
  }

  const tokenFor = (proposalId: string, role: 'dispatcher' | 'technician') =>
    createOneTapApproveToken({
      proposalId,
      tenantId: TENANT,
      secret: SECRET,
      approver: { userId: 'clerk-backup', role },
    }).token;

  it("a link minted for a backup dispatcher executes with the dispatcher's role and id", async () => {
    const { app, proposalRepo, auditRepo, proposal } = await appWith('draft_estimate');

    const res = await request(app)
      .get('/public/proposals/one-tap-approve')
      .query({ token: tokenFor(proposal.id, 'dispatcher') });

    expect(res.status).toBe(200);
    const stored = (await proposalRepo.findById(TENANT, proposal.id))!;
    expect(stored.status).toBe('approved');
    expect(stored.executedByRole).toBe('dispatcher');
    expect(stored.executedBy).toBe('clerk-backup');
    const approved = (await auditRepo.findByEntity(TENANT, 'proposal', proposal.id)).find(
      (e) => e.eventType === 'proposal.approved',
    );
    expect(approved).toMatchObject({ actorId: 'clerk-backup', actorRole: 'dispatcher' });
  });

  it.each([
    ['a technician backup', 'draft_estimate', 'technician'],
    ['a dispatcher backup on a settings change', 'update_catalog_item', 'dispatcher'],
  ] as const)('%s gets a plain 403 page and nothing is approved', async (_label, type, role) => {
    const { app, proposalRepo, proposal } = await appWith(type);

    const res = await request(app)
      .get('/public/proposals/one-tap-approve')
      .query({ token: tokenFor(proposal.id, role) });

    expect(res.status).toBe(403);
    expect(res.text).toContain('owner');
    expect(res.text).not.toMatch(/proposal|dashboard|verify/i);
    expect((await proposalRepo.findById(TENANT, proposal.id))?.status).toBe('ready_for_review');
  });

  // The token's claims are from when the text went out; the tap re-checks
  // who the backup is NOW (resolveBackupSupervisorApprover in production).
  it('the backup is re-checked at the tap: still the backup → approves with the role they hold now', async () => {
    const { app, proposalRepo, proposal } = await appWith('draft_estimate', async () => ({
      role: 'owner',
      userId: 'clerk-backup',
      via: 'backup_supervisor',
    }));

    const res = await request(app)
      .get('/public/proposals/one-tap-approve')
      .query({ token: tokenFor(proposal.id, 'dispatcher') });

    expect(res.status).toBe(200);
    const stored = (await proposalRepo.findById(TENANT, proposal.id))!;
    expect(stored.executedByRole).toBe('owner');
    expect(stored.executedBy).toBe('clerk-backup');
  });

  it('a backup re-roled to technician since the text went out approves nothing', async () => {
    const { app, proposalRepo, proposal } = await appWith('draft_estimate', async () => ({
      role: 'technician',
      userId: 'clerk-backup',
      via: 'backup_supervisor',
    }));

    const res = await request(app)
      .get('/public/proposals/one-tap-approve')
      .query({ token: tokenFor(proposal.id, 'dispatcher') });

    expect(res.status).toBe(403);
    expect((await proposalRepo.findById(TENANT, proposal.id))?.status).toBe('ready_for_review');
  });

  it.each([
    ['replaced by someone else', async () => ({ role: 'dispatcher' as const, userId: 'clerk-someone-else', via: 'backup_supervisor' as const })],
    ['deactivated, or no longer anyone’s backup', async () => null],
    ['not knowable (the lookup fails)', async () => { throw new Error('db down'); }],
  ])('a backup %s since the text went out approves nothing', async (_label, current) => {
    const { app, proposalRepo, auditRepo, proposal } = await appWith('draft_estimate', current);

    const res = await request(app)
      .get('/public/proposals/one-tap-approve')
      .query({ token: tokenFor(proposal.id, 'dispatcher') });

    expect(res.status).toBe(403);
    expect(res.text).toContain('owner');
    expect(res.text).not.toMatch(/proposal|dashboard|verify/i);
    expect((await proposalRepo.findById(TENANT, proposal.id))?.status).toBe('ready_for_review');
    const types = (await auditRepo.findByEntity(TENANT, 'proposal', proposal.id)).map((e) => e.eventType);
    expect(types).toContain('proposal.one_tap_blocked_recipient');
    expect(types).not.toContain('proposal.approved');
  });

  it('an owner link still approves as the owner', async () => {
    const { app, proposalRepo, proposal } = await appWith('update_catalog_item');

    const res = await request(app).get('/public/proposals/one-tap-approve').query({ token: mint(proposal.id).token });

    expect(res.status).toBe(200);
    expect((await proposalRepo.findById(TENANT, proposal.id))?.executedByRole).toBe('owner');
  });
});

// B4-2 parity — the tap re-checked the backup by subject: the login id when
// they have one, else their users row id. A backup who linked a login after
// the text went out changed subject, so their own link was refused as if they
// had been replaced. The voice owner line already compares users row ids
// (#1810); the link now carries the row id and the tap compares it. A link
// minted before the row id rode in the token compares subjects as before.
describe('B4-2 parity — a backup link names the backup by users row id', () => {
  const BACKUP_MOBILE = '+15125550111';

  async function backupTenant() {
    const settingsRepo = new InMemorySettingsRepository();
    const users = new InMemoryUserRepository();
    await createSettings({ tenantId: TENANT, businessName: 'Backup Co' }, settingsRepo);
    const member = (overrides: Partial<User> = {}) =>
      users.create!({
        id: crypto.randomUUID(),
        tenantId: TENANT,
        email: `member-${Math.random().toString(36).slice(2)}@example.com`,
        role: 'dispatcher',
        canFieldServe: false,
        mobileNumber: BACKUP_MOBILE,
        ...overrides,
      });
    // A backup with no login yet: their subject is their users row id.
    const backup = await member();
    await settingsRepo.update(TENANT, { backupSupervisorUserId: backup.id });
    const approverDeps = { settingsRepo, userRepo: users };

    const proposalRepo = new InMemoryProposalRepository();
    const auditRepo = new InMemoryAuditRepository();
    const estimate = (summary: string) =>
      proposalRepo.create({
        ...createProposal({
          tenantId: TENANT,
          proposalType: 'draft_estimate',
          payload: {
            customerId: '7a1b2c3d-1111-4111-8111-111111111111',
            lineItems: [{ description: 'Labor', quantity: 1, unitPrice: 11500 }],
          },
          summary,
          confidenceScore: 0.97,
          createdBy: 'voice',
        }),
        status: 'ready_for_review',
      });
    const proposal = await estimate('Estimate for Mrs Lee');
    const app = express();
    app.use(
      '/public/proposals',
      createOneTapApproveRouter({
        proposalRepo,
        auditRepo,
        secret: SECRET,
        consumeNonce: createInMemoryNonceStore(),
        // Production wiring (app.ts).
        resolveBackupApprover: (tenantId) => resolveBackupSupervisorApprover(approverDeps, tenantId),
      }),
    );

    // The link as the text went out: who the backup was then.
    const atSend = (await resolveBackupSupervisorApprover(approverDeps, TENANT))!;
    expect(atSend).toMatchObject({ userId: backup.id, userRowId: backup.id });
    const link = createOneTapApproveToken({
      proposalId: proposal.id,
      tenantId: TENANT,
      secret: SECRET,
      approver: { userId: atSend.userId!, role: atSend.role, userRowId: atSend.userRowId! },
    }).token;
    const tap = (token = link) => request(app).get('/public/proposals/one-tap-approve').query({ token });
    const status = async (id = proposal.id) => (await proposalRepo.findById(TENANT, id))?.status;
    const auditTypes = async () =>
      (await auditRepo.findByEntity(TENANT, 'proposal', proposal.id)).map((e) => e.eventType);
    return { settingsRepo, users, backup, member, estimate, proposal, proposalRepo, tap, status, auditTypes };
  }

  it('a backup who links a login after the link went out still approves with it, as that login', async () => {
    const t = await backupTenant();
    // Linking a login gives the same users row a login subject.
    await t.users.create!({ ...t.backup, clerkUserId: 'clerk-linked' });

    const res = await t.tap();

    expect(res.status).toBe(200);
    const stored = (await t.proposalRepo.findById(TENANT, t.proposal.id))!;
    expect(stored.status).toBe('approved');
    expect(stored.executedBy).toBe('clerk-linked');
    expect(stored.executedByRole).toBe('dispatcher');
  });

  it('a different teammate made backup on the same mobile is refused', async () => {
    const t = await backupTenant();
    const teammate = await t.member({ clerkUserId: 'clerk-teammate' });
    await t.settingsRepo.update(TENANT, { backupSupervisorUserId: teammate.id });

    const res = await t.tap();

    expect(res.status).toBe(403);
    expect(res.text).toContain('Ask the owner');
    expect(await t.status()).toBe('ready_for_review');
    expect(await t.auditTypes()).toContain('proposal.one_tap_blocked_recipient');
    expect(await t.auditTypes()).not.toContain('proposal.approved');
  });

  it('a backup deactivated after the link went out is refused', async () => {
    const t = await backupTenant();
    await t.users.deactivateMember(TENANT, t.backup.id);

    const res = await t.tap();

    expect(res.status).toBe(403);
    expect(await t.status()).toBe('ready_for_review');
    expect(await t.auditTypes()).toContain('proposal.one_tap_blocked_recipient');
  });

  it('a link minted before the row id rode in the token still compares subjects', async () => {
    const t = await backupTenant();
    const subjectOnly = (proposalId: string) =>
      createOneTapApproveToken({
        proposalId,
        tenantId: TENANT,
        secret: SECRET,
        approver: { userId: t.backup.id, role: 'dispatcher' },
      }).token;

    // Same subject → approves.
    const same = await t.tap(subjectOnly(t.proposal.id));
    expect(same.status).toBe(200);
    expect(await t.status()).toBe('approved');

    // Subject changed since → refused, as before (fail closed).
    const next = await t.estimate('Estimate for Mr Park');
    await t.users.create!({ ...t.backup, clerkUserId: 'clerk-linked' });
    const changed = await t.tap(subjectOnly(next.id));
    expect(changed.status).toBe(403);
    expect(await t.status(next.id)).toBe('ready_for_review');
  });
});
