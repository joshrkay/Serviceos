/**
 * B7.5 (rivet-voice-19) — a SPOKEN parts edit lands its unit of measure on
 * the persisted row, driven end to end through the live voice chain.
 *
 * The existing B7.5 integration test (spoken-parts-line-item.test.ts) proves
 * the persistence plumbing, but it hand-builds the `EstimateEditAction`
 * literal — including `unit: 'each'` — so it can only prove the LAST two
 * rungs (editor → INSERT → row mapper). Nothing proved that the unit is ever
 * PRODUCED by a live path: the edit-path grounding function
 * (`groundEditActionPricing`) never attached one, so a real spoken edit
 * persisted `unit = NULL` while the test stayed green.
 *
 * This test closes that. It drives the fixture sentence through:
 *
 *   REAL EstimateEditTaskHandler.handle() (the same handler
 *   handler-registry.ts wires for the voice worker and the assistant route),
 *   with the REAL PgCatalogItemRepository and the REAL
 *   `groundEditActionPricing` grounding pass
 *     → approveProposal / the proposal FSM
 *     → the PRODUCTION execution registry (createExecutionHandlerRegistry)
 *       + ProposalExecutor → UpdateEstimateExecutionHandler
 *     → applyEstimateEdits → updateEstimate → real Postgres
 *
 * and then asserts the `estimate_line_items.unit` COLUMN, the audit event,
 * and the two money-safety invariants that make `unit` safe to carry:
 *
 *   1. The catalog is the source of truth for the unit exactly as it is for
 *      the price — an LLM-emitted unit is overridden, never honored.
 *   2. An UNCATALOGUED line gains no unit at all. The model can copy a unit
 *      out of the `name | unit | price` catalog table
 *      (`buildCatalogPromptSection`) and staple it to a line that resolves to
 *      nothing; that unit is invented and must not reach the row.
 *
 * Runs only under `npm run test:integration` (Docker-gated).
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

/** Stands in for the gateway only — every other layer is the real one. */
function mockGateway(jsonContent: string): LLMGateway {
  return {
    complete: vi.fn(
      async () =>
        ({
          content: jsonContent,
          model: 'mock',
          provider: 'mock',
          tokenUsage: { input: 120, output: 70, total: 190 },
          latencyMs: 41,
        }) satisfies LLMResponse,
    ),
  } as unknown as LLMGateway;
}

const CAPACITOR_PRICE_CENTS = 4250;

describe('Postgres integration — B7.5 spoken parts edit → real handler + grounding → execute → persisted unit', () => {
  let pool: Pool;
  let estimateRepo: PgEstimateRepository;
  let settingsRepo: PgSettingsRepository;
  let auditRepo: PgAuditRepository;
  let jobRepo: PgJobRepository;
  let catalogRepo: PgCatalogItemRepository;
  let tenant: { tenantId: string; userId: string };
  let jobId: string;

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
      firstName: 'Dana',
      lastName: 'Smith',
      displayName: 'Dana Smith',
      preferredChannel: 'phone',
      smsConsent: false,
      isArchived: false,
      createdBy: tenant.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const locationId = crypto.randomUUID();
    await locationRepo.create({
      id: locationId,
      tenantId: tenant.tenantId,
      customerId,
      street1: '7 Smith Way',
      city: 'Austin',
      state: 'TX',
      postalCode: '78701',
      country: 'USA',
      addressType: 'service',
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
      locationId,
      jobNumber: 'JOB-SMITH-SPOKEN-PARTS',
      summary: 'Smith — AC service',
      status: 'scheduled',
      priority: 'normal',
      createdBy: tenant.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // The tenant's price book entry the spoken part must ground to. Its
    // `unit` is the ONLY legitimate source of the persisted unit.
    await catalogRepo.create(
      createCatalogItem({
        tenantId: tenant.tenantId,
        name: '45-Microfarad Capacitor',
        category: 'Parts',
        unit: 'each',
        unitPriceCents: CAPACITOR_PRICE_CENTS,
      }),
    );
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  async function seedEstimate(jobNumberSuffix: string): Promise<string> {
    const estimateNumber = await getNextEstimateNumber(tenant.tenantId, settingsRepo);
    const estimate = await createEstimate(
      {
        tenantId: tenant.tenantId,
        jobId,
        estimateNumber,
        lineItems: [
          buildLineItem(`li-seed-${jobNumberSuffix}`, 'Diagnostic', 1, 9900, 0, true, 'labor'),
        ],
        createdBy: tenant.userId,
      },
      estimateRepo,
      auditRepo,
    );
    return estimate.id;
  }

  /**
   * Draft with the REAL task handler (real catalog repo → real
   * `groundEditActionPricing`), walk the proposal FSM, and execute through
   * the PRODUCTION registry. Returns the grounded edit-action line item so
   * callers can assert what grounding produced BEFORE persistence.
   */
  async function draftGroundApproveExecute(
    estimateId: string,
    transcript: string,
    llmJson: Record<string, unknown>,
  ): Promise<{ groundedLineItem: Record<string, unknown>; proposal: Proposal }> {
    const handler = new EstimateEditTaskHandler(
      mockGateway(JSON.stringify(llmJson)),
      estimateRepo,
      catalogRepo,
    );
    const result = await handler.handle({
      tenantId: tenant.tenantId,
      userId: tenant.userId,
      message: transcript,
    });

    expect(result.taskType).toBe('update_estimate');
    const payload = result.proposal.payload as Record<string, unknown>;
    // Repo-verified UUID reference lands on payload.estimateId (verify-or-gate).
    expect(payload.estimateId).toBe(estimateId);
    const actions = payload.editActions as Array<Record<string, unknown>>;
    expect(actions).toHaveLength(1);
    const groundedLineItem = actions[0].lineItem as Record<string, unknown>;

    let proposal: Proposal = result.proposal;
    if (proposal.status !== 'approved') {
      proposal = transitionProposal(proposal, 'ready_for_review', tenant.userId);
      proposal = transitionProposal(proposal, 'approved', tenant.userId);
    }
    proposal = { ...proposal, approvedAt: new Date(Date.now() - UNDO_WINDOW_MS - 100) };

    const proposalRepo = new InMemoryProposalRepository();
    const executionRepo = new InMemoryProposalExecutionRepository();
    // PRODUCTION registry — the same wiring app.ts uses, so this proves the
    // registered UpdateEstimateExecutionHandler carries the unit, not a
    // hand-constructed handler.
    const handlers = createExecutionHandlerRegistry({ estimateRepo, auditRepo, jobRepo });
    const guard = new IdempotencyGuard(executionRepo, proposalRepo);
    const executor = new ProposalExecutor(handlers, proposalRepo, guard, auditRepo);
    await proposalRepo.create(proposal);

    const context: ExecutionContext = { tenantId: tenant.tenantId, executedBy: tenant.userId };
    const { result: execResult } = await executor.execute(proposal, context);
    expect(execResult.success).toBe(true);
    expect(execResult.resultEntityId).toBe(estimateId);

    return { groundedLineItem, proposal };
  }

  it('"Add three 45-microfarad capacitors" persists the catalog unit on the line-item row', async () => {
    const estimateId = await seedEstimate('a');

    // What the extraction step produces for the transcript. The drafted
    // price (4200) is deliberately a NEAR miss of the catalog price (4250) —
    // inside the "did you mean" tolerance — so a persisted 4250 proves the
    // catalog price won without tripping the price-conflict carve-out.
    const { groundedLineItem } = await draftGroundApproveExecute(
      estimateId,
      'Add three 45-microfarad capacitors to that estimate',
      {
        estimateReference: estimateId,
        editActions: [
          {
            type: 'add_line_item',
            lineItem: {
              description: '45-microfarad capacitor',
              quantity: 3,
              unitPrice: 4200,
            },
          },
        ],
        confidence_score: 0.93,
      },
    );

    // 1) Grounding produced the unit (this is the rung that was missing).
    expect(groundedLineItem.unit).toBe('each');
    expect(groundedLineItem.pricingSource).toBe('catalog');
    expect(groundedLineItem.unitPrice).toBe(CAPACITOR_PRICE_CENTS);

    // 2) The COLUMN really holds it — not the row mapper defaulting.
    const { rows } = await pool.query(
      `SELECT description, quantity, unit, unit_price_cents, total_cents, pricing_source
         FROM estimate_line_items
        WHERE estimate_id = $1 AND description = $2`,
      [estimateId, '45-Microfarad Capacitor'],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].unit).toBe('each');
    expect(rows[0].pricing_source).toBe('catalog');
    // Money stays integer cents and is unaffected by the unit.
    expect(Number(rows[0].unit_price_cents)).toBe(CAPACITOR_PRICE_CENTS);
    expect(Number(rows[0].total_cents)).toBe(3 * CAPACITOR_PRICE_CENTS);

    // 3) And it survives the read path (row mapper → domain object).
    const reloaded = await estimateRepo.findById(tenant.tenantId, estimateId);
    const line = reloaded!.lineItems.find((l) => l.description === '45-Microfarad Capacitor');
    expect(line!.unit).toBe('each');
    expect(line!.quantity).toBe(3);
    expect(line!.unitPriceCents).toBe(CAPACITOR_PRICE_CENTS);
    expect(line!.totalCents).toBe(3 * CAPACITOR_PRICE_CENTS);
    // Descriptive-only invariant, at the row level: the estimate subtotal is
    // the seeded 9900 + qty × price, with nothing derived from the unit.
    expect(reloaded!.totals.subtotalCents).toBe(9900 + 3 * CAPACITOR_PRICE_CENTS);
  });

  it('emits exactly one estimate.updated audit event for the spoken parts edit', async () => {
    const estimateId = await seedEstimate('b');
    await draftGroundApproveExecute(
      estimateId,
      'Add three 45-microfarad capacitors to that estimate',
      {
        estimateReference: estimateId,
        editActions: [
          {
            type: 'add_line_item',
            lineItem: { description: '45-microfarad capacitor', quantity: 3, unitPrice: 4200 },
          },
        ],
        confidence_score: 0.93,
      },
    );

    const { rows } = await pool.query(
      `SELECT event_type, actor_id FROM audit_events
        WHERE tenant_id = $1 AND event_type = 'estimate.updated'
          AND entity_type = 'estimate' AND entity_id = $2`,
      [tenant.tenantId, estimateId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].actor_id).toBe(tenant.userId);
  });

  it('the CATALOG unit wins: an LLM-emitted unit never overrides it', async () => {
    const estimateId = await seedEstimate('c');

    // The edit prompt hands the model a `name | unit | price` catalog table,
    // so it can emit a unit of its own. Here it emits the WRONG one.
    const { groundedLineItem } = await draftGroundApproveExecute(
      estimateId,
      'Add three 45-microfarad capacitors to that estimate',
      {
        estimateReference: estimateId,
        editActions: [
          {
            type: 'add_line_item',
            lineItem: {
              description: '45-microfarad capacitor',
              quantity: 3,
              unit: 'hour',
              unitPrice: 4200,
            },
          },
        ],
        confidence_score: 0.93,
      },
    );

    expect(groundedLineItem.unit).toBe('each');

    const { rows } = await pool.query(
      `SELECT unit FROM estimate_line_items
        WHERE estimate_id = $1 AND description = $2`,
      [estimateId, '45-Microfarad Capacitor'],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].unit).toBe('each');
  });

  it('an UNCATALOGUED spoken line gains no invented unit (column stays NULL)', async () => {
    const estimateId = await seedEstimate('d');

    const { groundedLineItem } = await draftGroundApproveExecute(
      estimateId,
      'Add a bespoke flux manifold for eighty dollars to that estimate',
      {
        estimateReference: estimateId,
        editActions: [
          {
            type: 'add_line_item',
            lineItem: {
              description: 'Bespoke flux manifold',
              quantity: 1,
              // Copied out of the catalog table for an item that is NOT in
              // the catalog — invented, and must not reach the row.
              unit: 'each',
              unitPrice: 8000,
            },
          },
        ],
        confidence_score: 0.93,
      },
    );

    // Grounding refused to trust the line: no unit, price flagged.
    expect(groundedLineItem.unit).toBeUndefined();
    expect(groundedLineItem.pricingSource).toBe('uncatalogued');
    expect(groundedLineItem.needsPricing).toBe(true);

    const { rows } = await pool.query(
      `SELECT unit, unit_price_cents FROM estimate_line_items
        WHERE estimate_id = $1 AND description = $2`,
      [estimateId, 'Bespoke flux manifold'],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].unit).toBeNull();
    // The spoken price still rides through (human-reviewed, never
    // auto-approved) — only the ungrounded UNIT is dropped.
    expect(Number(rows[0].unit_price_cents)).toBe(8000);
  });

  it('cross-tenant negative: another tenant can neither read the estimate nor edit it through the handler', async () => {
    const estimateId = await seedEstimate('e');
    await draftGroundApproveExecute(
      estimateId,
      'Add three 45-microfarad capacitors to that estimate',
      {
        estimateReference: estimateId,
        editActions: [
          {
            type: 'add_line_item',
            lineItem: { description: '45-microfarad capacitor', quantity: 3, unitPrice: 4200 },
          },
        ],
        confidence_score: 0.93,
      },
    );

    const other = await createTestTenant(pool);
    expect(await estimateRepo.findById(other.tenantId, estimateId)).toBeNull();

    const handler = new UpdateEstimateExecutionHandler(
      estimateRepo,
      auditRepo,
      undefined,
      undefined,
      jobRepo,
    );
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
              lineItem: {
                description: 'Should Not Land',
                quantity: 1,
                unit: 'each',
                unitPrice: 100,
              },
            },
          ],
        },
        status: 'approved',
        summary: 'cross-tenant attempt',
        createdBy: other.userId,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as Proposal,
      { tenantId: other.tenantId, executedBy: other.userId },
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not found in this tenant/);

    // And nothing landed on tenant A's estimate.
    const { rows } = await pool.query(
      `SELECT 1 FROM estimate_line_items WHERE estimate_id = $1 AND description = $2`,
      [estimateId, 'Should Not Land'],
    );
    expect(rows).toHaveLength(0);
  });
});
