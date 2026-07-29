/**
 * B7.6 restoration — voice `update_estimate` end-to-end against real Postgres.
 *
 * Closes the gap flagged in Part E review round three (run log #18): the
 * only existing `update_estimate` integration coverage called
 * `applyEstimateEdits` directly, so `UpdateEstimateExecutionHandler`
 * (proposals/execution/update-estimate-handler.ts) — the actual production
 * execution path a voice-approved edit runs through — had NO integration
 * coverage at all.
 *
 * Mirrors test/integration/draft-invoice-execution.test.ts and
 * test/integration/voice-inbound-appointment.test.ts's conventions; the
 * mocked-gateway pattern is test/ai/tasks/estimate-edit-task.test.ts's
 * `mockGateway`.
 *
 * Proves:
 *   1. A task-produced update_estimate add-line-item payload (drafted by the
 *      REAL EstimateEditTaskHandler, catalog grounding included) → approve
 *      → execute via the registered UpdateEstimateExecutionHandler persists
 *      the new line and recomputes totals correctly (integer cents).
 *   2. Exactly one estimate.updated audit event is emitted.
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
import { createEstimate } from '../../src/estimates/estimate';
import { getNextEstimateNumber } from '../../src/settings/settings';
import { buildLineItem } from '../../src/shared/billing-engine';
import { EstimateEditTaskHandler } from '../../src/ai/tasks/estimate-edit-task';
import { UpdateEstimateExecutionHandler } from '../../src/proposals/execution/update-estimate-handler';
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

describe('Postgres integration — voice update_estimate → approve → execute → persist + audit', () => {
  let pool: Pool;
  let estimateRepo: PgEstimateRepository;
  let settingsRepo: PgSettingsRepository;
  let auditRepo: PgAuditRepository;
  let jobRepo: PgJobRepository;
  let catalogRepo: PgCatalogItemRepository;
  let tenant: { tenantId: string; userId: string };
  let jobId: string;
  let catalogPriceCents: number;

  beforeAll(async () => {
    pool = await getSharedTestDb();
    estimateRepo = new PgEstimateRepository(pool);
    settingsRepo = new PgSettingsRepository(pool);
    auditRepo = new PgAuditRepository(pool);
    jobRepo = new PgJobRepository(pool);
    catalogRepo = new PgCatalogItemRepository(pool);
    const customerRepo = new PgCustomerRepository(pool);
    const locationRepo = new PgLocationRepository(pool);
    tenant = await createTestTenant(pool);

    const customerId = crypto.randomUUID();
    await customerRepo.create({
      id: customerId,
      tenantId: tenant.tenantId,
      firstName: 'Edit',
      lastName: 'Customer',
      displayName: 'Edit Customer',
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
      street1: '99 Edit Ave',
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
      jobNumber: 'JOB-EDIT-1',
      summary: 'Update-estimate test job',
      status: 'scheduled',
      priority: 'normal',
      createdBy: tenant.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // Catalog grounding for the drafted edit line — same money-correctness
    // contract as draft_estimate (VOX-50 / edit-action-grounding.ts).
    catalogPriceCents = 7500;
    await catalogRepo.create(
      createCatalogItem({
        tenantId: tenant.tenantId,
        name: 'Trip Fee',
        category: 'Labor',
        unit: 'each',
        unitPriceCents: catalogPriceCents,
      }),
    );
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  async function seedEstimate(): Promise<{ id: string; subtotalBefore: number }> {
    const estimateNumber = await getNextEstimateNumber(tenant.tenantId, settingsRepo);
    const estimate = await createEstimate(
      {
        tenantId: tenant.tenantId,
        jobId,
        estimateNumber,
        lineItems: [buildLineItem('li-seed', 'Existing Line', 1, 10000, 0, true, 'labor')],
        createdBy: tenant.userId,
      },
      estimateRepo,
      auditRepo,
    );
    return { id: estimate.id, subtotalBefore: estimate.totals.subtotalCents };
  }

  async function draftEditAndExecute(estimateId: string): Promise<{ resultEntityId: string }> {
    // What the LLM would extract from "Add a trip fee to that estimate" —
    // the drafted price (7400) deliberately differs (within snap tolerance)
    // from the seeded catalog price (7500), so a persisted 7500 proves the
    // catalog price won, not the LLM's.
    const gateway = mockGateway(
      JSON.stringify({
        estimateReference: estimateId,
        editActions: [
          {
            type: 'add_line_item',
            lineItem: { description: 'Trip Fee', quantity: 1, unitPrice: 7400 },
          },
        ],
        confidence_score: 0.92,
      }),
    );

    const handler = new EstimateEditTaskHandler(gateway, estimateRepo, catalogRepo);
    const result = await handler.handle({
      tenantId: tenant.tenantId,
      userId: tenant.userId,
      message: 'Add a trip fee to that estimate',
    });

    expect(result.taskType).toBe('update_estimate');
    expect(result.proposal.proposalType).toBe('update_estimate');
    const draftedPayload = result.proposal.payload as Record<string, unknown>;
    // Repo-verified UUID reference lands on payload.estimateId (verify-or-gate).
    expect(draftedPayload.estimateId).toBe(estimateId);
    const actions = draftedPayload.editActions as Array<Record<string, unknown>>;
    expect(actions).toHaveLength(1);
    const lineItem = actions[0].lineItem as Record<string, unknown>;
    expect(lineItem.unitPrice).toBe(catalogPriceCents);
    expect(lineItem.pricingSource).toBe('catalog');

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
    // PRODUCTION registry — proves the registry wires UpdateEstimateExecutionHandler
    // with real auditRepo/jobRepo (deposit-lock resolution), the same pattern
    // draft-invoice-execution.test.ts uses for CreateInvoiceExecutionHandler.
    const handlers = createExecutionHandlerRegistry({
      estimateRepo,
      auditRepo,
      jobRepo,
    });
    const guard = new IdempotencyGuard(executionRepo, proposalRepo);
    const executor = new ProposalExecutor(handlers, proposalRepo, guard, auditRepo);
    await proposalRepo.create(proposal);

    const context: ExecutionContext = { tenantId: tenant.tenantId, executedBy: tenant.userId };
    const { result: execResult } = await executor.execute(proposal, context);
    expect(execResult.success).toBe(true);
    expect(execResult.resultEntityId).toBe(estimateId);

    return { resultEntityId: execResult.resultEntityId as string };
  }

  it('persists the new line item and recomputes totals correctly (integer cents)', async () => {
    const { id: estimateId, subtotalBefore } = await seedEstimate();
    await draftEditAndExecute(estimateId);

    const { rows: lineRows } = await pool.query(
      `SELECT description, quantity, unit_price_cents, total_cents, pricing_source
         FROM estimate_line_items WHERE estimate_id = $1 ORDER BY sort_order`,
      [estimateId],
    );
    expect(lineRows).toHaveLength(2);
    expect(lineRows[0].description).toBe('Existing Line');
    const addedLine = lineRows[1];
    expect(addedLine.description).toBe('Trip Fee');
    expect(Number(addedLine.unit_price_cents)).toBe(catalogPriceCents);
    expect(Number(addedLine.total_cents)).toBe(catalogPriceCents);
    expect(addedLine.pricing_source).toBe('catalog');

    const { rows: estRows } = await pool.query(
      `SELECT subtotal_cents, total_cents, version FROM estimates WHERE id = $1`,
      [estimateId],
    );
    expect(estRows).toHaveLength(1);
    expect(Number(estRows[0].subtotal_cents)).toBe(subtotalBefore + catalogPriceCents);
    expect(Number(estRows[0].total_cents)).toBe(subtotalBefore + catalogPriceCents);
    // Optimistic-lock version bumped by the edit.
    expect(Number(estRows[0].version)).toBe(2);
  });

  it('emits exactly one estimate.updated audit event', async () => {
    const { id: estimateId } = await seedEstimate();
    await draftEditAndExecute(estimateId);

    const { rows } = await pool.query(
      `SELECT event_type FROM audit_events
        WHERE tenant_id = $1 AND event_type = 'estimate.updated'
          AND entity_type = 'estimate' AND entity_id = $2`,
      [tenant.tenantId, estimateId],
    );
    expect(rows).toHaveLength(1);
  });

  it('cross-tenant negative: another tenant cannot read or edit the estimate through the scoped repo', async () => {
    const { id: estimateId } = await seedEstimate();
    await draftEditAndExecute(estimateId);

    const other = await createTestTenant(pool);
    const found = await estimateRepo.findById(other.tenantId, estimateId);
    expect(found).toBeNull();

    // The execution handler itself refuses a cross-tenant target: scoping
    // by the OTHER tenant's id must not find and mutate tenant A's estimate.
    const handler = new UpdateEstimateExecutionHandler(
      estimateRepo,
      auditRepo,
      undefined,
      undefined,
      jobRepo,
    );
    const context: ExecutionContext = { tenantId: other.tenantId, executedBy: other.userId };
    const result = await handler.execute(
      {
        id: crypto.randomUUID(),
        tenantId: other.tenantId,
        proposalType: 'update_estimate',
        payload: {
          estimateId,
          editActions: [
            {
              type: 'add_line_item',
              lineItem: { description: 'Should Not Land', quantity: 1, unitPrice: 100 },
            },
          ],
        },
        status: 'approved',
        summary: 'cross-tenant attempt',
        createdBy: other.userId,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as Proposal,
      context,
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not found in this tenant/);
  });
});
