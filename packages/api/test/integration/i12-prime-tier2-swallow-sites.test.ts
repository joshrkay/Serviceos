import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { randomUUID } from 'crypto';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { Tier2FailingAuditRepository } from './tier2-failing-audit';
import { PgProposalRepository } from '../../src/proposals/pg-proposal';
import { PgProposalExecutionRepository } from '../../src/proposals/pg-proposal-execution';
import { PgAuditRepository } from '../../src/audit/pg-audit';
import type { AuditRepository } from '../../src/audit/audit';
import { ProposalExecutor } from '../../src/proposals/execution/executor';
import { IdempotencyGuard } from '../../src/proposals/execution/idempotency';
import { PgIdempotencyLockProvider } from '../../src/proposals/execution/idempotency-lock';
import type { ExecutionHandler, ExecutionResult } from '../../src/proposals/execution/handlers';
import { createProposal, type Proposal, type ProposalType } from '../../src/proposals/proposal';
import { transitionProposal } from '../../src/proposals/lifecycle';
import { PgInvoiceRepository } from '../../src/invoices/pg-invoice';
import { PgPaymentRepository } from '../../src/invoices/pg-payment';
import { PgCustomerRepository } from '../../src/customers/pg-customer';
import { PgLocationRepository } from '../../src/locations/pg-location';
import { PgJobRepository } from '../../src/jobs/pg-job';
import { recordPayment } from '../../src/invoices/payment';
import { buildLineItem, calculateDocumentTotals } from '../../src/shared/billing-engine';
import { RecordRefundExecutionHandler } from '../../src/proposals/execution/record-refund-handler';
import { LogExpenseExecutionHandler } from '../../src/proposals/execution/log-expense-handler';
import { AddMaterialExecutionHandler } from '../../src/proposals/execution/add-material-handler';
import { AddCatalogItemExecutionHandler } from '../../src/proposals/execution/add-catalog-item-handler';
import { CreateChangeOrderExecutionHandler } from '../../src/proposals/execution/create-change-order-handler';
import { CreateServiceAgreementExecutionHandler } from '../../src/proposals/execution/create-service-agreement-handler';
import {
  SendCustomerMessageExecutionHandler,
  type CustomerMessenger,
  type CustomerMessengerInput,
} from '../../src/proposals/execution/send-customer-message-handler';
import { PgExpenseRepository } from '../../src/expenses/pg-expense';
import { PgMaterialItemRepository } from '../../src/materials/pg-material-item';
import { PgCatalogItemRepository } from '../../src/catalog/pg-catalog-item';
import { PgEstimateRepository } from '../../src/estimates/pg-estimate';
import { PgSettingsRepository } from '../../src/settings/pg-settings';
import { PgAgreementRepository } from '../../src/agreements/pg-agreement';

/**
 * I12′ (§5.0b, tier 2) at REAL Postgres for the swallow-site handlers the
 * callback suite (`i12-prime-tier2-audit-best-effort.test.ts`, #1020) left
 * uncovered — #1052: `record_refund` (the money handler) and the other six
 * handlers carrying the explicit `catch (auditErr)` swallow — `log_expense`,
 * `add_material`, `add_catalog_item`, `create_change_order`,
 * `create_service_agreement`, `send_customer_message`. With the callback
 * suite, all 8 swallow-site handlers in src/proposals/execution/ are now
 * proven at a real DB.
 *
 * Each handler gets the same three tests, driven through the production
 * `ProposalExecutor` (seam) with the REAL handler and REAL Pg repositories:
 *   - control: a healthy audit store lands both tiers;
 *   - outage: `auditRepo.create` throws ONLY for the handler's tier-2 domain
 *     event — the execution commits (status `executed`, idempotency record,
 *     the handler's own mutation readable back from Postgres), the tier-1
 *     `proposal.executed` row lands, the tier-2 row is absent;
 *   - T1: one failure-injected executor serving two tenants — the outage is
 *     scoped to tenant A; tenant B keeps both tiers.
 * If a handler's swallow did NOT hold, its outage test is an `it.fails`
 * (a §5.0b violation, not a test bug).
 */

interface Tenant {
  tenantId: string;
  userId: string;
}

/** One swallow-site handler, as the three-test shape needs it. */
interface SwallowCase {
  name: string;
  proposalType: ProposalType;
  /** The handler's tier-2 domain event — the one the outage knocks out. */
  tier2EventType: string;
  handler(auditRepo: AuditRepository): ExecutionHandler;
  /** Seeds what the proposal needs and returns its payload. */
  seed(t: Tenant): Promise<Record<string, unknown>>;
  /** Where the handler writes its tier-2 row, from the execution result. */
  tier2Entity(result: ExecutionResult, payload: Record<string, unknown>): { entityType: string; entityId: string };
  /** Reads the handler's own mutation back from Postgres (the commit proof). */
  assertMutationCommitted(t: Tenant, result: ExecutionResult, payload: Record<string, unknown>): Promise<void>;
}

describe('I12′ — §5.0b tier-2 swallow sites at real Postgres (#1052)', () => {
  let pool: Pool;
  let proposalRepo: PgProposalRepository;
  let executionRepo: PgProposalExecutionRepository;
  let realAuditRepo: PgAuditRepository;
  let tenantA: Tenant;
  let tenantB: Tenant;

  beforeAll(async () => {
    pool = await getSharedTestDb();
    proposalRepo = new PgProposalRepository(pool);
    executionRepo = new PgProposalExecutionRepository(pool);
    realAuditRepo = new PgAuditRepository(pool);
    tenantA = await createTestTenant(pool);
    tenantB = await createTestTenant(pool);
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  // ── seeding helpers ──────────────────────────────────────────────────────

  async function seedCustomerJob(t: Tenant): Promise<{ customerId: string; locationId: string; jobId: string }> {
    const customerId = randomUUID();
    await new PgCustomerRepository(pool).create({
      id: customerId,
      tenantId: t.tenantId,
      firstName: 'Tier',
      lastName: 'Two',
      displayName: 'Tier Two',
      preferredChannel: 'phone',
      smsConsent: false,
      isArchived: false,
      createdBy: t.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const locationId = randomUUID();
    await new PgLocationRepository(pool).create({
      id: locationId,
      tenantId: t.tenantId,
      customerId,
      street1: '2 Audit Way',
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
    const jobId = randomUUID();
    await new PgJobRepository(pool).create({
      id: jobId,
      tenantId: t.tenantId,
      customerId,
      locationId,
      jobNumber: `JOB-${jobId.slice(0, 6)}`,
      summary: 'Tier-2 audit outage',
      status: 'scheduled',
      priority: 'normal',
      createdBy: t.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    return { customerId, locationId, jobId };
  }

  // ── the cases ────────────────────────────────────────────────────────────

  const recordRefund: SwallowCase = {
    name: 'record_refund (money)',
    proposalType: 'record_refund',
    tier2EventType: 'refund.recorded',
    handler: (auditRepo) => new RecordRefundExecutionHandler(new PgPaymentRepository(pool), auditRepo),
    async seed(t) {
      const { jobId } = await seedCustomerJob(t);
      const invoiceRepo = new PgInvoiceRepository(pool);
      const lineItems = [buildLineItem(randomUUID(), 'Diagnostic visit', 1, 45000, 0, true, 'labor')];
      const totals = calculateDocumentTotals(lineItems, 0, 0);
      const invoiceId = randomUUID();
      await invoiceRepo.create({
        id: invoiceId,
        tenantId: t.tenantId,
        jobId,
        invoiceNumber: `INV-${invoiceId.slice(0, 6)}`,
        status: 'open',
        lineItems,
        totals,
        amountPaidCents: 0,
        amountDueCents: totals.totalCents,
        createdBy: t.userId,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      await recordPayment(
        { tenantId: t.tenantId, invoiceId, amountCents: 45000, method: 'check', processedBy: t.userId },
        invoiceRepo,
        new PgPaymentRepository(pool),
      );
      return { invoiceId, amountCents: 10000, method: 'check', reason: "recharge didn't hold" };
    },
    tier2Entity: (_result, payload) => ({ entityType: 'invoice', entityId: payload.invoiceId as string }),
    async assertMutationCommitted(t, _result, payload) {
      const payments = await new PgPaymentRepository(pool).findByInvoice(t.tenantId, payload.invoiceId as string);
      expect(payments).toHaveLength(1);
      expect(payments[0].refundedAmountCents).toBe(10000);
    },
  };

  const logExpense: SwallowCase = {
    name: 'log_expense',
    proposalType: 'log_expense',
    tier2EventType: 'expense.logged',
    handler: (auditRepo) => new LogExpenseExecutionHandler(new PgExpenseRepository(pool), auditRepo),
    seed: async () => ({ description: 'Copper fittings', amountCents: 4250, category: 'materials', spentAt: '2026-09-20' }),
    tier2Entity: (result) => ({ entityType: 'expense', entityId: result.resultEntityId! }),
    async assertMutationCommitted(t, result) {
      const expense = await new PgExpenseRepository(pool).findById(t.tenantId, result.resultEntityId!);
      expect(expense).toMatchObject({ description: 'Copper fittings', amountCents: 4250, category: 'materials' });
    },
  };

  const addMaterial: SwallowCase = {
    name: 'add_material',
    proposalType: 'add_material',
    tier2EventType: 'material.requested',
    handler: (auditRepo) => new AddMaterialExecutionHandler(new PgMaterialItemRepository(pool), auditRepo),
    seed: async () => ({ description: `3/4in ball valve ${randomUUID().slice(0, 4)}`, quantity: 2 }),
    tier2Entity: (result) => ({ entityType: 'material_item', entityId: result.resultEntityId! }),
    async assertMutationCommitted(t, result, payload) {
      const pending = await new PgMaterialItemRepository(pool).listPending(t.tenantId);
      expect(pending.find((m) => m.id === result.resultEntityId)).toMatchObject({
        description: payload.description,
        quantity: 2,
      });
    },
  };

  const addCatalogItem: SwallowCase = {
    name: 'add_catalog_item',
    proposalType: 'add_catalog_item',
    tier2EventType: 'catalog_item.created',
    handler: (auditRepo) => new AddCatalogItemExecutionHandler(new PgCatalogItemRepository(pool), auditRepo),
    seed: async () => ({ name: `Drain snake service ${randomUUID().slice(0, 4)}`, unitPriceCents: 18900 }),
    tier2Entity: (result) => ({ entityType: 'catalog_item', entityId: result.resultEntityId! }),
    async assertMutationCommitted(t, result, payload) {
      const item = await new PgCatalogItemRepository(pool).findById(t.tenantId, result.resultEntityId!);
      expect(item).toMatchObject({ name: payload.name, unitPriceCents: 18900 });
    },
  };

  const createChangeOrder: SwallowCase = {
    name: 'create_change_order',
    proposalType: 'create_change_order',
    tier2EventType: 'estimate.change_order_created',
    handler: (auditRepo) =>
      new CreateChangeOrderExecutionHandler(new PgEstimateRepository(pool), new PgSettingsRepository(pool), auditRepo),
    async seed(t) {
      const { jobId } = await seedCustomerJob(t);
      return {
        jobId,
        title: 'Change order — add a shutoff valve',
        lineItems: [{ description: 'Shutoff valve', quantity: 1, unitPriceCents: 12500 }],
      };
    },
    tier2Entity: (result) => ({ entityType: 'estimate', entityId: result.resultEntityId! }),
    async assertMutationCommitted(t, result, payload) {
      const estimate = await new PgEstimateRepository(pool).findById(t.tenantId, result.resultEntityId!);
      expect(estimate).toMatchObject({ jobId: payload.jobId, isChangeOrder: true });
      expect(estimate!.totals.subtotalCents).toBe(12500);
    },
  };

  const createServiceAgreement: SwallowCase = {
    name: 'create_service_agreement',
    proposalType: 'create_service_agreement',
    tier2EventType: 'service_agreement.created',
    handler: (auditRepo) =>
      new CreateServiceAgreementExecutionHandler(
        new PgAgreementRepository(pool),
        auditRepo,
        new PgLocationRepository(pool),
      ),
    async seed(t) {
      const { customerId, locationId } = await seedCustomerJob(t);
      return {
        customerId,
        locationId,
        name: 'Comfort Club',
        recurrenceRule: 'FREQ=MONTHLY;INTERVAL=1',
        priceCents: 1900,
        startsOn: new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10),
      };
    },
    tier2Entity: (result) => ({ entityType: 'service_agreement', entityId: result.resultEntityId! }),
    async assertMutationCommitted(t, result, payload) {
      const agreement = await new PgAgreementRepository(pool).findById(t.tenantId, result.resultEntityId!);
      expect(agreement).toMatchObject({ customerId: payload.customerId, name: 'Comfort Club', priceCents: 1900 });
    },
  };

  /**
   * send_customer_message has no DB mutation — its effect is the outbound
   * send, so the messenger (the external delivery boundary) is a recorder.
   */
  const sent: CustomerMessengerInput[] = [];
  const recordingMessenger: CustomerMessenger = {
    async sendCustomMessage(input) {
      sent.push(input);
      return { dispatchId: `dispatch-${sent.length}` };
    },
  };
  const sendCustomerMessage: SwallowCase = {
    name: 'send_customer_message',
    proposalType: 'send_customer_message',
    tier2EventType: 'customer_message.sent',
    handler: (auditRepo) => new SendCustomerMessageExecutionHandler(recordingMessenger, auditRepo),
    async seed(t) {
      const { customerId } = await seedCustomerJob(t);
      return { customerId, channel: 'sms', body: `Running 15 minutes late ${randomUUID().slice(0, 4)}` };
    },
    tier2Entity: (_result, payload) => ({ entityType: 'customer', entityId: payload.customerId as string }),
    async assertMutationCommitted(t, _result, payload) {
      expect(sent.filter((m) => m.tenantId === t.tenantId && m.body === payload.body)).toHaveLength(1);
    },
  };

  const CASES: SwallowCase[] = [
    recordRefund,
    logExpense,
    addMaterial,
    addCatalogItem,
    createChangeOrder,
    createServiceAgreement,
    sendCustomerMessage,
  ];

  // ── the three-test shape ─────────────────────────────────────────────────

  function makeExecutor(c: SwallowCase, handlerAuditRepo: AuditRepository): ProposalExecutor {
    return new ProposalExecutor(
      new Map<ProposalType, ExecutionHandler>([[c.proposalType, c.handler(handlerAuditRepo)]]),
      proposalRepo,
      new IdempotencyGuard(executionRepo, proposalRepo, new PgIdempotencyLockProvider(pool)),
      // Tier 1 always goes through the REAL repository.
      realAuditRepo,
      { executionRepo },
    );
  }

  async function approved(c: SwallowCase, t: Tenant, payload: Record<string, unknown>): Promise<Proposal> {
    let proposal = createProposal({
      tenantId: t.tenantId,
      proposalType: c.proposalType,
      payload,
      summary: `I12′ ${c.name}`,
      createdBy: t.userId,
      idempotencyKey: `i12p-${randomUUID()}`,
    });
    proposal = transitionProposal(proposal, 'ready_for_review', 'test');
    proposal = transitionProposal(proposal, 'approved', 'test');
    proposal = { ...proposal, approvedAt: new Date(Date.now() - 10_000) }; // past the undo window
    return proposalRepo.create(proposal);
  }

  async function tier1Types(t: Tenant, proposalId: string): Promise<string[]> {
    return (await realAuditRepo.findByEntity(t.tenantId, 'proposal', proposalId)).map((r) => r.eventType);
  }

  async function tier2Types(t: Tenant, c: SwallowCase, result: ExecutionResult, payload: Record<string, unknown>) {
    const { entityType, entityId } = c.tier2Entity(result, payload);
    return (await realAuditRepo.findByEntity(t.tenantId, entityType, entityId)).map((r) => r.eventType);
  }

  describe.each(CASES.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    it('control: with a healthy audit store BOTH tiers land', async () => {
      const payload = await c.seed(tenantA);
      const proposal = await approved(c, tenantA, payload);
      const { proposal: after, result } = await makeExecutor(c, realAuditRepo).execute(proposal, {
        tenantId: tenantA.tenantId,
        executedBy: tenantA.userId,
      });
      expect(result).toMatchObject({ success: true });
      expect(after.status).toBe('executed');
      expect(await tier1Types(tenantA, proposal.id)).toContain('proposal.executed');
      expect(await tier2Types(tenantA, c, result, payload)).toContain(c.tier2EventType);
    });

    it('tier-2 outage: the execution commits and tier 1 survives; the tier-2 row is absent', async () => {
      const failing = new Tier2FailingAuditRepository(realAuditRepo, c.tier2EventType);
      const payload = await c.seed(tenantA);
      const proposal = await approved(c, tenantA, payload);
      const { result } = await makeExecutor(c, failing).execute(proposal, {
        tenantId: tenantA.tenantId,
        executedBy: tenantA.userId,
      });
      expect(result).toMatchObject({ success: true });
      expect(failing.attemptedTier2).toBe(1);

      // Committed: status + idempotency record in Postgres, and the handler's own write.
      expect((await proposalRepo.findById(tenantA.tenantId, proposal.id))?.status).toBe('executed');
      expect(await executionRepo.findByIdempotencyKey(tenantA.tenantId, proposal.idempotencyKey!)).not.toBeNull();
      await c.assertMutationCommitted(tenantA, result, payload);

      expect(await tier1Types(tenantA, proposal.id)).toContain('proposal.executed');
      expect(await tier2Types(tenantA, c, result, payload)).not.toContain(c.tier2EventType);
    });

    it("T1 — a second tenant through the SAME failure-injected executor keeps both tiers", async () => {
      const failing = new Tier2FailingAuditRepository(realAuditRepo, c.tier2EventType, tenantA.tenantId);
      const executor = makeExecutor(c, failing);

      const aPayload = await c.seed(tenantA);
      const aProposal = await approved(c, tenantA, aPayload);
      const a = await executor.execute(aProposal, { tenantId: tenantA.tenantId, executedBy: tenantA.userId });
      expect(a.result).toMatchObject({ success: true });
      expect(failing.attemptedTier2).toBe(1);

      const bPayload = await c.seed(tenantB);
      const bProposal = await approved(c, tenantB, bPayload);
      const b = await executor.execute(bProposal, { tenantId: tenantB.tenantId, executedBy: tenantB.userId });
      expect(b.result).toMatchObject({ success: true });
      expect(failing.attemptedTier2).toBe(1);

      expect(await tier2Types(tenantB, c, b.result, bPayload)).toContain(c.tier2EventType);
      expect(await tier1Types(tenantB, bProposal.id)).toContain('proposal.executed');
      expect(await tier2Types(tenantA, c, a.result, aPayload)).not.toContain(c.tier2EventType);
      // Neither tenant can read the other's tier-1 row.
      expect(await tier1Types(tenantA, bProposal.id)).toEqual([]);
      expect(await tier1Types(tenantB, aProposal.id)).toEqual([]);
    });
  });
});
