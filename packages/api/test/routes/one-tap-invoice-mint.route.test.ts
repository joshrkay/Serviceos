/**
 * RV-065 — digest "invoice it" one-tap: a mint_draft_invoice token tapped on
 * the public one-tap route mints a draft_invoice proposal for the bound job
 * (via the batch-invoice eligibility/payload machinery) and 302-redirects to
 * the standard approve page with a fresh single-use approve token.
 */
import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createOneTapApproveRouter } from '../../src/routes/one-tap-approve';
import {
  createOneTapApproveToken,
  verifyOneTapApproveToken,
  createInMemoryNonceStore,
} from '../../src/proposals/auto-approve';
import { InMemoryProposalRepository } from '../../src/proposals/proposal';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { InMemoryJobRepository, Job } from '../../src/jobs/job';
import { InMemoryInvoiceRepository } from '../../src/invoices/invoice';
import { Estimate, InMemoryEstimateRepository } from '../../src/estimates/estimate';
import { buildLineItem, calculateDocumentTotals, LineItem } from '../../src/shared/billing-engine';

const TENANT = 't-1';
const SECRET = 'test-one-tap-secret';
const JOB_ID = '11111111-1111-4111-8111-111111111111';
const CUSTOMER_ID = '22222222-2222-4222-8222-222222222222';

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: JOB_ID,
    tenantId: TENANT,
    customerId: CUSTOMER_ID,
    locationId: '33333333-3333-4333-8333-333333333333',
    jobNumber: 'JOB-1',
    summary: 'Heater replacement',
    status: 'completed',
    priority: 'normal',
    moneyState: 'estimate_accepted',
    createdBy: 'u-1',
    createdAt: new Date('2026-06-01T00:00:00Z'),
    updatedAt: new Date('2026-06-09T00:00:00Z'),
    ...overrides,
  } as Job;
}

function makeAcceptedEstimate(overrides: Partial<Estimate> = {}): Estimate {
  const lineItems: LineItem[] = [
    buildLineItem('44444444-4444-4444-8444-444444444444', 'Replace heater', 1, 120000, 0, true, 'labor'),
  ];
  return {
    id: '55555555-5555-4555-8555-555555555555',
    tenantId: TENANT,
    jobId: JOB_ID,
    estimateNumber: 'EST-1',
    status: 'accepted',
    lineItems,
    totals: calculateDocumentTotals(lineItems, 0, 0),
    acceptedAt: new Date('2026-06-08T00:00:00Z'),
    version: 1,
    createdBy: 'u-1',
    createdAt: new Date('2026-06-01T00:00:00Z'),
    updatedAt: new Date('2026-06-08T00:00:00Z'),
    ...overrides,
  };
}

async function makeApp(opts: { eligibleJob?: boolean; mintDeps?: boolean } = {}) {
  const proposalRepo = new InMemoryProposalRepository();
  const auditRepo = new InMemoryAuditRepository();
  const jobRepo = new InMemoryJobRepository();
  const invoiceRepo = new InMemoryInvoiceRepository();
  const estimateRepo = new InMemoryEstimateRepository();

  if (opts.eligibleJob !== false) {
    await jobRepo.create(makeJob());
    await estimateRepo.create(makeAcceptedEstimate());
  }

  const app = express();
  app.use(express.json());
  app.use(
    '/public/proposals',
    createOneTapApproveRouter({
      proposalRepo,
      auditRepo,
      secret: SECRET,
      consumeNonce: createInMemoryNonceStore(),
      ...(opts.mintDeps === false
        ? {}
        : { invoiceMintDeps: { jobRepo, invoiceRepo, estimateRepo } }),
    }),
  );
  return { app, proposalRepo, auditRepo };
}

function mintToken(jobId: string, ttlMs?: number) {
  return createOneTapApproveToken({
    action: 'mint_draft_invoice',
    jobId,
    tenantId: TENANT,
    secret: SECRET,
    ...(ttlMs !== undefined ? { ttlMs } : {}),
  });
}

describe('one-tap mint_draft_invoice (RV-065)', () => {
  it('tap → draft_invoice proposal created → 302 to the standard approve page', async () => {
    const { app, proposalRepo, auditRepo } = await makeApp();
    const { token } = mintToken(JOB_ID);

    const res = await request(app)
      .get('/public/proposals/one-tap-approve')
      .query({ token });

    expect(res.status).toBe(302);
    const location: string = res.headers.location;
    expect(location).toMatch(/^\/public\/proposals\/one-tap-approve\?token=/);

    // The minted proposal exists and bills the accepted estimate's lines.
    const proposals = await proposalRepo.findByTenant(TENANT);
    expect(proposals).toHaveLength(1);
    const draft = proposals[0];
    expect(draft.proposalType).toBe('draft_invoice');
    expect(draft.status).toBe('draft'); // capture-class draft — still human-gated
    expect(draft.payload).toMatchObject({
      customerId: CUSTOMER_ID,
      jobId: JOB_ID,
      discountCents: 0,
      taxRateBps: 0,
    });
    expect((draft.payload.lineItems as Array<{ unitPrice: number }>)[0].unitPrice).toBe(120000);
    expect(draft.sourceContext).toMatchObject({ source: 'digest_one_tap' });

    // The redirect token is a standard single-use APPROVE token bound to
    // the freshly minted proposal + tenant.
    const redirectedToken = decodeURIComponent(location.split('token=')[1]);
    const verified = await verifyOneTapApproveToken({
      token: redirectedToken,
      secret: SECRET,
      expectedTenantId: TENANT,
      consumeNonce: createInMemoryNonceStore(),
    });
    expect(verified).toEqual({
      ok: true,
      action: 'approve',
      proposalId: draft.id,
      tenantId: TENANT,
    });

    const events = await auditRepo.findByEntity(TENANT, 'proposal', draft.id);
    expect(events.map((e) => e.eventType)).toContain('proposal.one_tap_invoice_minted');
  });

  it('following the redirect approves the minted proposal through the standard path', async () => {
    const { app, proposalRepo } = await makeApp();
    const { token } = mintToken(JOB_ID);

    const first = await request(app)
      .get('/public/proposals/one-tap-approve')
      .query({ token });
    expect(first.status).toBe(302);

    const followed = await request(app).get(first.headers.location);
    expect(followed.status).toBe(200);
    expect(followed.text).toContain('Approved');

    const proposals = await proposalRepo.findByTenant(TENANT);
    expect(proposals[0].status).toBe('approved');
    expect(proposals[0].approvedAt).toBeInstanceOf(Date);
  });

  it('returns 404 when the job is not eligible (unknown / cross-tenant / billed)', async () => {
    const { app, proposalRepo } = await makeApp({ eligibleJob: false });
    const { token } = mintToken(JOB_ID);

    const res = await request(app)
      .get('/public/proposals/one-tap-approve')
      .query({ token });
    expect(res.status).toBe(404);
    expect(res.text).toContain('Nothing to invoice');
    expect(await proposalRepo.findByTenant(TENANT)).toHaveLength(0);
  });

  it('a second tap with a DIFFERENT token the same day answers 409 already drafted', async () => {
    const { app, proposalRepo } = await makeApp();
    const first = await request(app)
      .get('/public/proposals/one-tap-approve')
      .query({ token: mintToken(JOB_ID).token });
    expect(first.status).toBe(302);

    const second = await request(app)
      .get('/public/proposals/one-tap-approve')
      .query({ token: mintToken(JOB_ID).token });
    expect(second.status).toBe(409);
    expect(second.text).toContain('Already drafted');
    expect(await proposalRepo.findByTenant(TENANT)).toHaveLength(1);
  });

  it('replayed mint token → 410, nothing minted twice', async () => {
    const { app, proposalRepo } = await makeApp();
    const { token } = mintToken(JOB_ID);

    await request(app).get('/public/proposals/one-tap-approve').query({ token }).expect(302);
    const replay = await request(app)
      .get('/public/proposals/one-tap-approve')
      .query({ token });
    expect(replay.status).toBe(410);
    expect(replay.text).toContain('already used');
    expect(await proposalRepo.findByTenant(TENANT)).toHaveLength(1);
  });

  it('expired mint token → 410, nothing minted', async () => {
    const { app, proposalRepo } = await makeApp();
    const { token } = mintToken(JOB_ID, 0);

    const res = await request(app)
      .get('/public/proposals/one-tap-approve')
      .query({ token });
    expect(res.status).toBe(410);
    expect(await proposalRepo.findByTenant(TENANT)).toHaveLength(0);
  });

  it('returns 503 when mint deps are not wired', async () => {
    const { app } = await makeApp({ mintDeps: false });
    const res = await request(app)
      .get('/public/proposals/one-tap-approve')
      .query({ token: mintToken(JOB_ID).token });
    expect(res.status).toBe(503);
  });
});
