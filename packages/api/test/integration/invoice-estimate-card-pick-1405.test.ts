/**
 * #1405 / A4-4 — the card's one-tap pick of "which accepted estimate?" on an
 * AI-drafted invoice, on real Postgres.
 *
 * The chat drafts the invoice gated on `estimateId` (several accepted
 * estimates), with the model's placeholder line. That line is uncatalogued,
 * so the draft's `_meta` carries `fieldConfidence` and `markers` for it. The
 * card's pick PUTs `{ estimateId }`, and editProposal re-drafts the lines,
 * discount and tax from the picked estimate (dropping that line's confidence
 * markers) before it writes with `updateIfUnchanged`.
 *
 * The re-draft deleted those `_meta` keys IN PLACE on the object shared with
 * the row editProposal had read. updateIfUnchanged then compared the altered
 * read with the row Postgres returned, saw a difference nobody wrote, and the
 * pick was refused with a false 409 on every try. The in-memory repository
 * could not show it: its read shares the stored row's payload object, which
 * changed along with the read.
 *
 * Real Postgres, RLS_RUNTIME_ROLE=true, the REAL request-transaction
 * middleware (the chat route bypasses it, as in app.ts), the REAL chat and
 * proposals routers, PgProposalRepository, PgEstimateRepository and
 * PgEntityResolver. The LLM is the one stub: the classifier, then the
 * invoice drafter's placeholder line.
 *
 * Picked estimate (EST-B): one taxable $1,200.00 line, $200.00 discount,
 * 8.25% tax.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import express, { type NextFunction, type Request, type Response } from 'express';
import supertest from 'supertest';
import { closeSharedTestDb, createTestTenant, getSharedTestDb } from './shared';
import { withTenantTransaction } from '../../src/middleware/tenant-context';
import { PgTenantTransactionRunner } from '../../src/db/tenant-transaction';
import { PgEntityResolver } from '../../src/ai/resolution/pg-entity-resolver';
import { PgJobRepository } from '../../src/jobs/pg-job';
import { PgCustomerRepository } from '../../src/customers/pg-customer';
import { PgLocationRepository } from '../../src/locations/pg-location';
import { PgAuditRepository } from '../../src/audit/pg-audit';
import { PgEstimateRepository } from '../../src/estimates/pg-estimate';
import { PgConversationRepository } from '../../src/conversations/pg-conversation';
import { PgProposalRepository } from '../../src/proposals/pg-proposal';
import { missingFieldsFor, type Proposal } from '../../src/proposals/proposal';
import { editProposal } from '../../src/proposals/actions';
import { createAssistantRouter } from '../../src/routes/assistant';
import { createProposalsRouter } from '../../src/routes/proposals';
import type { AuthenticatedRequest } from '../../src/middleware/auth';
import type { LLMGateway, LLMRequest, LLMResponse } from '../../src/ai/gateway/gateway';
import { buildLineItem, calculateDocumentTotals } from '../../src/shared/billing-engine';
import {
  _resetSupervisorPresenceCache,
  setSupervisorPresenceLoader,
} from '../../src/ai/supervisor-presence';

const CUSTOMER_NAME = 'Pia Pickcard';

/** The classifier on every call, except the invoice drafter (its placeholder line). */
function stubGateway(): LLMGateway {
  return {
    complete: vi.fn(async (request: LLMRequest) => {
      const content =
        request.taskType === 'draft_invoice'
        ? JSON.stringify({
            lineItems: [{ description: 'Service as per accepted estimate', quantity: 1, unitPrice: 1000 }],
            confidence_score: 0.9,
          })
        : JSON.stringify({
            intentType: 'create_invoice',
            confidence: 0.95,
            reasoning: 'test',
            extractedEntities: { customerName: CUSTOMER_NAME },
          });
      return {
        content,
        model: 'mock',
        provider: 'mock',
        tokenUsage: { input: 1, output: 1, total: 2 },
        latencyMs: 1,
      } satisfies LLMResponse;
    }),
  } as unknown as LLMGateway;
}

describe('#1405 / A4-4 — the card pick of "which accepted estimate?" on an AI-drafted invoice (real Postgres)', () => {
  let pool: Pool;
  let app: express.Express;
  let tenantId: string;
  let userId: string;
  let estimateB: string;
  let proposalRepo: PgProposalRepository;
  let estimateRepo: PgEstimateRepository;
  let auditRepo: PgAuditRepository;

  beforeAll(async () => {
    expect(process.env.RLS_RUNTIME_ROLE, 'this proof needs the RLS runtime role on').toBe('true');
    pool = await getSharedTestDb();
    setSupervisorPresenceLoader(async () => true);
    ({ tenantId, userId } = await createTestTenant(pool));
    const now = new Date();
    await pool.query(
      `INSERT INTO tenant_settings (id, tenant_id, business_name, timezone, region)
       VALUES ($1, $2, 'Card Pick Plumbing', 'UTC', 'AZ')`,
      [crypto.randomUUID(), tenantId],
    );
    const customerRepo = new PgCustomerRepository(pool);
    const jobRepo = new PgJobRepository(pool);
    estimateRepo = new PgEstimateRepository(pool);
    proposalRepo = new PgProposalRepository(pool);
    auditRepo = new PgAuditRepository(pool);
    const customerId = crypto.randomUUID();
    await customerRepo.create({
      id: customerId,
      tenantId,
      firstName: 'Pia',
      lastName: 'Pickcard',
      displayName: CUSTOMER_NAME,
      preferredChannel: 'phone',
      smsConsent: false,
      isArchived: false,
      createdBy: userId,
      createdAt: now,
      updatedAt: now,
    });
    const locationId = crypto.randomUUID();
    await new PgLocationRepository(pool).create({
      id: locationId,
      tenantId,
      customerId,
      street1: '1405 Card Ave',
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
    // One accepted estimate per job (uq_estimates_accepted_per_job).
    const jobA = crypto.randomUUID();
    const jobB = crypto.randomUUID();
    for (const [id, num, summary] of [
      [jobA, 'JOB-CARD-A', 'Water heater'],
      [jobB, 'JOB-CARD-B', 'Kitchen repipe'],
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
    const estimateA = crypto.randomUUID();
    estimateB = crypto.randomUUID();
    for (const [id, jobId, num, lines, discount, tax] of [
      [estimateA, jobA, 'EST-CA1405', [buildLineItem(crypto.randomUUID(), 'Water heater install', 1, 100000, 0, true, 'labor')], 0, 0],
      [estimateB, jobB, 'EST-CB1405', [buildLineItem(crypto.randomUUID(), 'Repipe kitchen', 1, 120000, 0, true, 'labor')], 20000, 825],
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

    app = express();
    app.use(express.json());
    app.use((req: Request, _res: Response, next: NextFunction) => {
      (req as AuthenticatedRequest).auth = { userId, sessionId: 'sess-card-1405', tenantId, role: 'owner' };
      next();
    });
    // As app.ts: every /api request runs in a tenant transaction, except the
    // LLM-long-call routes (the chat) that bypass it.
    app.use('/api', withTenantTransaction(pool));
    app.use(
      '/api/assistant',
      createAssistantRouter({
        gateway: stubGateway(),
        proposalRepo,
        entityResolver: new PgEntityResolver(pool),
        jobRepo,
        customerRepo,
        auditRepo,
        conversationRepo: new PgConversationRepository(pool),
        estimateRepo,
        tenantTimezoneResolver: async () => 'UTC',
      }),
    );
    app.use(
      '/api/proposals',
      createProposalsRouter(
        proposalRepo,
        new PgTenantTransactionRunner(pool),
        undefined,
        auditRepo,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        estimateRepo,
      ),
    );
  });

  afterAll(async () => {
    _resetSupervisorPresenceCache();
    await closeSharedTestDb();
  });

  /** The chat drafts the invoice and asks which accepted estimate; returns the gated draft. */
  async function gatedDraft(): Promise<Proposal> {
    const ask = await supertest(app)
      .post('/api/assistant/chat')
      .send({
        messages: [{ role: 'user', content: `Invoice ${CUSTOMER_NAME} for the accepted estimate` }],
        conversationId: crypto.randomUUID(),
      });
    expect(ask.status).toBe(200);
    expect(ask.body.message.content).toContain('EST-CB1405');
    const id = ask.body.proposal?.id as string | undefined;
    const drafts = (await proposalRepo.findByTenant(tenantId)).filter(
      (p) => p.proposalType === 'draft_invoice' && (id === undefined || p.id === id) && p.payload.estimateId === undefined,
    );
    expect(drafts.length).toBeGreaterThanOrEqual(1);
    const gated = drafts.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
    expect(missingFieldsFor(gated)).toContain('estimateId');
    // The case under test: the placeholder line is uncatalogued, so the
    // draft carries that line's confidence markers.
    const meta = gated.payload._meta as Record<string, unknown> | undefined;
    expect(meta?.fieldConfidence ?? meta?.markers, 'the AI draft carries line confidence markers').toBeDefined();
    return gated;
  }

  /** Re-drafted from EST-B: its line, discount and tax; nothing left to pick; the AI's draft kept as first proposed. */
  async function expectRedraftedFromEstimateB(gated: Proposal) {
    const stored = (await proposalRepo.findById(tenantId, gated.id))!;
    expect(stored.payload.estimateId).toBe(estimateB);
    const lines = stored.payload.lineItems as Array<{ description: string; quantity: number; unitPriceCents: number }>;
    expect(lines.map((l) => [l.description, l.quantity, l.unitPriceCents])).toEqual([['Repipe kitchen', 1, 120000]]);
    expect(stored.payload.discountCents).toBe(20000);
    expect(stored.payload.taxRateBps).toBe(825);
    expect(missingFieldsFor(stored)).not.toContain('estimateId');
    expect(missingFieldsFor(stored).filter((f) => f.startsWith('lineItems['))).toEqual([]);
    expect(stored.sourceContext?.pendingEntityAmbiguity).toBeUndefined();
    // The placeholder line's markers went with it ...
    const meta = stored.payload._meta as Record<string, unknown>;
    expect(meta.fieldConfidence).toBeUndefined();
    expect(meta.markers).toBeUndefined();
    // ... but the payload as first proposed keeps them (the correction
    // recorder diffs it against what executes).
    expect(stored.originalPayload?._meta).toEqual(gated.payload._meta);
    // D-004: the pick fills the draft; it never approves it.
    expect(['draft', 'ready_for_review']).toContain(stored.status);
    const { rows } = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM audit_events
        WHERE tenant_id = $1 AND entity_type = 'proposal' AND entity_id = $2 AND event_type = 'proposal.edited'`,
      [tenantId, gated.id],
    );
    expect(rows[0].n).toBe(1);
  }

  it('PUT /api/proposals/:id { estimateId } in the request transaction answers 200 and re-drafts the invoice', async () => {
    const gated = await gatedDraft();

    const res = await supertest(app)
      .put(`/api/proposals/${gated.id}`)
      .send({ edits: { estimateId: estimateB } });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    await expectRedraftedFromEstimateB(gated);
  });

  it('the same pick outside a request transaction (the voice and text edit shape) is written, not refused', async () => {
    const gated = await gatedDraft();

    await editProposal(proposalRepo, tenantId, gated.id, userId, 'owner', { estimateId: estimateB }, auditRepo, undefined, undefined, estimateRepo);

    await expectRedraftedFromEstimateB(gated);
  });
});
