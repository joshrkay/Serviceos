/**
 * U1 (voice back-office workflows) — money-loop reference resolution,
 * end-to-end against real Postgres.
 *
 * The router's entity resolver resolves a spoken document reference ("chase
 * the Smith invoice", "add a $25 late fee") and threads the unique verified
 * match onto `existingEntities.invoiceId` (workers/voice-action-router.ts,
 * annotation.resolved). Before U1 the collections task handlers ignored that
 * seam and gated invoiceId UNCONDITIONALLY, so every resolved spoken request
 * still dead-ended into the review UI. This file proves the finished loop
 * with EXECUTED EFFECTS (P-44), never proposal shape alone:
 *
 *   1. send_invoice — resolver-seam draft is ungated; approve → execute via
 *      the PRODUCTION registry dispatches exactly the resolved invoice and
 *      the executor writes the `proposal.executed` audit row to Postgres.
 *   2. apply_late_fee — resolver-seam draft (integer cents, "twenty-five
 *      dollars" → 2500) is ungated; approve → execute appends the
 *      non-taxable 'Late fee' line to the REAL invoice row, bumps
 *      amount_due, emits `invoice.late_fee_applied`; re-running the handler
 *      never double-charges (deterministic fee-line id).
 *   3. Cross-tenant negative — another tenant executing a forged
 *      apply_late_fee against tenant A's invoice fails closed (tenant-scoped
 *      repo + RLS under RLS_RUNTIME_ROLE=true), tenant A's invoice is
 *      untouched, and no audit rows land under the forging tenant.
 *
 * Harness mirrors test/integration/reschedule-appointment-voice.test.ts:
 * REAL task handler → transitionProposal → ProposalExecutor with the
 * PRODUCTION createExecutionHandlerRegistry (never handlers constructed
 * ad-hoc), real Pg repositories for every DB touch.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { PgInvoiceRepository } from '../../src/invoices/pg-invoice';
import { PgJobRepository } from '../../src/jobs/pg-job';
import { PgCustomerRepository } from '../../src/customers/pg-customer';
import { PgLocationRepository } from '../../src/locations/pg-location';
import { PgAuditRepository } from '../../src/audit/pg-audit';
import {
  SendInvoiceTaskHandler,
  ApplyLateFeeTaskHandler,
} from '../../src/ai/tasks/voice-extended-tasks';
import { NoopInvoiceDeliveryProvider } from '../../src/proposals/execution/voice-extended-handlers';
import { TaskContext } from '../../src/ai/tasks/task-handlers';
import {
  createProposal,
  missingFieldsFor,
  InMemoryProposalRepository,
  Proposal,
} from '../../src/proposals/proposal';
import { InMemoryProposalExecutionRepository } from '../../src/proposals/proposal-execution';
import { transitionProposal, UNDO_WINDOW_MS } from '../../src/proposals/lifecycle';
import { ProposalExecutor } from '../../src/proposals/execution/executor';
import { IdempotencyGuard } from '../../src/proposals/execution/idempotency';
import {
  ExecutionContext,
  ExecutionResult,
  createExecutionHandlerRegistry,
} from '../../src/proposals/execution/handlers';
import { buildLineItem, calculateDocumentTotals } from '../../src/shared/billing-engine';

const BASE_INVOICE_CENTS = 10000;
const SPOKEN_FEE_CENTS = 2500; // "twenty-five dollars" — integer cents end-to-end

describe('Integration — U1 voice collections resolution → execution (real Postgres)', () => {
  let pool: Pool;
  let invoiceRepo: PgInvoiceRepository;
  let jobRepo: PgJobRepository;
  let customerRepo: PgCustomerRepository;
  let locationRepo: PgLocationRepository;
  let auditRepo: PgAuditRepository;

  beforeAll(async () => {
    pool = await getSharedTestDb();
    invoiceRepo = new PgInvoiceRepository(pool);
    jobRepo = new PgJobRepository(pool);
    customerRepo = new PgCustomerRepository(pool);
    locationRepo = new PgLocationRepository(pool);
    auditRepo = new PgAuditRepository(pool);
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  /** Seed customer → location → job → OPEN invoice; returns the invoice id. */
  async function seedOpenInvoice(tenantId: string, userId: string): Promise<string> {
    const customerId = crypto.randomUUID();
    await customerRepo.create({
      id: customerId,
      tenantId,
      firstName: 'Smith',
      lastName: 'Customer',
      displayName: 'Smith',
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
      street1: '7 Collections Ct',
      city: 'Austin',
      state: 'TX',
      postalCode: '78701',
      country: 'USA',
      isPrimary: true,
      addressType: 'service',
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
      jobNumber: `JOB-COLL-${jobId.slice(0, 8)}`,
      summary: 'Smith collections job',
      status: 'completed',
      priority: 'normal',
      createdBy: userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const lineItems = [
      buildLineItem(crypto.randomUUID(), 'Service call', 1, BASE_INVOICE_CENTS, 0, true, 'labor'),
    ];
    const totals = calculateDocumentTotals(lineItems, 0, 0);
    const invoiceId = crypto.randomUUID();
    await invoiceRepo.create({
      id: invoiceId,
      tenantId,
      jobId,
      invoiceNumber: `INV-${invoiceId.slice(0, 8)}`,
      status: 'open',
      lineItems,
      totals,
      amountPaidCents: 0,
      amountDueCents: totals.totalCents,
      createdBy: userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    return invoiceId;
  }

  /**
   * Resolver-seam TaskContext: `existingEntities.invoiceId` is exactly what
   * workers/voice-action-router.ts threads after the entity resolver
   * uniquely resolved the spoken reference (annotation.resolved.invoiceId).
   */
  function resolvedContext(
    tenantId: string,
    userId: string,
    message: string,
    entities: Record<string, unknown>,
  ): TaskContext {
    return { tenantId, userId, message, existingEntities: entities };
  }

  async function approveAndExecute(
    draft: Proposal,
    userId: string,
    registryDeps: Parameters<typeof createExecutionHandlerRegistry>[0],
  ): Promise<{ proposal: Proposal; result: ExecutionResult }> {
    let proposal = transitionProposal(draft, 'ready_for_review', userId);
    proposal = transitionProposal(proposal, 'approved', userId);
    proposal = { ...proposal, approvedAt: new Date(Date.now() - UNDO_WINDOW_MS - 100) };

    const proposalRepo = new InMemoryProposalRepository();
    const executionRepo = new InMemoryProposalExecutionRepository();
    // PRODUCTION registry — same construction app.ts uses.
    const handlers = createExecutionHandlerRegistry(registryDeps);
    const guard = new IdempotencyGuard(executionRepo, proposalRepo);
    const executor = new ProposalExecutor(handlers, proposalRepo, guard, auditRepo);
    await proposalRepo.create(proposal);

    const context: ExecutionContext = { tenantId: proposal.tenantId, executedBy: userId };
    const { result, proposal: executed } = await executor.execute(proposal, context);
    return { proposal: executed, result };
  }

  it('send_invoice: resolver-verified invoiceId drafts ungated; execution dispatches THAT invoice and writes proposal.executed to audit_events', async () => {
    const tenant = await createTestTenant(pool);
    const invoiceId = await seedOpenInvoice(tenant.tenantId, tenant.userId);

    const { proposal: draft } = await new SendInvoiceTaskHandler({ invoiceRepo }).handle(
      resolvedContext(tenant.tenantId, tenant.userId, 'Send the Smith invoice', {
        jobReference: 'the Smith invoice',
        invoiceId, // resolver seam — unique verified match
      }),
    );
    expect(draft.proposalType).toBe('send_invoice');
    expect(missingFieldsFor(draft)).toEqual([]);
    expect(draft.payload.invoiceId).toBe(invoiceId);
    // Comms class — even fully resolved, drafting never auto-approves.
    expect(draft.status).toBe('draft');

    const provider = new NoopInvoiceDeliveryProvider();
    const { proposal, result } = await approveAndExecute(draft, tenant.userId, {
      invoiceRepo,
      auditRepo,
      invoiceDeliveryProvider: provider,
    });
    expect(result.success).toBe(true);

    // Executed effect #1 — the dispatch left through the provider for
    // exactly the resolved invoice in the right tenant.
    expect(provider.lastDispatch).toMatchObject({
      tenantId: tenant.tenantId,
      invoiceId,
      channel: 'email',
    });

    // Executed effect #2 — the executor's terminal audit row is in Postgres.
    const { rows } = await pool.query(
      `SELECT event_type, actor_id, metadata
         FROM audit_events
        WHERE tenant_id = $1 AND event_type = 'proposal.executed'
          AND entity_type = 'proposal' AND entity_id = $2`,
      [tenant.tenantId, proposal.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].actor_id).toBe(tenant.userId);
    expect(rows[0].metadata.proposalType).toBe('send_invoice');
  });

  it('apply_late_fee: resolver-verified invoiceId + spoken cents draft ungated; execution appends the fee line to the REAL invoice row + audit, idempotently', async () => {
    const tenant = await createTestTenant(pool);
    const invoiceId = await seedOpenInvoice(tenant.tenantId, tenant.userId);

    const { proposal: draft } = await new ApplyLateFeeTaskHandler().handle(
      resolvedContext(tenant.tenantId, tenant.userId, 'Add a twenty-five dollar late fee to the Smith invoice', {
        jobReference: 'the Smith invoice',
        invoiceId, // resolver seam
        amount: SPOKEN_FEE_CENTS,
      }),
    );
    expect(missingFieldsFor(draft)).toEqual([]);
    expect(draft.payload.invoiceId).toBe(invoiceId);
    expect(draft.payload.feeCents).toBe(SPOKEN_FEE_CENTS);
    // Money class — never auto-approves.
    expect(draft.status).toBe('draft');

    const { result } = await approveAndExecute(draft, tenant.userId, {
      invoiceRepo,
      auditRepo,
    });
    expect(result.success).toBe(true);
    expect(result.resultEntityId).toBe(invoiceId);

    // Executed effect — the PERSISTED invoice row (real columns, real
    // totals math) carries the non-taxable fee line and the bumped balance.
    const updated = await invoiceRepo.findById(tenant.tenantId, invoiceId);
    expect(updated).not.toBeNull();
    const feeLine = updated!.lineItems.find((li) => li.description === 'Late fee');
    expect(feeLine).toBeDefined();
    expect(feeLine!.unitPriceCents).toBe(SPOKEN_FEE_CENTS);
    expect(feeLine!.taxable).toBe(false);
    expect(updated!.amountDueCents).toBe(BASE_INVOICE_CENTS + SPOKEN_FEE_CENTS);

    const { rows } = await pool.query(
      `SELECT actor_id, metadata FROM audit_events
        WHERE tenant_id = $1 AND event_type = 'invoice.late_fee_applied'
          AND entity_type = 'invoice' AND entity_id = $2`,
      [tenant.tenantId, invoiceId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].metadata.feeCents).toBe(SPOKEN_FEE_CENTS);
    expect(rows[0].metadata.stepKey).toBe('manual');

    // Idempotency — re-running the registered handler with the same payload
    // (deterministic late-fee line id) can never double-charge.
    const handlers = createExecutionHandlerRegistry({ invoiceRepo, auditRepo });
    const rerun = await handlers.get('apply_late_fee')!.execute(
      { ...draft, payload: draft.payload },
      { tenantId: tenant.tenantId, executedBy: tenant.userId },
    );
    expect(rerun.success).toBe(true);
    const after = await invoiceRepo.findById(tenant.tenantId, invoiceId);
    expect(after!.lineItems.filter((li) => li.description === 'Late fee')).toHaveLength(1);
    expect(after!.amountDueCents).toBe(BASE_INVOICE_CENTS + SPOKEN_FEE_CENTS);
  });

  it('cross-tenant negative: another tenant cannot land a late fee on tenant A\'s invoice', async () => {
    const tenantA = await createTestTenant(pool);
    const invoiceId = await seedOpenInvoice(tenantA.tenantId, tenantA.userId);
    const tenantB = await createTestTenant(pool);

    // Read side — the tenant-scoped repo under tenant B's id sees nothing.
    expect(await invoiceRepo.findById(tenantB.tenantId, invoiceId)).toBeNull();

    // Affect side — the PRODUCTION-registered handler invoked with tenant B
    // stamped into the execution context fails closed: its tenant-scoped
    // lookup (RLS-backed under RLS_RUNTIME_ROLE=true) cannot see the row.
    const handlers = createExecutionHandlerRegistry({ invoiceRepo, auditRepo });
    const forged = createProposal({
      tenantId: tenantB.tenantId,
      proposalType: 'apply_late_fee',
      payload: { invoiceId, feeCents: SPOKEN_FEE_CENTS, stepKey: 'manual' },
      summary: 'cross-tenant late-fee attempt',
      createdBy: tenantB.userId,
    });
    const result = await handlers.get('apply_late_fee')!.execute(forged, {
      tenantId: tenantB.tenantId,
      executedBy: tenantB.userId,
    });
    expect(result.success).toBe(false);

    // Tenant A's invoice is byte-identical: no fee line, balance unchanged.
    const untouched = await invoiceRepo.findById(tenantA.tenantId, invoiceId);
    expect(untouched!.lineItems.some((li) => li.description === 'Late fee')).toBe(false);
    expect(untouched!.amountDueCents).toBe(BASE_INVOICE_CENTS);

    // And no audit rows landed under the forging tenant for that entity.
    const { rows } = await pool.query(
      `SELECT event_type FROM audit_events WHERE tenant_id = $1 AND entity_id = $2`,
      [tenantB.tenantId, invoiceId],
    );
    expect(rows).toHaveLength(0);
  });
});
