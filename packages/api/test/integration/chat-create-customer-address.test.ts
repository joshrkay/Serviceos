/**
 * #1271 — the chat-created customer gets its service location, pinned against
 * real Postgres.
 *
 * QA 2026-09-16: "Create a new customer … address 456 Oak Ave, Phoenix AZ
 * 85002" through the assistant produced a customer with no service location
 * (tenant-wide 0 locations across 15 AI-created customers), so a later
 * estimate approved and failed "Customer has no service location". This
 * drives the chat route (scripted classifier), approves the draft, runs the
 * production execution registry against Pg repos, and reads the
 * service_locations row back. Then it pins the approval-time
 * service-location check on the same real rows.
 *
 * Runs only under `npm run test:integration`.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import express, { type Request, type Response, type NextFunction } from 'express';
import request from 'supertest';
import { Pool } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { createAssistantRouter } from '../../src/routes/assistant';
import { PgCustomerRepository } from '../../src/customers/pg-customer';
import { PgLocationRepository } from '../../src/locations/pg-location';
import { PgAuditRepository } from '../../src/audit/pg-audit';
import {
  createProposal,
  InMemoryProposalRepository,
  type Proposal,
} from '../../src/proposals/proposal';
import { InMemoryProposalExecutionRepository } from '../../src/proposals/proposal-execution';
import { UNDO_WINDOW_MS } from '../../src/proposals/lifecycle';
import { approveProposal } from '../../src/proposals/actions';
import { serviceLocationReferenceCheck } from '../../src/proposals/approval-reference-checks';
import { ProposalExecutor } from '../../src/proposals/execution/executor';
import { IdempotencyGuard } from '../../src/proposals/execution/idempotency';
import { createExecutionHandlerRegistry } from '../../src/proposals/execution/handlers';
import type { AuthenticatedRequest } from '../../src/middleware/auth';
import type { LLMGateway, LLMResponse } from '../../src/ai/gateway/gateway';

function classifierGateway(entities: Record<string, unknown>): LLMGateway {
  return {
    complete: vi.fn(
      async () =>
        ({
          content: JSON.stringify({ intentType: 'create_customer', confidence: 0.95, extractedEntities: entities }),
          model: 'mock',
          provider: 'mock',
          tokenUsage: { input: 1, output: 1, total: 2 },
          latencyMs: 1,
        }) satisfies LLMResponse,
    ),
  } as unknown as LLMGateway;
}

describe('Postgres integration — #1271 chat create_customer keeps its address as a service location', () => {
  let pool: Pool;
  let tenant: { tenantId: string; userId: string };
  let customerRepo: PgCustomerRepository;
  let locationRepo: PgLocationRepository;
  let auditRepo: PgAuditRepository;
  let customerId: string;

  beforeAll(async () => {
    pool = await getSharedTestDb();
    tenant = await createTestTenant(pool);
    customerRepo = new PgCustomerRepository(pool);
    locationRepo = new PgLocationRepository(pool);
    auditRepo = new PgAuditRepository(pool);

    const proposalRepo = new InMemoryProposalRepository();
    const app = express();
    app.use(express.json());
    app.use((req: Request, _res: Response, next: NextFunction) => {
      (req as AuthenticatedRequest).auth = {
        userId: tenant.userId,
        sessionId: 'sess-1271',
        tenantId: tenant.tenantId,
        role: 'owner',
      };
      next();
    });
    app.use(
      '/api/assistant',
      createAssistantRouter({
        gateway: classifierGateway({
          displayName: 'Priya Whitfield',
          phone: '555-0100',
          address: '456 Oak Ave, Phoenix, AZ 85002',
        }),
        proposalRepo,
      }),
    );

    const res = await request(app)
      .post('/api/assistant/chat')
      .send({
        messages: [
          {
            role: 'user',
            content: 'Create a new customer Priya Whitfield, phone 555-0100, address 456 Oak Ave, Phoenix, AZ 85002',
          },
        ],
      });
    expect(res.status).toBe(200);

    const [drafted] = await proposalRepo.findByTenant(tenant.tenantId);
    const approved = await approveProposal(proposalRepo, tenant.tenantId, drafted.id, tenant.userId, 'owner');
    const due: Proposal = { ...approved, approvedAt: new Date(Date.now() - UNDO_WINDOW_MS - 100) };
    await proposalRepo.update(tenant.tenantId, due.id, { approvedAt: due.approvedAt });

    const registry = createExecutionHandlerRegistry({ customerRepo, auditRepo, locationRepo });
    const executor = new ProposalExecutor(
      registry,
      proposalRepo,
      new IdempotencyGuard(new InMemoryProposalExecutionRepository(), proposalRepo),
      auditRepo,
    );
    const { result } = await executor.execute(due, { tenantId: tenant.tenantId, executedBy: tenant.userId });
    expect(result.success).toBe(true);
    customerId = result.resultEntityId as string;
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  it('writes the spoken address as the customer\'s service_locations row', async () => {
    const { rows } = await pool.query(
      `SELECT street1, city, state, postal_code, is_archived
         FROM service_locations WHERE tenant_id = $1 AND customer_id = $2`,
      [tenant.tenantId, customerId],
    );
    expect(rows).toEqual([
      { street1: '456 Oak Ave', city: 'Phoenix', state: 'AZ', postal_code: '85002', is_archived: false },
    ]);
  });

  it('a resolved estimate for that customer passes the approval-time location check', async () => {
    const proposalRepo = new InMemoryProposalRepository();
    const estimate = createProposal({
      tenantId: tenant.tenantId,
      proposalType: 'draft_estimate',
      payload: {
        customerId,
        lineItems: [{ description: 'Water heater install', quantity: 1, unitPriceCents: 117000 }],
      },
      summary: 'Estimate for Priya',
      createdBy: tenant.userId,
    });
    await proposalRepo.create(estimate);
    await expect(
      approveProposal(proposalRepo, tenant.tenantId, estimate.id, tenant.userId, 'owner', undefined, 'ui', {
        referenceChecks: [serviceLocationReferenceCheck(locationRepo)],
      }),
    ).resolves.toMatchObject({ status: 'approved' });
  });

  it('a customer with no location is refused at approval, not at execution', async () => {
    const bare = await customerRepo.create({
      id: crypto.randomUUID(),
      tenantId: tenant.tenantId,
      firstName: 'Taylor',
      lastName: 'Brooks',
      displayName: 'Taylor Brooks',
      preferredChannel: 'none',
      smsConsent: false,
      isArchived: false,
      createdBy: tenant.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const proposalRepo = new InMemoryProposalRepository();
    const estimate = createProposal({
      tenantId: tenant.tenantId,
      proposalType: 'draft_estimate',
      payload: {
        customerId: bare.id,
        lineItems: [{ description: 'Water heater install', quantity: 1, unitPriceCents: 117000 }],
      },
      summary: 'Estimate for Taylor',
      createdBy: tenant.userId,
    });
    await proposalRepo.create(estimate);
    await expect(
      approveProposal(proposalRepo, tenant.tenantId, estimate.id, tenant.userId, 'owner', undefined, 'ui', {
        referenceChecks: [serviceLocationReferenceCheck(locationRepo)],
      }),
    ).rejects.toMatchObject({ details: { missingFields: ['locationId'] } });
  });
});
