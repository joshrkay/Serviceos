/**
 * Production-readiness Task 5 — voice `create_customer` end-to-end.
 *
 * Exercises the production execution path (ProposalExecutor + voice handler)
 * and proves the persisted customer is readable via GET /api/customers/:id.
 * Uses in-memory repos so the test validates handler ↔ API wiring without
 * depending on Postgres row shape beyond what the handler writes.
 */
import express, { Request, Response, NextFunction } from 'express';
import request from 'supertest';
import { describe, it, expect } from 'vitest';
import {
  createProposal,
  CreateProposalInput,
  InMemoryProposalRepository,
  Proposal,
  ProposalType,
} from '../../src/proposals/proposal';
import { InMemoryProposalExecutionRepository } from '../../src/proposals/proposal-execution';
import { transitionProposal, UNDO_WINDOW_MS } from '../../src/proposals/lifecycle';
import { ProposalExecutor } from '../../src/proposals/execution/executor';
import { IdempotencyGuard } from '../../src/proposals/execution/idempotency';
import { ExecutionContext, ExecutionHandler } from '../../src/proposals/execution/handlers';
import { CreateCustomerVoiceExecutionHandler } from '../../src/proposals/execution/create-customer-handler';
import { InMemoryCustomerRepository } from '../../src/customers/customer';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { createCustomerRouter } from '../../src/routes/customers';
import { AuthenticatedRequest } from '../../src/auth/clerk';
import { TEST_TENANT_ID, TEST_USER_ID } from '../routes/test-app';

describe('Integration — voice create_customer via ProposalExecutor', () => {
  const baseInput: CreateProposalInput = {
    tenantId: TEST_TENANT_ID,
    proposalType: 'create_customer',
    payload: { name: 'Jane Doe', email: 'jane@example.com' },
    summary: 'Create customer from voice call',
    createdBy: TEST_USER_ID,
  };

  const context: ExecutionContext = {
    tenantId: TEST_TENANT_ID,
    executedBy: TEST_USER_ID,
  };

  function makeApprovedProposal(): Proposal {
    let proposal = createProposal(baseInput);
    proposal = transitionProposal(proposal, 'ready_for_review', TEST_USER_ID);
    proposal = transitionProposal(proposal, 'approved', TEST_USER_ID);
    // Backdate past the 5-second undo window so executor runs immediately.
    return {
      ...proposal,
      approvedAt: new Date(Date.now() - UNDO_WINDOW_MS - 100),
    };
  }

  function buildCustomerApiApp(
    customerRepo: InMemoryCustomerRepository,
    auditRepo: InMemoryAuditRepository,
  ) {
    const app = express();
    app.use(express.json());
    app.use((req: Request, _res: Response, next: NextFunction) => {
      (req as AuthenticatedRequest).auth = {
        userId: TEST_USER_ID,
        sessionId: 'session-test-1',
        tenantId: TEST_TENANT_ID,
        role: 'owner',
      };
      next();
    });
    app.use('/api/customers', createCustomerRouter(customerRepo, auditRepo));
    return app;
  }

  it('persists customer on execute and returns it via GET /api/customers/:id', async () => {
    const proposalRepo = new InMemoryProposalRepository();
    const executionRepo = new InMemoryProposalExecutionRepository();
    const customerRepo = new InMemoryCustomerRepository();
    const auditRepo = new InMemoryAuditRepository();

    const handlers = new Map<ProposalType, ExecutionHandler>([
      ['create_customer', new CreateCustomerVoiceExecutionHandler(customerRepo, auditRepo)],
    ]);
    const guard = new IdempotencyGuard(executionRepo, proposalRepo);
    const executor = new ProposalExecutor(handlers, proposalRepo, guard);

    const proposal = makeApprovedProposal();
    await proposalRepo.create(proposal);

    const { result } = await executor.execute(proposal, context);
    expect(result.success).toBe(true);
    expect(result.resultEntityId).toBeDefined();

    const app = buildCustomerApiApp(customerRepo, auditRepo);
    const res = await request(app).get(`/api/customers/${result.resultEntityId}`);

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(result.resultEntityId);
    expect(res.body.displayName).toBe('Jane Doe');
    expect(res.body.firstName).toBe('Jane');
    expect(res.body.lastName).toBe('Doe');
    expect(res.body.email).toBe('jane@example.com');
  });
});
