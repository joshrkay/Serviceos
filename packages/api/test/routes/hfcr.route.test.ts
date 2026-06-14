import { describe, it, expect } from 'vitest';
import express, { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { v4 as uuidv4 } from 'uuid';
import { AuthenticatedRequest } from '../../src/auth/clerk';
import { createReportsRouter, ReportsRouterDeps } from '../../src/routes/reports';
import { InMemoryRevenueBySourceRepository } from '../../src/reports/revenue-by-source';
import { InMemoryPaymentRepository, Payment } from '../../src/invoices/payment';
import { InMemoryProposalRepository, Proposal } from '../../src/proposals/proposal';
import { InMemoryAuditRepository, createAuditEvent } from '../../src/audit/audit';

const TENANT = 'tenant-r1';

function buildApp(extraDeps: Partial<ReportsRouterDeps> = {}) {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as AuthenticatedRequest).auth = {
      userId: 'user-r1',
      sessionId: 'session-r1',
      tenantId: TENANT,
      role: 'owner',
    };
    next();
  });
  app.use(
    '/api/reports',
    createReportsRouter({
      revenueBySourceRepo: new InMemoryRevenueBySourceRepository(),
      ...extraDeps,
    }),
  );
  return app;
}

async function seedHandsFreeInvoice(
  paymentRepo: InMemoryPaymentRepository,
  proposalRepo: InMemoryProposalRepository,
  auditRepo: InMemoryAuditRepository,
) {
  const proposal: Proposal = {
    id: uuidv4(),
    tenantId: TENANT,
    proposalType: 'issue_invoice',
    status: 'executed',
    payload: {},
    summary: 'Issue invoice',
    createdBy: 'u1',
    createdAt: new Date(),
    updatedAt: new Date(),
    resultEntityId: 'inv-1',
  };
  await proposalRepo.create(proposal);
  await auditRepo.create(
    createAuditEvent({
      tenantId: TENANT,
      actorId: 'u1',
      actorRole: 'owner',
      eventType: 'proposal.approved',
      entityType: 'proposal',
      entityId: proposal.id,
      metadata: { channel: 'voice' },
    }),
  );
  const payment: Payment = {
    id: uuidv4(),
    tenantId: TENANT,
    invoiceId: 'inv-1',
    amountCents: 42000,
    method: 'credit_card',
    status: 'completed',
    receivedAt: new Date('2026-06-10T00:00:00Z'),
    processedBy: 'system:stripe_webhook',
    createdAt: new Date(),
    updatedAt: new Date(),
    refundedAmountCents: 0,
    refundedAt: null,
    lastRefundStripeId: null,
    reversedAt: null,
    reversalReason: null,
  };
  await paymentRepo.create(payment);
}

describe('GET /api/reports/hfcr', () => {
  it('returns the hands-free total + recovered-call count for the month', async () => {
    const paymentRepo = new InMemoryPaymentRepository();
    const proposalRepo = new InMemoryProposalRepository();
    const auditRepo = new InMemoryAuditRepository();
    await seedHandsFreeInvoice(paymentRepo, proposalRepo, auditRepo);
    const app = buildApp({ paymentRepo, proposalRepo, auditRepo });

    const res = await request(app).get('/api/reports/hfcr?month=2026-06');
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      month: '2026-06',
      hfcrCents: 42000,
      handsFreeInvoiceCount: 1,
      recoveredCallCount: 1,
    });
  });

  it('503s when the metric deps are not configured', async () => {
    const app = buildApp(); // no payment/proposal/audit repos
    const res = await request(app).get('/api/reports/hfcr');
    expect(res.status).toBe(503);
  });

  it('400s on a malformed month', async () => {
    const app = buildApp({
      paymentRepo: new InMemoryPaymentRepository(),
      proposalRepo: new InMemoryProposalRepository(),
      auditRepo: new InMemoryAuditRepository(),
    });
    const res = await request(app).get('/api/reports/hfcr?month=June');
    expect(res.status).toBe(400);
  });
});
