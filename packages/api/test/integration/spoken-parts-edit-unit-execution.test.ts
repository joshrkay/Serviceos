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
 * WHY THE DRAFTING LEG IS DRIVEN BY A SENTENCE, NOT A UUID. This file used to
 * hand the handler `estimateReference: <the seeded estimate's UUID>`. No
 * spoken sentence produces a UUID — the operator says "the Smith estimate" —
 * so the leg that had to work in production (spoken reference → resolved
 * estimate → gate lifted) was never exercised. B7.6 (9bed666) taught
 * `resolveEstimate` the customer → jobs → estimates traversal and taught
 * `EstimateEditTaskHandler` to read the router's verified id; this file now
 * speaks and lets the REAL `PgEntityResolver` do the resolving, so
 * (spoken part) × (spoken document reference) is proven end to end together,
 * not just the part in isolation.
 *
 * Rule 3 of docs/solutions/test-failures/a-fixture-arranged-to-pass-proves-
 * nothing.md is applied deliberately: the scripted drafting reply carries a
 * HALLUCINATED `estimateId`, so "the payload carries the RESOLVER's id" can
 * only pass if resolution actually beat the model.
 *
 * Each test seeds its OWN customer with a distinct surname (mirrors
 * update-estimate-execution.test.ts's `seedCustomerWithEstimate` — the
 * resolver answers a surname against ALL of that customer's estimates, so
 * reusing one customer across five tests would leave later ones speaking a
 * reference that genuinely matches several estimates, which the resolver
 * correctly calls `ambiguous` rather than resolving). Nothing in the seed is
 * arranged to match the query: the job summary describes the WORK, not the
 * customer, and the estimate's `customer_message` is an ordinary note that
 * never mentions the surname — the exact planting that made the nudge suite
 * a false green (docs/solutions/test-failures/
 * a-fixture-arranged-to-pass-proves-nothing.md).
 *
 * This test closes the gap. It drives the fixture sentence through:
 *
 *   REAL PgEntityResolver + resolveVoiceEntityReferences (the router's own
 *   resolution step) → REAL EstimateEditTaskHandler.handle() (the same
 *   handler handler-registry.ts wires for the voice worker and the
 *   assistant route), with the REAL PgCatalogItemRepository and the REAL
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
 *   2. An UNCATALOGUED line gains no INVENTED unit — but (B7.5 narrowing) a
 *      vocabulary-valid one the operator actually said survives, because a
 *      unit drawn from the catalog's own closed vocabulary is not invention
 *      the way a price is. See catalog-resolver.ts `dropOutOfVocabularyUnit`.
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
import { PgEntityResolver } from '../../src/ai/resolution/pg-entity-resolver';
import { resolveVoiceEntityReferences } from '../../src/ai/agents/customer-calling/entity-resolution';
import { LLMGateway, LLMResponse } from '../../src/ai/gateway/gateway';
import { InMemoryProposalRepository, missingFieldsFor, Proposal } from '../../src/proposals/proposal';
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

interface SeededEstimate {
  estimateId: string;
  customerId: string;
  jobId: string;
  subtotalBefore: number;
}

describe('Postgres integration — B7.5 spoken parts edit → real handler + grounding → execute → persisted unit', () => {
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

    // The tenant's price book entry the spoken part must ground to. Its
    // `unit` is the ONLY legitimate source of a CATALOG-MATCHED line's unit.
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

  /**
   * A realistic tenant record set for ONE customer, seeded per test.
   *
   * Per-test (rather than shared) because the resolver answers a surname
   * against ALL of that customer's estimates: reusing one customer across
   * five tests would leave later ones speaking a reference that genuinely
   * matches several estimates, which the resolver correctly calls
   * `ambiguous` (the overflow/ambiguity postures are pinned at the resolver
   * level in test/integration/entity-resolution.test.ts). Distinct surnames
   * keep each test's reference unambiguous for the honest reason — the
   * tenant really does have exactly one estimate for that customer — instead
   * of by arrangement.
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
      firstName: 'Dana',
      lastName: surname,
      displayName: `Dana ${surname}`,
      preferredChannel: 'phone',
      smsConsent: false,
      isArchived: false,
      createdBy: userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const locationId = crypto.randomUUID();
    await locationRepo.create({
      id: locationId,
      tenantId,
      customerId,
      street1: `7 ${surname} Way`,
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

    const jobId = crypto.randomUUID();
    await jobRepo.create({
      id: jobId,
      tenantId,
      customerId,
      locationId,
      jobNumber: `JOB-${surname.toUpperCase()}-SPOKEN-PARTS`,
      // The summary says what the WORK is; the customer's name appears
      // NOWHERE on the job or the estimate.
      summary: 'AC service',
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
        lineItems: [buildLineItem(`li-seed-${surname}`, 'Diagnostic', 1, 9900, 0, true, 'labor')],
        // An ORDINARY customer message. It deliberately does not contain the
        // surname: planting it there is the exact arrangement that made
        // estimate-nudge.test.ts a false green — see
        // docs/solutions/test-failures/a-fixture-arranged-to-pass-proves-nothing.md.
        customerMessage: 'Thanks for having us out — here is the estimate for the AC work.',
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
   * Postgres — exactly what workers/voice-action-router.ts calls before
   * drafting.
   */
  async function resolveSpokenReference(tenantId: string, spokenReference: string) {
    return resolveVoiceEntityReferences(entityResolver, {
      tenantId,
      intent: 'update_estimate',
      entities: { jobReference: spokenReference },
    });
  }

  /**
   * Draft with the REAL task handler (real catalog repo → real
   * `groundEditActionPricing`), fed the router's resolved estimate id the
   * way voice-action-router.ts feeds it, walk the proposal FSM, and execute
   * through the PRODUCTION registry. Returns the grounded edit-action line
   * item so callers can assert what grounding produced BEFORE persistence.
   */
  async function speakGroundApproveExecute(
    seeded: SeededEstimate,
    spokenSentence: string,
    spokenReference: string,
    lineItem: Record<string, unknown>,
  ): Promise<{ groundedLineItem: Record<string, unknown>; proposal: Proposal }> {
    const annotation = await resolveSpokenReference(tenant.tenantId, spokenReference);
    // The whole point: a SPOKEN reference — no document number, no UUID —
    // resolves to the seeded estimate through customer → jobs → estimates.
    expect(annotation.kind).toBe('ok');
    if (annotation.kind !== 'ok') throw new Error('expected ok resolution');
    expect(annotation.resolved.estimateId).toBe(seeded.estimateId);

    // Rule 3 (a-fixture-arranged-to-pass-proves-nothing.md): an id the model
    // invented from nowhere. If the drafted payload ends up carrying this,
    // resolution lost and the assertion below fails.
    const hallucinatedEstimateId = crypto.randomUUID();
    const handler = new EstimateEditTaskHandler(
      mockGateway(
        JSON.stringify({
          // Free text, exactly what the operator said — NOT an id.
          estimateReference: spokenReference,
          estimateId: hallucinatedEstimateId,
          editActions: [{ type: 'add_line_item', lineItem }],
          confidence_score: 0.93,
        }),
      ),
      estimateRepo,
      catalogRepo,
    );
    const result = await handler.handle({
      tenantId: tenant.tenantId,
      userId: tenant.userId,
      message: spokenSentence,
      // Threaded the way voice-action-router.ts threads it.
      existingEntities: { ...annotation.resolved },
    });

    expect(result.taskType).toBe('update_estimate');
    const payload = result.proposal.payload as Record<string, unknown>;
    // Resolution beat the model: the RESOLVED id rides the payload, never
    // the hallucinated one.
    expect(payload.estimateId).toBe(seeded.estimateId);
    expect(payload.estimateId).not.toBe(hallucinatedEstimateId);
    expect(missingFieldsFor(result.proposal)).not.toContain('estimateId');
    const sourceContext = result.proposal.sourceContext as
      | { verifiedIds?: Record<string, string> }
      | undefined;
    expect(sourceContext?.verifiedIds?.estimateId).toBe(seeded.estimateId);

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
    expect(execResult.resultEntityId).toBe(seeded.estimateId);

    return { groundedLineItem, proposal };
  }

  it('"Add three 45-microfarad capacitors to the Smith estimate" persists the catalog unit on the line-item row', async () => {
    const seeded = await seedCustomerWithEstimate('Smith');

    // What the extraction step produces for the transcript. The drafted
    // price (4200) is deliberately a NEAR miss of the catalog price (4250) —
    // inside the "did you mean" tolerance — so a persisted 4250 proves the
    // catalog price won without tripping the price-conflict carve-out.
    const { groundedLineItem } = await speakGroundApproveExecute(
      seeded,
      'Add three 45-microfarad capacitors to the Smith estimate',
      'the Smith estimate',
      { description: '45-microfarad capacitor', quantity: 3, unitPrice: 4200 },
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
      [seeded.estimateId, '45-Microfarad Capacitor'],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].unit).toBe('each');
    expect(rows[0].pricing_source).toBe('catalog');
    // Money stays integer cents and is unaffected by the unit.
    expect(Number(rows[0].unit_price_cents)).toBe(CAPACITOR_PRICE_CENTS);
    expect(Number(rows[0].total_cents)).toBe(3 * CAPACITOR_PRICE_CENTS);

    // 3) And it survives the read path (row mapper → domain object).
    const reloaded = await estimateRepo.findById(tenant.tenantId, seeded.estimateId);
    const line = reloaded!.lineItems.find((l) => l.description === '45-Microfarad Capacitor');
    expect(line!.unit).toBe('each');
    expect(line!.quantity).toBe(3);
    expect(line!.unitPriceCents).toBe(CAPACITOR_PRICE_CENTS);
    expect(line!.totalCents).toBe(3 * CAPACITOR_PRICE_CENTS);
    // Descriptive-only invariant, at the row level: the estimate subtotal is
    // the seeded 9900 + qty × price, with nothing derived from the unit.
    expect(reloaded!.totals.subtotalCents).toBe(seeded.subtotalBefore + 3 * CAPACITOR_PRICE_CENTS);
  });

  it('emits exactly one estimate.updated audit event for the spoken parts edit', async () => {
    const seeded = await seedCustomerWithEstimate('Okafor');
    await speakGroundApproveExecute(
      seeded,
      'Add three 45-microfarad capacitors to the Okafor estimate',
      'the Okafor estimate',
      { description: '45-microfarad capacitor', quantity: 3, unitPrice: 4200 },
    );

    const { rows } = await pool.query(
      `SELECT event_type, actor_id FROM audit_events
        WHERE tenant_id = $1 AND event_type = 'estimate.updated'
          AND entity_type = 'estimate' AND entity_id = $2`,
      [tenant.tenantId, seeded.estimateId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].actor_id).toBe(tenant.userId);
  });

  it('the CATALOG unit wins: an LLM-emitted unit never overrides it', async () => {
    const seeded = await seedCustomerWithEstimate('Alvarez');

    // The edit prompt hands the model a `name | unit | price` catalog table,
    // so it can emit a unit of its own. Here it emits the WRONG one.
    const { groundedLineItem } = await speakGroundApproveExecute(
      seeded,
      'Add three 45-microfarad capacitors to the Alvarez estimate',
      'the Alvarez estimate',
      { description: '45-microfarad capacitor', quantity: 3, unit: 'hour', unitPrice: 4200 },
    );

    expect(groundedLineItem.unit).toBe('each');

    const { rows } = await pool.query(
      `SELECT unit FROM estimate_line_items
        WHERE estimate_id = $1 AND description = $2`,
      [seeded.estimateId, '45-Microfarad Capacitor'],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].unit).toBe('each');
  });

  it('an UNCATALOGUED spoken line KEEPS a vocabulary-valid unit — no invented unit, but no invented drop either', async () => {
    const seeded = await seedCustomerWithEstimate('Whitfield');

    // "Bespoke flux manifold" is not in the catalog. Its spoken unit, "each",
    // IS a member of the catalog's own vocabulary (catalogUnitSchema) — a
    // bounded value, not invention — so B7.5's narrowing keeps it even
    // though the line's PRICE stays untrusted and human-reviewed.
    const { groundedLineItem } = await speakGroundApproveExecute(
      seeded,
      'Add a bespoke flux manifold for eighty dollars to the Whitfield estimate',
      'the Whitfield estimate',
      { description: 'Bespoke flux manifold', quantity: 1, unit: 'each', unitPrice: 8000 },
    );

    // Grounding refused to trust the PRICE, but the vocabulary-valid unit
    // survives.
    expect(groundedLineItem.unit).toBe('each');
    expect(groundedLineItem.pricingSource).toBe('uncatalogued');
    expect(groundedLineItem.needsPricing).toBe(true);

    const { rows } = await pool.query(
      `SELECT unit, unit_price_cents FROM estimate_line_items
        WHERE estimate_id = $1 AND description = $2`,
      [seeded.estimateId, 'Bespoke flux manifold'],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].unit).toBe('each');
    // The spoken price still rides through (human-reviewed, never
    // auto-approved) — only ever an OUT-OF-VOCABULARY unit is dropped.
    expect(Number(rows[0].unit_price_cents)).toBe(8000);
  });

  it('an UNCATALOGUED spoken line with an out-of-vocabulary unit still gains no invented unit (column stays NULL)', async () => {
    const seeded = await seedCustomerWithEstimate('Reyes');

    // "microfarads" is not a member of catalogUnitSchema — the model copied
    // it from nowhere real, so it is invented exactly like an ungrounded
    // price would be, and must not reach the row.
    const { groundedLineItem } = await speakGroundApproveExecute(
      seeded,
      'Add a bespoke flux manifold for eighty dollars to the Reyes estimate',
      'the Reyes estimate',
      { description: 'Bespoke flux manifold', quantity: 1, unit: 'microfarads', unitPrice: 8000 },
    );

    expect(groundedLineItem.unit).toBeUndefined();
    expect(groundedLineItem.pricingSource).toBe('uncatalogued');
    expect(groundedLineItem.needsPricing).toBe(true);

    const { rows } = await pool.query(
      `SELECT unit, unit_price_cents FROM estimate_line_items
        WHERE estimate_id = $1 AND description = $2`,
      [seeded.estimateId, 'Bespoke flux manifold'],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].unit).toBeNull();
    expect(Number(rows[0].unit_price_cents)).toBe(8000);
  });

  it('cross-tenant negative: the spoken reference does not resolve from another tenant, and the estimate is not readable or editable there', async () => {
    const seeded = await seedCustomerWithEstimate('Delgado');
    await speakGroundApproveExecute(
      seeded,
      'Add three 45-microfarad capacitors to the Delgado estimate',
      'the Delgado estimate',
      { description: '45-microfarad capacitor', quantity: 3, unitPrice: 4200 },
    );

    const other = await createTestTenant(pool);

    // The SAME sentence, spoken inside another tenant, resolves nothing — the
    // traversal is scoped by tenant on the estimate, the job, and the
    // customer, on top of the RLS session context.
    const foreign = await resolveSpokenReference(other.tenantId, 'the Delgado estimate');
    expect(foreign.kind).toBe('ok');
    if (foreign.kind === 'ok') {
      expect(foreign.resolved.estimateId).toBeUndefined();
      expect(foreign.pendingReferences).toContainEqual({
        kind: 'estimate',
        reference: 'the Delgado estimate',
      });
    }

    expect(await estimateRepo.findById(other.tenantId, seeded.estimateId)).toBeNull();

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
          estimateId: seeded.estimateId,
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
      [seeded.estimateId, 'Should Not Land'],
    );
    expect(rows).toHaveLength(0);
  });
});
