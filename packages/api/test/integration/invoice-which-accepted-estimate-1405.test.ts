/**
 * #1405 — "invoice the accepted estimate" when the customer has SEVERAL
 * accepted estimates: the chat asks which one (never a silent guess), and the
 * pick re-drafts the invoice's lines, discount and tax from the chosen
 * estimate.
 *
 * Seam: the REAL chat route (`POST /api/assistant/chat`) with the REAL
 * PgEntityResolver and PgEstimateRepository over real Postgres. The LLM is
 * the one stub: the classifier, then the invoice drafter's placeholder line
 * (what the live model writes when it cannot see the estimate).
 *
 * Worked example for the picked estimate (EST-B): one taxable $1,200.00 line,
 * $200.00 discount, 8.25% tax → $82.50 tax, $1,082.50 total.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { Pool } from 'pg';
import express, { type Request, type Response, type NextFunction } from 'express';
import supertest from 'supertest';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { PgEntityResolver } from '../../src/ai/resolution/pg-entity-resolver';
import { PgJobRepository } from '../../src/jobs/pg-job';
import { PgCustomerRepository } from '../../src/customers/pg-customer';
import { PgLocationRepository } from '../../src/locations/pg-location';
import { PgAuditRepository } from '../../src/audit/pg-audit';
import { PgEstimateRepository } from '../../src/estimates/pg-estimate';
import { PgConversationRepository } from '../../src/conversations/pg-conversation';
import { createAssistantRouter } from '../../src/routes/assistant';
import type { AuthenticatedRequest } from '../../src/middleware/auth';
import type { LLMGateway, LLMResponse } from '../../src/ai/gateway/gateway';
import { InMemoryProposalRepository, missingFieldsFor } from '../../src/proposals/proposal';
import { buildLineItem, calculateDocumentTotals } from '../../src/shared/billing-engine';
import {
  setSupervisorPresenceLoader,
  _resetSupervisorPresenceCache,
} from '../../src/ai/supervisor-presence';

const CUSTOMER_NAME = 'Tess Twoquotes';

function scriptedGateway(responses: string[]): LLMGateway {
  let i = 0;
  return {
    complete: vi.fn(
      async () =>
        ({
          content: responses[Math.min(i++, responses.length - 1)],
          model: 'mock',
          provider: 'mock',
          tokenUsage: { input: 1, output: 1, total: 2 },
          latencyMs: 1,
        }) satisfies LLMResponse,
    ),
  } as unknown as LLMGateway;
}

describe('#1405 — several accepted estimates: ask which, then bill the pick (real chat route, real Postgres)', () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = await getSharedTestDb();
    setSupervisorPresenceLoader(async () => true);
  });

  afterAll(async () => {
    _resetSupervisorPresenceCache();
    await closeSharedTestDb();
  });

  it('asks which accepted estimate, and the answer re-drafts lines, discount and tax from it', async () => {
    const { tenantId, userId } = await createTestTenant(pool);
    const now = new Date();
    await pool.query(
      `INSERT INTO tenant_settings (id, tenant_id, business_name, timezone, region)
       VALUES ($1, $2, 'Two Quotes Plumbing', 'UTC', 'AZ')`,
      [crypto.randomUUID(), tenantId],
    );
    const customerRepo = new PgCustomerRepository(pool);
    const locationRepo = new PgLocationRepository(pool);
    const jobRepo = new PgJobRepository(pool);
    const estimateRepo = new PgEstimateRepository(pool);
    const customerId = crypto.randomUUID();
    await customerRepo.create({
      id: customerId,
      tenantId,
      firstName: 'Tess',
      lastName: 'Twoquotes',
      displayName: CUSTOMER_NAME,
      preferredChannel: 'phone',
      smsConsent: false,
      isArchived: false,
      createdBy: userId,
      createdAt: now,
      updatedAt: now,
    });
    const locationId = crypto.randomUUID();
    await locationRepo.create({
      id: locationId,
      tenantId,
      customerId,
      street1: '1405 Choice Ave',
      city: 'Mesa',
      state: 'AZ',
      postalCode: '85201',
      country: 'USA',
      isPrimary: true,
      addressType: 'service',
      isArchived: false,
      createdAt: now,
      updatedAt: now,
    });
    // One accepted estimate per job (uq_estimates_accepted_per_job): the
    // customer's two accepted estimates sit on two of their jobs.
    const jobA = crypto.randomUUID();
    const jobB = crypto.randomUUID();
    for (const [id, num, summary] of [
      [jobA, 'JOB-1405-A', 'Water heater'],
      [jobB, 'JOB-1405-B', 'Kitchen repipe'],
    ] as const) {
      await jobRepo.create({
        id,
        tenantId,
        customerId,
        locationId,
        jobNumber: num,
        summary,
        status: 'in_progress',
        priority: 'normal',
        createdBy: userId,
        createdAt: now,
        updatedAt: now,
      });
    }
    const aLines = [buildLineItem(crypto.randomUUID(), 'Water heater install', 1, 100000, 0, true, 'labor')];
    const bLines = [buildLineItem(crypto.randomUUID(), 'Repipe kitchen', 1, 120000, 0, true, 'labor')];
    const estimateA = crypto.randomUUID();
    const estimateB = crypto.randomUUID();
    for (const [id, jobId, num, lines, discount, tax] of [
      [estimateA, jobA, 'EST-A1405', aLines, 0, 0],
      [estimateB, jobB, 'EST-B1405', bLines, 20000, 825],
    ] as const) {
      await estimateRepo.create({
        id,
        tenantId,
        jobId,
        estimateNumber: num,
        status: 'accepted',
        lineItems: [...lines],
        totals: calculateDocumentTotals([...lines], discount, tax),
        version: 1,
        createdBy: userId,
        createdAt: now,
        updatedAt: now,
      });
    }

    const proposalRepo = new InMemoryProposalRepository();
    const gateway = scriptedGateway([
      JSON.stringify({
        intentType: 'create_invoice',
        confidence: 0.95,
        reasoning: 'test',
        extractedEntities: { customerName: CUSTOMER_NAME },
      }),
      JSON.stringify({
        lineItems: [{ description: 'Service as per accepted estimate', quantity: 1, unitPrice: 1000 }],
        confidence_score: 0.9,
      }),
    ]);
    const app = express();
    app.use(express.json());
    app.use((req: Request, _res: Response, next: NextFunction) => {
      (req as AuthenticatedRequest).auth = { userId, sessionId: 'sess-1405', tenantId, role: 'owner' };
      next();
    });
    app.use(
      '/api/assistant',
      createAssistantRouter({
        gateway,
        proposalRepo,
        entityResolver: new PgEntityResolver(pool),
        jobRepo,
        customerRepo,
        auditRepo: new PgAuditRepository(pool),
        conversationRepo: new PgConversationRepository(pool),
        estimateRepo,
        tenantTimezoneResolver: async () => 'UTC',
      }),
    );

    const conversationId = crypto.randomUUID();
    const ask = await supertest(app)
      .post('/api/assistant/chat')
      .send({
        messages: [{ role: 'user', content: `Invoice ${CUSTOMER_NAME} for the accepted estimate` }],
        conversationId,
      });
    expect(ask.status).toBe(200);
    const question = ask.body.message.content as string;
    expect(question).toContain('EST-A1405');
    expect(question).toContain('EST-B1405');
    expect(question).toContain('$1,082.50');

    const [gated] = await proposalRepo.findByTenant(tenantId);
    expect(gated.proposalType).toBe('draft_invoice');
    expect(missingFieldsFor(gated)).toContain('estimateId');
    expect(gated.payload.estimateId).toBeUndefined();

    const answer = await supertest(app)
      .post('/api/assistant/chat')
      .send({ messages: [{ role: 'user', content: 'EST-B1405' }], conversationId });
    expect(answer.status).toBe(200);

    const picked = await proposalRepo.findById(tenantId, gated.id);
    expect(picked!.payload.estimateId).toBe(estimateB);
    expect(missingFieldsFor(picked!)).not.toContain('estimateId');
    const lines = picked!.payload.lineItems as Array<{ description: string; quantity: number; unitPriceCents: number }>;
    expect(lines.map((l) => [l.description, l.quantity, l.unitPriceCents])).toEqual([['Repipe kitchen', 1, 120000]]);
    expect(picked!.payload.discountCents).toBe(20000);
    expect(picked!.payload.taxRateBps).toBe(825);
    // D-004: the pick fills the draft; it never approves it.
    expect(['draft', 'ready_for_review']).toContain(picked!.status);
  });
});
