/**
 * #1139 money guard — `proposal_executions.executed_payload` keeps its meaning
 * for MONEY proposals: it is the payload that was actually executed (the
 * owner-edited amount / price), identical to what the money row records.
 *
 * #1139 fixed correction lessons by preserving the AI's first draft in
 * `proposals.original_payload` on the first edit (so the lesson recorder can
 * diff draft vs executed). The executor's `executedPayload` write was
 * deliberately NOT changed — the ticket named it, and it also runs for
 * payments and invoices. This file pins that, through the production
 * registry + ProposalExecutor + the real Postgres advisory lock (so both
 * executor paths run as in production: `record_payment` performs external
 * I/O → Path B; `draft_invoice` is DB-only → Path A), with an owner edit
 * made through the real `editProposal` before approval:
 *
 *   - record_payment: AI drafts 450.00, owner corrects to 400.00 → the
 *     payment row, the invoice's amount paid, and executed_payload.amountCents
 *     are all 40000.
 *   - draft_invoice: AI drafts a 115.00 labor line, owner corrects to
 *     125.00 → the invoice row line and executed_payload's line are 12500.
 *
 * T2: a neighbour tenant runs the same flows with DIVERGENT amounts and its
 * rows keep its own values.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'crypto';
import type { Pool } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { PgProposalRepository } from '../../src/proposals/pg-proposal';
import { PgProposalExecutionRepository } from '../../src/proposals/pg-proposal-execution';
import { PgInvoiceRepository } from '../../src/invoices/pg-invoice';
import { PgPaymentRepository } from '../../src/invoices/pg-payment';
import { PgSettingsRepository } from '../../src/settings/pg-settings';
import { PgJobRepository } from '../../src/jobs/pg-job';
import { PgAuditRepository } from '../../src/audit/pg-audit';
import { buildLineItem, calculateDocumentTotals } from '../../src/shared/billing-engine';
import { createProposal, type ProposalType } from '../../src/proposals/proposal';
import { editProposal, approveProposal } from '../../src/proposals/actions';
import { UNDO_WINDOW_MS } from '../../src/proposals/lifecycle';
import { createExecutionHandlerRegistry } from '../../src/proposals/execution/handlers';
import { IdempotencyGuard } from '../../src/proposals/execution/idempotency';
import { PgIdempotencyLockProvider } from '../../src/proposals/execution/idempotency-lock';
import { ProposalExecutor } from '../../src/proposals/execution/executor';

describe('#1139 money guard — executed_payload is still the executed money payload', () => {
  let pool: Pool;
  let proposalRepo: PgProposalRepository;
  let executionRepo: PgProposalExecutionRepository;
  let invoiceRepo: PgInvoiceRepository;
  let paymentRepo: PgPaymentRepository;
  let settingsRepo: PgSettingsRepository;
  let jobRepo: PgJobRepository;
  let auditRepo: PgAuditRepository;
  let executor: ProposalExecutor;

  beforeAll(async () => {
    pool = await getSharedTestDb();
    proposalRepo = new PgProposalRepository(pool);
    executionRepo = new PgProposalExecutionRepository(pool);
    invoiceRepo = new PgInvoiceRepository(pool);
    paymentRepo = new PgPaymentRepository(pool);
    settingsRepo = new PgSettingsRepository(pool);
    jobRepo = new PgJobRepository(pool);
    auditRepo = new PgAuditRepository(pool);
    const registry = createExecutionHandlerRegistry({
      invoiceRepo,
      paymentRepo,
      settingsRepo,
      jobRepo,
      auditRepo,
    });
    const guard = new IdempotencyGuard(executionRepo, proposalRepo, new PgIdempotencyLockProvider(pool));
    executor = new ProposalExecutor(registry, proposalRepo, guard, auditRepo, { executionRepo });
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  async function seedTenant(): Promise<{ tenantId: string; userId: string; customerId: string; jobId: string }> {
    const { tenantId, userId } = await createTestTenant(pool);
    await settingsRepo.create({
      id: crypto.randomUUID(),
      tenantId,
      businessName: 'Money Guard Co',
      timezone: 'America/Chicago',
      estimatePrefix: 'EST-',
      invoicePrefix: 'INV-',
      nextEstimateNumber: 1,
      nextInvoiceNumber: 1,
      defaultPaymentTermDays: 30,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const customerId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO customers (id, tenant_id, display_name, created_by) VALUES ($1, $2, 'Money Customer', $3)`,
      [customerId, tenantId, userId],
    );
    const locationId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO service_locations (id, tenant_id, customer_id, street1, city, state, postal_code)
       VALUES ($1, $2, $3, '1 Main St', 'Austin', 'TX', '78701')`,
      [locationId, tenantId, customerId],
    );
    const jobId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO jobs (id, tenant_id, customer_id, location_id, job_number, summary, created_by)
       VALUES ($1, $2, $3, $4, $5, 'Money job', $6)`,
      [jobId, tenantId, customerId, locationId, 'JOB-' + jobId.slice(0, 8), userId],
    );
    return { tenantId, userId, customerId, jobId };
  }

  async function seedOpenInvoice(tenantId: string, userId: string, jobId: string, totalCents: number): Promise<string> {
    const lineItems = [buildLineItem(crypto.randomUUID(), 'Diagnostic visit', 1, totalCents, 0, false, 'labor')];
    const totals = calculateDocumentTotals(lineItems, 0, 0);
    const invoiceId = crypto.randomUUID();
    await invoiceRepo.create({
      id: invoiceId,
      tenantId,
      jobId,
      invoiceNumber: 'INV-' + invoiceId.slice(0, 8),
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

  /** AI draft → owner edit (real editProposal) → approve → past window → execute. */
  async function editApproveExecute(
    tenantId: string,
    userId: string,
    proposalType: ProposalType,
    aiPayload: Record<string, unknown>,
    ownerEdits: Record<string, unknown>,
  ): Promise<{ proposalId: string; resultEntityId: string }> {
    const draft = createProposal({ tenantId, proposalType, payload: aiPayload, summary: 'money guard', createdBy: userId });
    await proposalRepo.create(draft);
    await editProposal(proposalRepo, tenantId, draft.id, userId, 'owner', ownerEdits, auditRepo);
    await approveProposal(proposalRepo, tenantId, draft.id, userId, 'owner', auditRepo);
    await proposalRepo.updateStatus(tenantId, draft.id, 'approved', {
      approvedAt: new Date(Date.now() - UNDO_WINDOW_MS - 100),
    });
    const approved = await proposalRepo.findById(tenantId, draft.id);
    const { result } = await executor.execute(approved!, { tenantId, executedBy: userId });
    expect(result.success, result.error).toBe(true);
    return { proposalId: draft.id, resultEntityId: result.resultEntityId! };
  }

  it('record_payment (Path B, external I/O): the owner-corrected amount is what executed_payload, the payment row and the invoice all carry — neighbour tenant (T2) keeps its own', async () => {
    const a = await seedTenant();
    const b = await seedTenant();
    const invoiceA = await seedOpenInvoice(a.tenantId, a.userId, a.jobId, 45000);
    const invoiceB = await seedOpenInvoice(b.tenantId, b.userId, b.jobId, 30000);

    const runA = await editApproveExecute(
      a.tenantId,
      a.userId,
      'record_payment',
      { invoiceId: invoiceA, amountCents: 45000, paymentMethod: 'check' },
      { amountCents: 40000 },
    );
    const runB = await editApproveExecute(
      b.tenantId,
      b.userId,
      'record_payment',
      { invoiceId: invoiceB, amountCents: 30000, paymentMethod: 'cash' },
      { amountCents: 12500 },
    );

    const executionA = await executionRepo.findLatestByProposal(a.tenantId, runA.proposalId);
    expect(executionA!.status).toBe('succeeded');
    expect(executionA!.executedPayload.amountCents).toBe(40000);
    const paymentsA = await paymentRepo.findByInvoice(a.tenantId, invoiceA);
    expect(paymentsA).toHaveLength(1);
    expect(paymentsA[0].amountCents).toBe(40000);
    expect(paymentsA[0].amountCents).toBe(executionA!.executedPayload.amountCents);
    expect((await invoiceRepo.findById(a.tenantId, invoiceA))!.amountPaidCents).toBe(40000);
    // Exactly one execution row for the one execution.
    expect(await executionRepo.listByProposal(a.tenantId, runA.proposalId)).toHaveLength(1);

    // T2
    const executionB = await executionRepo.findLatestByProposal(b.tenantId, runB.proposalId);
    expect(executionB!.executedPayload.amountCents).toBe(12500);
    const paymentsB = await paymentRepo.findByInvoice(b.tenantId, invoiceB);
    expect(paymentsB.map((p) => p.amountCents)).toEqual([12500]);
    expect((await invoiceRepo.findById(b.tenantId, invoiceB))!.amountPaidCents).toBe(12500);
    expect(await paymentRepo.findByInvoice(a.tenantId, invoiceB)).toEqual([]);
  });

  it('draft_invoice (Path A, DB-only): the owner-corrected line price is what executed_payload and the created invoice carry — neighbour tenant (T2) keeps its own', async () => {
    const a = await seedTenant();
    const b = await seedTenant();

    const runA = await editApproveExecute(
      a.tenantId,
      a.userId,
      'draft_invoice',
      { customerId: a.customerId, jobId: a.jobId, lineItems: [buildLineItem('l1', 'Labor', 1, 11500, 0, true, 'labor')] },
      { lineItems: [buildLineItem('l1', 'Labor', 1, 12500, 0, true, 'labor')] },
    );
    const runB = await editApproveExecute(
      b.tenantId,
      b.userId,
      'draft_invoice',
      { customerId: b.customerId, jobId: b.jobId, lineItems: [buildLineItem('l1', 'Labor', 1, 11500, 0, true, 'labor')] },
      { lineItems: [buildLineItem('l1', 'Labor', 2, 8000, 0, true, 'labor')] },
    );

    const executionA = await executionRepo.findLatestByProposal(a.tenantId, runA.proposalId);
    expect(executionA!.status).toBe('succeeded');
    const executedLinesA = executionA!.executedPayload.lineItems as Array<{ unitPriceCents: number; quantity: number }>;
    expect(executedLinesA[0].unitPriceCents).toBe(12500);
    const invoiceRowA = await invoiceRepo.findById(a.tenantId, runA.resultEntityId);
    expect(invoiceRowA!.lineItems[0].unitPriceCents).toBe(12500);
    expect(invoiceRowA!.lineItems[0].unitPriceCents).toBe(executedLinesA[0].unitPriceCents);
    expect(await executionRepo.listByProposal(a.tenantId, runA.proposalId)).toHaveLength(1);

    // T2
    const executionB = await executionRepo.findLatestByProposal(b.tenantId, runB.proposalId);
    const executedLinesB = executionB!.executedPayload.lineItems as Array<{ unitPriceCents: number; quantity: number }>;
    expect([executedLinesB[0].quantity, executedLinesB[0].unitPriceCents]).toEqual([2, 8000]);
    const invoiceRowB = await invoiceRepo.findById(b.tenantId, runB.resultEntityId);
    expect([invoiceRowB!.lineItems[0].quantity, invoiceRowB!.lineItems[0].unitPriceCents]).toEqual([2, 8000]);
    expect(await invoiceRepo.findById(a.tenantId, runB.resultEntityId)).toBeNull();
  });
});
