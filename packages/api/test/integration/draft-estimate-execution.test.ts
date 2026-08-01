/**
 * B8.1 restoration — voice `draft_estimate` end-to-end against real Postgres.
 *
 * Closes the gap flagged in Part E review round three (run log #18): the
 * `draft_estimate` execution "citation" was a comment-grep false positive —
 * no integration test actually drove a task-produced draft_estimate payload
 * through the REAL EstimateTaskHandler (catalog grounding included) and the
 * PRODUCTION DraftEstimateExecutionHandler (obtained via
 * createExecutionHandlerRegistry, not constructed directly) against genuine
 * Postgres columns.
 *
 * Mirrors test/integration/draft-invoice-execution.test.ts and
 * test/integration/voice-inbound-appointment.test.ts's conventions; the
 * mocked-gateway pattern is test/ai/tasks/estimate-edit-task.test.ts's
 * `mockGateway`.
 *
 * Proves:
 *   1. A task-produced draft_estimate payload → approve → execute via the
 *      registered DraftEstimateExecutionHandler persists an estimate row
 *      whose line items are catalog-grounded integer cents (the LLM's own
 *      price is overwritten by the seeded catalog item's price).
 *   2. Exactly one estimate.created audit event is emitted.
 *   3. Cross-tenant negative: the estimate is not readable by another
 *      tenant's scoped repo call.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { PgEstimateRepository } from '../../src/estimates/pg-estimate';
import { PgSettingsRepository } from '../../src/settings/pg-settings';
import { PgAuditRepository } from '../../src/audit/pg-audit';
import { PgJobRepository } from '../../src/jobs/pg-job';
import { PgCustomerRepository } from '../../src/customers/pg-customer';
import { PgLocationRepository } from '../../src/locations/pg-location';
import { PgCatalogItemRepository } from '../../src/catalog/pg-catalog-item';
import { createCatalogItem } from '../../src/catalog/catalog-item';
import { EstimateTaskHandler } from '../../src/ai/tasks/estimate-task';
import { LLMGateway, LLMResponse } from '../../src/ai/gateway/gateway';
import { InMemoryProposalRepository, Proposal } from '../../src/proposals/proposal';
import { InMemoryProposalExecutionRepository } from '../../src/proposals/proposal-execution';
import { transitionProposal, UNDO_WINDOW_MS } from '../../src/proposals/lifecycle';
import { ProposalExecutor } from '../../src/proposals/execution/executor';
import { IdempotencyGuard } from '../../src/proposals/execution/idempotency';
import {
  createExecutionHandlerRegistry,
  ExecutionContext,
} from '../../src/proposals/execution/handlers';

function mockGateway(jsonContent: string): LLMGateway {
  return {
    complete: vi.fn(async () => ({
      content: jsonContent,
      model: 'mock',
      provider: 'mock',
      tokenUsage: { input: 100, output: 60, total: 160 },
      latencyMs: 44,
    } satisfies LLMResponse)),
  } as unknown as LLMGateway;
}

describe('Postgres integration — voice draft_estimate → approve → execute → persist + audit', () => {
  let pool: Pool;
  let estimateRepo: PgEstimateRepository;
  let settingsRepo: PgSettingsRepository;
  let auditRepo: PgAuditRepository;
  let jobRepo: PgJobRepository;
  let locationRepo: PgLocationRepository;
  let customerRepo: PgCustomerRepository;
  let catalogRepo: PgCatalogItemRepository;
  let tenant: { tenantId: string; userId: string };
  let customerId: string;
  let jobId: string;
  let catalogPriceCents: number;

  beforeAll(async () => {
    pool = await getSharedTestDb();
    estimateRepo = new PgEstimateRepository(pool);
    settingsRepo = new PgSettingsRepository(pool);
    auditRepo = new PgAuditRepository(pool);
    jobRepo = new PgJobRepository(pool);
    locationRepo = new PgLocationRepository(pool);
    customerRepo = new PgCustomerRepository(pool);
    catalogRepo = new PgCatalogItemRepository(pool);
    tenant = await createTestTenant(pool);

    customerId = crypto.randomUUID();
    await customerRepo.create({
      id: customerId,
      tenantId: tenant.tenantId,
      firstName: 'Est',
      lastName: 'Customer',
      displayName: 'Est Customer',
      preferredChannel: 'phone',
      smsConsent: false,
      isArchived: false,
      createdBy: tenant.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const locId = crypto.randomUUID();
    await locationRepo.create({
      id: locId,
      tenantId: tenant.tenantId,
      customerId,
      street1: '77 Estimate Ln',
      city: 'Austin',
      state: 'TX',
      postalCode: '78701',
      country: 'USA',
      isPrimary: true,
      isArchived: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    jobId = crypto.randomUUID();
    await jobRepo.create({
      id: jobId,
      tenantId: tenant.tenantId,
      customerId,
      locationId: locId,
      jobNumber: 'JOB-EST-1',
      summary: 'Estimate test job',
      status: 'scheduled',
      priority: 'normal',
      createdBy: tenant.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // Catalog grounding: seed a real catalog item the drafted line must
    // resolve against (P22 catalog-resolver.ts — an LLM-invented price is
    // never trusted; the catalog price OVERRIDES it).
    catalogPriceCents = 15000;
    await catalogRepo.create(
      createCatalogItem({
        tenantId: tenant.tenantId,
        name: 'Site Visit',
        category: 'Labor',
        unit: 'hour',
        unitPriceCents: catalogPriceCents,
      }),
    );
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  async function draftAndExecute(): Promise<{ proposal: Proposal; resultEntityId: string }> {
    // What the LLM would extract from "Give the Johnson job a two-hour site
    // visit estimate" — note the drafted price (14950) deliberately differs
    // (within snap tolerance) from the seeded catalog price (15000), so a
    // persisted 15000 proves the catalog price won, not the LLM's.
    const gateway = mockGateway(
      JSON.stringify({
        jobId,
        lineItems: [
          { description: 'Site Visit', quantity: 2, unitPrice: 14950, category: 'labor' },
        ],
        notes: 'Voice-drafted estimate',
        confidence_score: 0.95,
      }),
    );

    const handler = new EstimateTaskHandler(gateway, catalogRepo);
    const result = await handler.handle({
      tenantId: tenant.tenantId,
      userId: tenant.userId,
      message: 'Give the Johnson job a two-hour site visit estimate',
      // Resolved caller identity — the REAL customerId, never LLM-authored
      // (estimate-task.ts authorCustomerId never trusts parsed.customerId).
      customerId,
    });

    expect(result.taskType).toBe('draft_estimate');
    expect(result.proposal.proposalType).toBe('draft_estimate');
    const draftedPayload = result.proposal.payload as Record<string, unknown>;
    expect(draftedPayload.customerId).toBe(customerId);
    const draftedLines = draftedPayload.lineItems as Array<Record<string, unknown>>;
    expect(draftedLines).toHaveLength(1);
    // Catalog grounding overrode the LLM's 14950 with the catalog's 15000.
    expect(draftedLines[0].unitPrice).toBe(catalogPriceCents);
    expect(draftedLines[0].pricingSource).toBe('catalog');

    let proposal: Proposal = result.proposal;
    // The high-confidence, catalog-grounded draft above may already have
    // auto-approved via decideInitialStatus (createProposal) — only walk
    // the FSM by hand when it hasn't.
    if (proposal.status !== 'approved') {
      proposal = transitionProposal(proposal, 'ready_for_review', tenant.userId);
      proposal = transitionProposal(proposal, 'approved', tenant.userId);
    }
    proposal = { ...proposal, approvedAt: new Date(Date.now() - UNDO_WINDOW_MS - 100) };

    const proposalRepo = new InMemoryProposalRepository();
    const executionRepo = new InMemoryProposalExecutionRepository();
    // PRODUCTION registry — proves the registry wires DraftEstimateExecutionHandler
    // with a real auditRepo (the fix under test), same as
    // draft-invoice-execution.test.ts proves for CreateInvoiceExecutionHandler.
    const handlers = createExecutionHandlerRegistry({
      estimateRepo,
      settingsRepo,
      jobRepo,
      locationRepo,
      auditRepo,
      customerRepo,
    });
    const guard = new IdempotencyGuard(executionRepo, proposalRepo);
    const executor = new ProposalExecutor(handlers, proposalRepo, guard, auditRepo);
    await proposalRepo.create(proposal);

    const context: ExecutionContext = { tenantId: tenant.tenantId, executedBy: tenant.userId };
    const { result: execResult } = await executor.execute(proposal, context);
    expect(execResult.success).toBe(true);
    expect(execResult.resultEntityId).toBeDefined();

    return { proposal, resultEntityId: execResult.resultEntityId as string };
  }

  it('persists an estimate row with catalog-grounded integer-cents lines', async () => {
    const { resultEntityId } = await draftAndExecute();

    const { rows } = await pool.query(
      `SELECT tenant_id, job_id, status, subtotal_cents, total_cents
         FROM estimates WHERE id = $1`,
      [resultEntityId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].tenant_id).toBe(tenant.tenantId);
    expect(rows[0].job_id).toBe(jobId);
    expect(rows[0].status).toBe('draft');
    // 2 hours x $150.00 catalog price = $300.00 — all integer cents.
    expect(Number(rows[0].subtotal_cents)).toBe(30000);
    expect(Number(rows[0].total_cents)).toBe(30000);

    const { rows: lineRows } = await pool.query(
      `SELECT description, quantity, unit_price_cents, total_cents, pricing_source
         FROM estimate_line_items WHERE estimate_id = $1 ORDER BY sort_order`,
      [resultEntityId],
    );
    expect(lineRows).toHaveLength(1);
    expect(lineRows[0].description).toBe('Site Visit');
    expect(Number(lineRows[0].quantity)).toBe(2);
    expect(Number(lineRows[0].unit_price_cents)).toBe(catalogPriceCents);
    expect(Number(lineRows[0].total_cents)).toBe(30000);
    expect(lineRows[0].pricing_source).toBe('catalog');
  });

  it('emits exactly one estimate.created audit event', async () => {
    const { resultEntityId } = await draftAndExecute();

    const { rows } = await pool.query(
      `SELECT event_type FROM audit_events
        WHERE tenant_id = $1 AND event_type = 'estimate.created'
          AND entity_type = 'estimate' AND entity_id = $2`,
      [tenant.tenantId, resultEntityId],
    );
    expect(rows).toHaveLength(1);
  });

  it('cross-tenant negative: another tenant cannot read the estimate through the scoped repo', async () => {
    const { resultEntityId } = await draftAndExecute();

    const other = await createTestTenant(pool);
    const found = await estimateRepo.findById(other.tenantId, resultEntityId);
    expect(found).toBeNull();
  });
});
