/**
 * QA 2026-09-16 (matrix row AST-04) — HTTP pin for the approval-time
 * reference check. The check itself is proven at the approveProposal seam
 * (test/proposals/approve-reference-check.test.ts); this file proves the
 * dashboard's Approve tap actually reaches it through createProposalsRouter's
 * trailing `approvalReferenceChecks` parameter — the single-approve route,
 * not the batch lane — because a mis-wired argument is a silent no-op.
 */
import request from 'supertest';
import { describe, it, expect } from 'vitest';
import express, { type Request, type Response, type NextFunction } from 'express';
import { createProposalsRouter } from '../../src/routes/proposals';
import {
  InMemoryProposalRepository,
  createProposal,
  type CreateProposalInput,
} from '../../src/proposals/proposal';
import { InMemoryInvoiceRepository } from '../../src/invoices/invoice';
import { invoiceReferenceCheck } from '../../src/proposals/approval-reference-checks';
import { buildInvoice } from '../factories/invoice.factory';
import type { AuthenticatedRequest } from '../../src/auth/clerk';

const TENANT = 'tenant-ast04-route';
const USER = 'user-ast04-route';
const JOB_ID = 'c73844bd-4928-4d1f-b8c5-f669ceb10018';
const INVOICE_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

function buildApp(invoiceRepo: InMemoryInvoiceRepository) {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as AuthenticatedRequest).auth = { userId: USER, sessionId: 's', tenantId: TENANT, role: 'owner' };
    next();
  });
  const proposalRepo = new InMemoryProposalRepository();
  app.use(
    '/api/proposals',
    createProposalsRouter(
      proposalRepo,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      [invoiceReferenceCheck(invoiceRepo)],
    ),
  );
  return { app, proposalRepo };
}

function sendInvoice(invoiceId: string): CreateProposalInput {
  return {
    tenantId: TENANT,
    proposalType: 'send_invoice',
    payload: { channel: 'sms', invoiceId },
    summary: 'Send the invoice by text',
    createdBy: USER,
  };
}

describe('POST /api/proposals/:id/approve — approval-time reference check is wired', () => {
  it('400s a send_invoice whose invoiceId names no invoice, naming the field like an unfilled gate', async () => {
    const { app, proposalRepo } = buildApp(new InMemoryInvoiceRepository());
    const proposal = createProposal(sendInvoice(JOB_ID));
    await proposalRepo.create(proposal);

    const res = await request(app).post(`/api/proposals/${proposal.id}/approve`);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION_ERROR');
    expect(JSON.stringify(res.body)).toContain('invoiceId');
    expect((await proposalRepo.findById(TENANT, proposal.id))!.status).toBe('draft');
  });

  it('approves when the invoice exists', async () => {
    const invoiceRepo = new InMemoryInvoiceRepository();
    await invoiceRepo.create(buildInvoice({ id: INVOICE_ID, tenantId: TENANT, jobId: JOB_ID }));
    const { app, proposalRepo } = buildApp(invoiceRepo);
    const proposal = createProposal(sendInvoice(INVOICE_ID));
    await proposalRepo.create(proposal);

    const res = await request(app).post(`/api/proposals/${proposal.id}/approve`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('approved');
  });
});
