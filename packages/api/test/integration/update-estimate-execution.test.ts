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
 * WHY THE DRAFTING LEG IS DRIVEN BY A SENTENCE, NOT A UUID. This file used to
 * hand the handler `estimateReference: <the seeded estimate's UUID>`. No
 * spoken sentence produces a UUID — the operator says "the Garcia estimate" —
 * so the leg that had to work in production (spoken reference → resolved
 * estimate → gate lifted) was never exercised, and it did not work: the
 * resolver's estimate path was exact-document-number only, and
 * `resolveEstimateIdGate` returned `missingFields:['estimateId']` for every
 * free-text reference. Both are fixed; this file is the proof, so it now
 * speaks and lets the REAL PgEntityResolver do the resolving.
 *
 * Rule 3 of docs/solutions/test-failures/a-fixture-arranged-to-pass-proves-
 * nothing.md is applied deliberately: the scripted drafting reply carries a
 * HALLUCINATED `estimateId`, so "the payload carries the RESOLVER's id" can
 * only pass if resolution actually beat the model.
 *
 * The seed is what a real tenant looks like, and nothing in it is arranged to
 * match a query: the customer's name lives on the CUSTOMER row, the job
 * summary describes the WORK ("AC condenser replacement"), and the estimate's
 * `customer_message` is an ordinary note that never mentions the surname —
 * which is exactly the planting that made the nudge suite a false green.
 *
 * Proves:
 *   1. "Add two hours of labor to the Garcia estimate" resolves through the
 *      REAL PgEntityResolver (customer → jobs → estimates) to the seeded
 *      estimate, lifts the drafting gate, and the drafted payload carries the
 *      RESOLVED id rather than the model's invented one.
 *   2. That payload → approve → execute via the registered
 *      UpdateEstimateExecutionHandler persists the new line (quantity 2, unit
 *      'hour') and recomputes totals correctly (integer cents).
 *   3. Exactly one estimate.updated audit event is emitted.
 *   4. Cross-tenant negatives: the spoken reference does not resolve from
 *      another tenant, and the estimate is not readable/editable by another
 *      tenant's scoped calls.
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
import { PgEntityResolver } from '../../src/ai/resolution/pg-entity-resolver';
import { resolveVoiceEntityReferences } from '../../src/ai/agents/customer-calling/entity-resolution';
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

interface SeededEstimate {
  estimateId: string;
  customerId: string;
  jobId: string;
  subtotalBefore: number;
}

describe('Postgres integration — spoken update_estimate → resolve → draft → approve → execute', () => {
  let pool: Pool;
  let estimateRepo: PgEstimateRepository;
  let settingsRepo: PgSettingsRepository;
  let auditRepo: PgAuditRepository;
  let jobRepo: PgJobRepository;
  let catalogRepo: PgCatalogItemRepository;
  let customerRepo: PgCustomerRepository;
  let locationRepo: PgLocationRepository;
  let entityResolver: PgEntityResolver;
  let tenant: { tenantId: string; userId: string };
  let catalogPriceCents: number;

  beforeAll(async () => {
    pool = await getSharedTestDb();
    estimateRepo = new PgEstimateRepository(pool);
    settingsRepo = new PgSettingsRepository(pool);
    auditRepo = new PgAuditRepository(pool);
    jobRepo = new PgJobRepository(pool);
    catalogRepo = new PgCatalogItemRepository(pool);
    customerRepo = new PgCustomerRepository(pool);
    locationRepo = new PgLocationRepository(pool);
    entityResolver = new PgEntityResolver(pool);
    tenant = await createTestTenant(pool);

    // Catalog grounding for the drafted edit line — same money-correctness
    // contract as draft_estimate (VOX-50 / edit-action-grounding.ts). Priced
    // per HOUR, because the sentence under test says "two hours of labor".
    catalogPriceCents = 9500;
    await catalogRepo.create(
      createCatalogItem({
        tenantId: tenant.tenantId,
        name: 'Labor',
        category: 'Labor',
        unit: 'hour',
        unitPriceCents: catalogPriceCents,
      }),
    );
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  /**
   * A realistic tenant record set for ONE customer, seeded per test.
   *
   * Per-test (rather than shared) because the resolver answers a surname
   * against ALL of that customer's estimates: reusing one customer across
   * three tests would leave the third speaking a reference that genuinely
   * matches three estimates, which the resolver correctly calls `ambiguous`.
   * Distinct surnames keep each test's reference unambiguous for the honest
   * reason — the tenant really does have one Garcia estimate — instead of by
   * arrangement. (The ambiguity and overflow postures are pinned at the
   * resolver level in test/integration/entity-resolution.test.ts.)
   */
  async function seedCustomerWithEstimate(
    surname: string,
    tenantId = tenant.tenantId,
    userId = tenant.userId,
  ): Promise<SeededEstimate> {
    const customerId = crypto.randomUUID();
    await customerRepo.create({
      id: customerId,
      tenantId,
      firstName: 'Marisol',
      lastName: surname,
      displayName: `Marisol ${surname}`,
      preferredChannel: 'phone',
      smsConsent: false,
      isArchived: false,
      createdBy: userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const locId = crypto.randomUUID();
    await locationRepo.create({
      id: locId,
      tenantId,
      customerId,
      street1: '99 Bergamot Ave',
      city: 'Austin',
      state: 'TX',
      postalCode: '78701',
      country: 'USA',
      isPrimary: true,
      isArchived: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const jobId = crypto.randomUUID();
    await jobRepo.create({
      id: jobId,
      tenantId,
      customerId,
      locationId: locId,
      jobNumber: `JOB-${surname.toUpperCase()}-1`,
      // The summary says what the WORK is, the way a dispatcher writes one.
      // The customer's name appears NOWHERE on the job or the estimate.
      summary: 'AC condenser replacement',
      status: 'scheduled',
      priority: 'normal',
      createdBy: userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const estimateNumber = await getNextEstimateNumber(tenantId, settingsRepo);
    const estimate = await createEstimate(
      {
        tenantId,
        jobId,
        estimateNumber,
        lineItems: [buildLineItem('li-seed', 'Existing Line', 1, 10000, 0, true, 'labor')],
        // An ORDINARY customer message. It deliberately does not contain the
        // surname: planting it there is the exact arrangement that made
        // estimate-nudge.test.ts a false green, and if resolution needed it,
        // that would be the finding rather than the fixture.
        customerMessage: 'Thanks for having us out today — here is the quote for the condenser work.',
        createdBy: userId,
      },
      estimateRepo,
      auditRepo,
    );
    return {
      estimateId: estimate.id,
      customerId,
      jobId,
      subtotalBefore: estimate.totals.subtotalCents,
    };
  }

  /**
   * The router-side half of production, unmocked: `planVoiceEntityLookups`
   * routes an `update_estimate` jobReference to a `kind: 'estimate'` lookup
   * (ESTIMATE_DOC_INTENTS) and `PgEntityResolver` answers it against real
   * Postgres. Exactly what workers/voice-action-router.ts calls before
   * drafting, and the reason this test can hand the handler an
   * `existingEntities` the way the router does.
   */
  async function resolveSpokenReference(tenantId: string, spokenReference: string) {
    return resolveVoiceEntityReferences(entityResolver, {
      tenantId,
      intent: 'update_estimate',
      entities: { jobReference: spokenReference },
    });
  }

  async function speakAndExecute(
    seeded: SeededEstimate,
    spokenSentence: string,
    spokenReference: string,
  ): Promise<void> {
    const annotation = await resolveSpokenReference(tenant.tenantId, spokenReference);
    // The whole point: a SPOKEN reference — no document number, no UUID —
    // resolves to the seeded estimate through customer → jobs → estimates.
    expect(annotation.kind).toBe('ok');
    if (annotation.kind !== 'ok') return;
    expect(annotation.resolved.estimateId).toBe(seeded.estimateId);

    // Rule 3: an id the model invented from nowhere. If the drafted payload
    // ends up carrying this, resolution lost and the assertion below fails.
    const hallucinatedEstimateId = crypto.randomUUID();
    const gateway = mockGateway(
      JSON.stringify({
        // Free text, exactly what the operator said — NOT an id.
        estimateReference: spokenReference,
        estimateId: hallucinatedEstimateId,
        editActions: [
          {
            type: 'add_line_item',
            // The drafted price (9400) deliberately differs (within snap
            // tolerance) from the seeded catalog price (9500), so a persisted
            // 9500 proves the catalog price won, not the LLM's.
            lineItem: { description: 'Labor', quantity: 2, unitPrice: 9400 },
          },
        ],
        confidence_score: 0.92,
      }),
    );

    const handler = new EstimateEditTaskHandler(gateway, estimateRepo, catalogRepo);
    const result = await handler.handle({
      tenantId: tenant.tenantId,
      userId: tenant.userId,
      message: spokenSentence,
      // Threaded the way voice-action-router.ts threads it.
      existingEntities: { ...annotation.resolved },
    });

    expect(result.taskType).toBe('update_estimate');
    expect(result.proposal.proposalType).toBe('update_estimate');
    const draftedPayload = result.proposal.payload as Record<string, unknown>;
    // Resolution beat the model: the RESOLVED id rides the payload.
    expect(draftedPayload.estimateId).toBe(seeded.estimateId);
    expect(draftedPayload.estimateId).not.toBe(hallucinatedEstimateId);
    // The gate is LIFTED — this is what a free-text reference could never do
    // before. Without it the proposal is unapprovable and execution is
    // unreachable, so every assertion below depends on it.
    expect(result.proposal.missingFields ?? []).not.toContain('estimateId');
    // Repo-confirmed, so it rides the B4 allowlist past dropUnverifiedIds.
    const sourceContext = result.proposal.sourceContext as
      | { verifiedIds?: Record<string, string> }
      | undefined;
    expect(sourceContext?.verifiedIds?.estimateId).toBe(seeded.estimateId);

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
    expect(execResult.resultEntityId).toBe(seeded.estimateId);
  }

  it('"Add two hours of labor to the Garcia estimate" persists the line (qty 2, unit hour) and recomputes totals in integer cents', async () => {
    const seeded = await seedCustomerWithEstimate('Garcia');
    await speakAndExecute(
      seeded,
      'Add two hours of labor to the Garcia estimate',
      'the Garcia estimate',
    );

    const { rows: lineRows } = await pool.query(
      `SELECT description, quantity, unit, unit_price_cents, total_cents, pricing_source
         FROM estimate_line_items WHERE estimate_id = $1 ORDER BY sort_order`,
      [seeded.estimateId],
    );
    expect(lineRows).toHaveLength(2);
    expect(lineRows[0].description).toBe('Existing Line');
    const addedLine = lineRows[1];
    expect(addedLine.description).toBe('Labor');
    // B7.5 — the spoken quantity and the catalog unit both survive to the row.
    expect(Number(addedLine.quantity)).toBe(2);
    expect(addedLine.unit).toBe('hour');
    expect(Number(addedLine.unit_price_cents)).toBe(catalogPriceCents);
    expect(Number(addedLine.total_cents)).toBe(2 * catalogPriceCents);
    expect(addedLine.pricing_source).toBe('catalog');

    const { rows: estRows } = await pool.query(
      `SELECT subtotal_cents, total_cents, version FROM estimates WHERE id = $1`,
      [seeded.estimateId],
    );
    expect(estRows).toHaveLength(1);
    expect(Number(estRows[0].subtotal_cents)).toBe(seeded.subtotalBefore + 2 * catalogPriceCents);
    expect(Number(estRows[0].total_cents)).toBe(seeded.subtotalBefore + 2 * catalogPriceCents);
    // Optimistic-lock version bumped by the edit.
    expect(Number(estRows[0].version)).toBe(2);
  });

  it('emits exactly one estimate.updated audit event', async () => {
    const seeded = await seedCustomerWithEstimate('Okonkwo');
    await speakAndExecute(
      seeded,
      'Add two hours of labor to the Okonkwo estimate',
      'the Okonkwo estimate',
    );

    const { rows } = await pool.query(
      `SELECT event_type FROM audit_events
        WHERE tenant_id = $1 AND event_type = 'estimate.updated'
          AND entity_type = 'estimate' AND entity_id = $2`,
      [tenant.tenantId, seeded.estimateId],
    );
    expect(rows).toHaveLength(1);
  });

  it('cross-tenant negative: the spoken reference does not resolve from another tenant, and the estimate is not readable or editable there', async () => {
    const seeded = await seedCustomerWithEstimate('Delacroix');
    await speakAndExecute(
      seeded,
      'Add two hours of labor to the Delacroix estimate',
      'the Delacroix estimate',
    );

    const other = await createTestTenant(pool);

    // The SAME sentence, spoken inside another tenant, resolves nothing —
    // the traversal is scoped by tenant on the estimate, the job, and the
    // customer, on top of the RLS session context.
    const foreign = await resolveSpokenReference(other.tenantId, 'the Delacroix estimate');
    expect(foreign.kind).toBe('ok');
    if (foreign.kind === 'ok') {
      expect(foreign.resolved.estimateId).toBeUndefined();
      expect(foreign.pendingReferences).toContainEqual({
        kind: 'estimate',
        reference: 'the Delacroix estimate',
      });
    }

    const found = await estimateRepo.findById(other.tenantId, seeded.estimateId);
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
          estimateId: seeded.estimateId,
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
