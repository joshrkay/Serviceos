/**
 * U2 — voice `create_invoice` end-to-end against real Postgres.
 *
 * A spoken "invoice the Johnson job" becomes a draft_invoice proposal that,
 * once approved, runs through the PRODUCTION execution registry
 * (createExecutionHandlerRegistry) + ProposalExecutor against Pg repos. This
 * pins the real invoice/line-item columns (mocked-DB tests can't catch schema
 * drift — CLAUDE.md) and guards the handler+registry audit wiring fix: before
 * it, the executed invoice persisted but emitted NO invoice.created event.
 *
 * Runs only under `npm run test:integration` (vitest globalSetup starts the
 * Postgres testcontainer and sets TEST_DB_URL).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { Pool } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { PgInvoiceRepository } from '../../src/invoices/pg-invoice';
import { PgJobRepository } from '../../src/jobs/pg-job';
import { PgCustomerRepository } from '../../src/customers/pg-customer';
import { PgLocationRepository } from '../../src/locations/pg-location';
import { PgSettingsRepository } from '../../src/settings/pg-settings';
import { PgAuditRepository } from '../../src/audit/pg-audit';
import { buildLineItem, calculateDocumentTotals } from '../../src/shared/billing-engine';
import { InvoiceTaskHandler } from '../../src/ai/tasks/invoice-task';
import type { LLMGateway, LLMResponse } from '../../src/ai/gateway/gateway';
import type { TaskContext } from '../../src/ai/tasks/task-handlers';
import {
  createProposal,
  CreateProposalInput,
  InMemoryProposalRepository,
  Proposal,
} from '../../src/proposals/proposal';
import { InMemoryProposalExecutionRepository } from '../../src/proposals/proposal-execution';
import { transitionProposal, UNDO_WINDOW_MS } from '../../src/proposals/lifecycle';
import { ProposalExecutor } from '../../src/proposals/execution/executor';
import { IdempotencyGuard } from '../../src/proposals/execution/idempotency';
import {
  createExecutionHandlerRegistry,
  ExecutionContext,
} from '../../src/proposals/execution/handlers';
import { CreateInvoiceExecutionHandler } from '../../src/proposals/execution/invoice-execution-handler';

describe('Postgres integration — voice draft_invoice → approve → execute → persist + audit', () => {
  let pool: Pool;
  let invoiceRepo: PgInvoiceRepository;
  let settingsRepo: PgSettingsRepository;
  let auditRepo: PgAuditRepository;
  let jobRepo: PgJobRepository;
  let tenant: { tenantId: string; userId: string };
  let customerId: string;
  let jobId: string;
  let invoiceId: string;

  async function executeDraftInvoice(): Promise<string> {
    // Build the PRODUCTION registry so this also proves the registry wires
    // auditRepo into CreateInvoiceExecutionHandler (the fix under test).
    const registry = createExecutionHandlerRegistry({
      invoiceRepo,
      settingsRepo,
      auditRepo,
      jobRepo,
    });
    const proposalRepo = new InMemoryProposalRepository();
    const executionRepo = new InMemoryProposalExecutionRepository();
    const guard = new IdempotencyGuard(executionRepo, proposalRepo);
    const executor = new ProposalExecutor(registry, proposalRepo, guard, auditRepo);

    const input: CreateProposalInput = {
      tenantId: tenant.tenantId,
      proposalType: 'draft_invoice',
      payload: {
        customerId,
        jobId,
        lineItems: [
          buildLineItem('1', 'AC Repair', 2, 7500, 1, true, 'labor'),
          buildLineItem('2', 'Parts', 1, 5000, 2, true, 'material'),
        ],
      },
      summary: 'Draft invoice from voice',
      createdBy: tenant.userId,
    };
    let proposal: Proposal = createProposal(input);
    proposal = transitionProposal(proposal, 'ready_for_review', tenant.userId);
    proposal = transitionProposal(proposal, 'approved', tenant.userId);
    // Backdate past the 5-second undo window so the executor runs now.
    proposal = { ...proposal, approvedAt: new Date(Date.now() - UNDO_WINDOW_MS - 100) };
    await proposalRepo.create(proposal);

    const context: ExecutionContext = { tenantId: tenant.tenantId, executedBy: tenant.userId };
    const { result } = await executor.execute(proposal, context);
    expect(result.success).toBe(true);
    expect(result.resultEntityId).toBeDefined();
    return result.resultEntityId as string;
  }

  beforeAll(async () => {
    pool = await getSharedTestDb();
    invoiceRepo = new PgInvoiceRepository(pool);
    settingsRepo = new PgSettingsRepository(pool);
    auditRepo = new PgAuditRepository(pool);
    jobRepo = new PgJobRepository(pool);
    const customerRepo = new PgCustomerRepository(pool);
    const locationRepo = new PgLocationRepository(pool);
    tenant = await createTestTenant(pool);

    customerId = crypto.randomUUID();
    await customerRepo.create({
      id: customerId,
      tenantId: tenant.tenantId,
      firstName: 'Inv',
      lastName: 'Customer',
      displayName: 'Inv Customer',
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
      street1: '123 Main St',
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
      locationId,
      jobNumber: 'JOB-INV-1',
      summary: 'Invoice test job',
      status: 'scheduled',
      priority: 'normal',
      createdBy: tenant.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    invoiceId = await executeDraftInvoice();
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  it('persists the invoice row with real columns + integer-cent totals', async () => {
    const { rows } = await pool.query(
      `SELECT tenant_id, job_id, invoice_number, status,
              subtotal_cents, tax_cents, total_cents, amount_due_cents
         FROM invoices WHERE id = $1`,
      [invoiceId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].tenant_id).toBe(tenant.tenantId);
    expect(rows[0].job_id).toBe(jobId);
    expect(rows[0].status).toBe('draft');
    expect(rows[0].invoice_number).not.toMatch(/^PENDING-/);
    expect(Number(rows[0].subtotal_cents)).toBe(20000);
    expect(Number(rows[0].total_cents)).toBe(20000);
    expect(Number(rows[0].amount_due_cents)).toBe(20000);
  });

  it('persists the invoice line items', async () => {
    const { rows } = await pool.query(
      `SELECT description, unit_price_cents
         FROM invoice_line_items WHERE invoice_id = $1 ORDER BY sort_order`,
      [invoiceId],
    );
    expect(rows).toHaveLength(2);
    expect(rows[0].description).toBe('AC Repair');
    expect(Number(rows[0].unit_price_cents)).toBe(7500);
    expect(Number(rows[1].unit_price_cents)).toBe(5000);
  });

  it('emits exactly one invoice.created audit event (regression guard for handler+registry audit wiring)', async () => {
    const { rows } = await pool.query(
      `SELECT event_type FROM audit_events
        WHERE entity_type = 'invoice' AND entity_id = $1 AND event_type = 'invoice.created'`,
      [invoiceId],
    );
    expect(rows).toHaveLength(1);
  });

  it('does not expose the invoice to another tenant (scoped read)', async () => {
    const other = await createTestTenant(pool);
    const found = await invoiceRepo.findById(other.tenantId, invoiceId);
    expect(found).toBeNull();
  });
});

/**
 * #909 (2026-08-31 live sweep, invoice INV-0022) — the price-scale guard's
 * correction (ai/resolution/price-scale-guard.ts) runs entirely inside
 * `InvoiceTaskHandler.handle()`, before a proposal even exists — no SQL
 * changed. The unit suites (test/ai/tasks/P5-003A.test.ts,
 * test/ai/resolution/price-scale-guard.test.ts) already pin that
 * computation directly. This closes the loop CLAUDE.md's own testing
 * principle asks for on a money-correctness fix ("tests that mock the DB
 * are never the only proof a query works"): the REAL `InvoiceTaskHandler`
 * (mocked LLM gateway — the live model itself isn't reachable in CI —
 * everything downstream is production code) drafts the exact live-shape
 * response, and the corrected total is what actually lands in the real
 * `invoices` / `invoice_line_items` rows after draft -> approve -> execute.
 */
describe('Postgres integration — draft_invoice price-scale correction persists correctly (#909)', () => {
  let pool: Pool;
  let invoiceRepo: PgInvoiceRepository;
  let settingsRepo: PgSettingsRepository;
  let auditRepo: PgAuditRepository;
  let jobRepo: PgJobRepository;
  let tenant: { tenantId: string; userId: string };
  let customerId: string;
  let jobId: string;

  function mockGateway(responseContent: string): LLMGateway {
    return {
      complete: vi.fn().mockResolvedValue({
        content: responseContent,
        model: 'test-model',
        provider: 'test-provider',
        tokenUsage: { input: 10, output: 20, total: 30 },
        latencyMs: 100,
      } satisfies LLMResponse),
    } as unknown as LLMGateway;
  }

  beforeAll(async () => {
    pool = await getSharedTestDb();
    invoiceRepo = new PgInvoiceRepository(pool);
    settingsRepo = new PgSettingsRepository(pool);
    auditRepo = new PgAuditRepository(pool);
    jobRepo = new PgJobRepository(pool);
    const customerRepo = new PgCustomerRepository(pool);
    const locationRepo = new PgLocationRepository(pool);
    tenant = await createTestTenant(pool);

    customerId = crypto.randomUUID();
    await customerRepo.create({
      id: customerId,
      tenantId: tenant.tenantId,
      firstName: 'Scale',
      lastName: 'Customer',
      displayName: 'Scale Customer',
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
      street1: '1 Scale Ave',
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
      locationId,
      jobNumber: 'JOB-SCALE-1',
      summary: 'AC repair job',
      status: 'scheduled',
      priority: 'normal',
      createdBy: tenant.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  it('the exact live shape ("450 dollars" for an uncatalogued line) persists as 45000 cents, not 450', async () => {
    const gateway = mockGateway(
      JSON.stringify({
        lineItems: [{ description: 'AC repair', quantity: 1, unitPrice: 450, category: 'labor' }],
        confidence_score: 0.6,
      }),
    );
    const handler = new InvoiceTaskHandler(gateway); // no catalog repo — AC repair is uncatalogued
    const context: TaskContext = {
      tenantId: tenant.tenantId,
      message: 'Draft an invoice for the customer for the job, 450 dollars for the AC repair',
      userId: tenant.userId,
      customerId,
      existingEntities: { jobId },
    };

    const { proposal: drafted } = await handler.handle(context);
    expect((drafted.payload.lineItems as Array<Record<string, unknown>>)[0].unitPriceCents).toBe(
      45_000,
    );

    const registry = createExecutionHandlerRegistry({ invoiceRepo, settingsRepo, auditRepo, jobRepo });
    const proposalRepo = new InMemoryProposalRepository();
    const executionRepo = new InMemoryProposalExecutionRepository();
    const guard = new IdempotencyGuard(executionRepo, proposalRepo);
    const executor = new ProposalExecutor(registry, proposalRepo, guard, auditRepo);

    let proposal = drafted;
    proposal = transitionProposal(proposal, 'ready_for_review', tenant.userId);
    proposal = transitionProposal(proposal, 'approved', tenant.userId);
    proposal = { ...proposal, approvedAt: new Date(Date.now() - UNDO_WINDOW_MS - 100) };
    await proposalRepo.create(proposal);

    const execContext: ExecutionContext = { tenantId: tenant.tenantId, executedBy: tenant.userId };
    const { result } = await executor.execute(proposal, execContext);
    expect(result.success).toBe(true);
    const invoiceId = result.resultEntityId as string;

    const { rows: invoiceRows } = await pool.query(
      `SELECT total_cents, amount_due_cents FROM invoices WHERE id = $1`,
      [invoiceId],
    );
    expect(Number(invoiceRows[0].total_cents)).toBe(45_000);
    expect(Number(invoiceRows[0].amount_due_cents)).toBe(45_000);

    const { rows: lineRows } = await pool.query(
      `SELECT description, unit_price_cents FROM invoice_line_items WHERE invoice_id = $1`,
      [invoiceId],
    );
    expect(lineRows).toHaveLength(1);
    expect(lineRows[0].description).toBe('AC repair');
    expect(Number(lineRows[0].unit_price_cents)).toBe(45_000);
  });
});

describe('Postgres integration — B6: customer-only draft_invoice (no jobId) auto-opens a job', () => {
  // B6 fix parity with DraftEstimateExecutionHandler's job auto-create:
  // draftInvoicePayloadSchema now allows jobId to be absent, and
  // CreateInvoiceExecutionHandler opens a job for the customer at
  // execution time. The PRODUCTION registry (createExecutionHandlerRegistry)
  // does not yet forward jobRepo/locationRepo into CreateInvoiceExecutionHandler
  // — see the note in invoice-execution-handler.ts — so this test constructs
  // the handler directly with real Pg repos to prove the auto-create path
  // against genuine Postgres columns; the jobId-present path above already
  // proves the registry + audit wiring.
  let pool: Pool;
  let invoiceRepo: PgInvoiceRepository;
  let settingsRepo: PgSettingsRepository;
  let auditRepo: PgAuditRepository;
  let jobRepo: PgJobRepository;
  let locationRepo: PgLocationRepository;
  let tenant: { tenantId: string; userId: string };
  let customerId: string;
  let locationId: string;

  beforeAll(async () => {
    pool = await getSharedTestDb();
    invoiceRepo = new PgInvoiceRepository(pool);
    settingsRepo = new PgSettingsRepository(pool);
    auditRepo = new PgAuditRepository(pool);
    jobRepo = new PgJobRepository(pool);
    locationRepo = new PgLocationRepository(pool);
    const customerRepo = new PgCustomerRepository(pool);
    tenant = await createTestTenant(pool);

    customerId = crypto.randomUUID();
    await customerRepo.create({
      id: customerId,
      tenantId: tenant.tenantId,
      firstName: 'AutoJob',
      lastName: 'Customer',
      displayName: 'AutoJob Customer',
      preferredChannel: 'phone',
      smsConsent: false,
      isArchived: false,
      createdBy: tenant.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    locationId = crypto.randomUUID();
    await locationRepo.create({
      id: locationId,
      tenantId: tenant.tenantId,
      customerId,
      street1: '55 Autocreate Ave',
      city: 'Austin',
      state: 'TX',
      postalCode: '78701',
      country: 'USA',
      isPrimary: true,
      isArchived: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  it('opens a job for the customer and persists the invoice + audit when jobId is absent', async () => {
    const handler = new CreateInvoiceExecutionHandler(
      invoiceRepo,
      settingsRepo,
      auditRepo,
      jobRepo,
      locationRepo,
    );

    const input: CreateProposalInput = {
      tenantId: tenant.tenantId,
      proposalType: 'draft_invoice',
      payload: {
        customerId,
        lineItems: [buildLineItem('1', 'Drain Cleaning', 1, 15000, 1, true, 'labor')],
      },
      summary: 'Draft invoice from voice (customer-only)',
      createdBy: tenant.userId,
    };
    let proposal: Proposal = createProposal(input);
    proposal = transitionProposal(proposal, 'ready_for_review', tenant.userId);
    proposal = transitionProposal(proposal, 'approved', tenant.userId);
    proposal = { ...proposal, approvedAt: new Date(Date.now() - UNDO_WINDOW_MS - 100) };

    const context: ExecutionContext = { tenantId: tenant.tenantId, executedBy: tenant.userId };
    const result = await handler.execute(proposal, context);

    expect(result.success).toBe(true);
    expect(result.resultEntityId).toBeDefined();
    const invoiceId = result.resultEntityId as string;

    const { rows: invoiceRows } = await pool.query(
      `SELECT job_id, status, total_cents FROM invoices WHERE id = $1`,
      [invoiceId],
    );
    expect(invoiceRows).toHaveLength(1);
    const jobId = invoiceRows[0].job_id as string;
    expect(jobId).toBeTruthy();
    expect(Number(invoiceRows[0].total_cents)).toBe(15000);

    const { rows: jobRows } = await pool.query(
      `SELECT customer_id, location_id FROM jobs WHERE id = $1`,
      [jobId],
    );
    expect(jobRows).toHaveLength(1);
    expect(jobRows[0].customer_id).toBe(customerId);
    expect(jobRows[0].location_id).toBe(locationId);

    const { rows: auditRows } = await pool.query(
      `SELECT event_type FROM audit_events
        WHERE entity_type = 'invoice' AND entity_id = $1 AND event_type = 'invoice.created'`,
      [invoiceId],
    );
    expect(auditRows).toHaveLength(1);

    const { rows: jobAuditRows } = await pool.query(
      `SELECT event_type FROM audit_events
        WHERE entity_type = 'job' AND entity_id = $1 AND event_type = 'job.created'`,
      [jobId],
    );
    expect(jobAuditRows).toHaveLength(1);
  });

  it('fails with a clear message when the customer has no service location', async () => {
    const handler = new CreateInvoiceExecutionHandler(
      invoiceRepo,
      settingsRepo,
      auditRepo,
      jobRepo,
      locationRepo,
    );
    const customerRepo = new PgCustomerRepository(pool);
    const noLocationCustomerId = crypto.randomUUID();
    await customerRepo.create({
      id: noLocationCustomerId,
      tenantId: tenant.tenantId,
      firstName: 'NoLocation',
      lastName: 'Customer',
      displayName: 'NoLocation Customer',
      preferredChannel: 'phone',
      smsConsent: false,
      isArchived: false,
      createdBy: tenant.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const input: CreateProposalInput = {
      tenantId: tenant.tenantId,
      proposalType: 'draft_invoice',
      payload: {
        customerId: noLocationCustomerId,
        lineItems: [buildLineItem('1', 'Drain Cleaning', 1, 15000, 1, true, 'labor')],
      },
      summary: 'Draft invoice from voice (no location)',
      createdBy: tenant.userId,
    };
    let proposal: Proposal = createProposal(input);
    proposal = transitionProposal(proposal, 'ready_for_review', tenant.userId);
    proposal = transitionProposal(proposal, 'approved', tenant.userId);
    proposal = { ...proposal, approvedAt: new Date(Date.now() - UNDO_WINDOW_MS - 100) };

    const context: ExecutionContext = { tenantId: tenant.tenantId, executedBy: tenant.userId };
    const result = await handler.execute(proposal, context);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/service location/);
  });

  it('the jobId-present path is unchanged (existing job used verbatim, no auto-create)', async () => {
    const registry = createExecutionHandlerRegistry({
      invoiceRepo,
      settingsRepo,
      auditRepo,
      jobRepo,
    });
    const proposalRepo = new InMemoryProposalRepository();
    const executionRepo = new InMemoryProposalExecutionRepository();
    const guard = new IdempotencyGuard(executionRepo, proposalRepo);
    const executor = new ProposalExecutor(registry, proposalRepo, guard, auditRepo);

    const existingJobId = crypto.randomUUID();
    await jobRepo.create({
      id: existingJobId,
      tenantId: tenant.tenantId,
      customerId,
      locationId,
      jobNumber: 'JOB-B6-1',
      summary: 'Pre-existing job',
      status: 'scheduled',
      priority: 'normal',
      createdBy: tenant.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const input: CreateProposalInput = {
      tenantId: tenant.tenantId,
      proposalType: 'draft_invoice',
      payload: {
        customerId,
        jobId: existingJobId,
        lineItems: [buildLineItem('1', 'Drain Cleaning', 1, 15000, 1, true, 'labor')],
      },
      summary: 'Draft invoice from voice (jobId present)',
      createdBy: tenant.userId,
    };
    let proposal: Proposal = createProposal(input);
    proposal = transitionProposal(proposal, 'ready_for_review', tenant.userId);
    proposal = transitionProposal(proposal, 'approved', tenant.userId);
    proposal = { ...proposal, approvedAt: new Date(Date.now() - UNDO_WINDOW_MS - 100) };
    await proposalRepo.create(proposal);

    const context: ExecutionContext = { tenantId: tenant.tenantId, executedBy: tenant.userId };
    const { result } = await executor.execute(proposal, context);

    expect(result.success).toBe(true);
    const { rows } = await pool.query(`SELECT job_id FROM invoices WHERE id = $1`, [
      result.resultEntityId,
    ]);
    expect(rows[0].job_id).toBe(existingJobId);
  });
});

describe('Postgres integration — Tradesperson wave 1, Task 4: apply_credit persists a negative line', () => {
  // Quality-review follow-up (commit 9617894e). Mocked-repo unit tests
  // (test/proposals/apply-credit-handler.test.ts) prove the handler's
  // logic, but a NEGATIVE `invoice_line_items.unit_price_cents` row is a
  // first for this codebase — the late-fee line-id incident
  // (`lateFeeLineId`'s doc comment, apply-late-fee-handler.ts) is this
  // repo's case study for why a mocked `InMemoryInvoiceRepository` is never
  // sole proof a real-schema write behaves (there it was
  // pg-invoice.insertLineItems silently rewriting non-UUID ids; here the
  // risk class is a numeric-column CHECK/precision surprise on a negative
  // value neither the in-memory repo nor a hand-rolled fixture can
  // exercise). This runs the credit through the PRODUCTION execution
  // registry against real Postgres and reads the persisted row back.
  //
  // No local Docker in this environment — like every other suite in this
  // file, it runs only under `npm run test:integration` in PR CI (vitest
  // globalSetup starts the Postgres testcontainer). NOT executed locally;
  // verified here by `tsc --project tsconfig.build.json --noEmit` only.
  let pool: Pool;
  let invoiceRepo: PgInvoiceRepository;
  let auditRepo: PgAuditRepository;
  let tenant: { tenantId: string; userId: string };
  let invoiceId: string;

  beforeAll(async () => {
    pool = await getSharedTestDb();
    invoiceRepo = new PgInvoiceRepository(pool);
    auditRepo = new PgAuditRepository(pool);
    const jobRepo = new PgJobRepository(pool);
    const customerRepo = new PgCustomerRepository(pool);
    const locationRepo = new PgLocationRepository(pool);
    tenant = await createTestTenant(pool);

    const customerId = crypto.randomUUID();
    await customerRepo.create({
      id: customerId,
      tenantId: tenant.tenantId,
      firstName: 'Credit',
      lastName: 'Customer',
      displayName: 'Credit Customer',
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
      street1: '9 Goodwill Way',
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
      tenantId: tenant.tenantId,
      customerId,
      locationId,
      jobNumber: 'JOB-CREDIT-1',
      summary: 'apply_credit integration test job',
      status: 'scheduled',
      priority: 'normal',
      createdBy: tenant.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // Seed an already-ISSUED ('open') invoice directly (mirrors
    // invoice-webhook-paid.test.ts's seedOpenInvoice) — apply_credit only
    // ever runs against an invoice that already exists and is owed.
    const lineItems = [buildLineItem(crypto.randomUUID(), 'Labor', 1, 30000, 0, true, 'labor')];
    const totals = calculateDocumentTotals(lineItems, 0, 0);
    invoiceId = crypto.randomUUID();
    await invoiceRepo.create({
      id: invoiceId,
      tenantId: tenant.tenantId,
      jobId,
      invoiceNumber: `INV-${invoiceId.slice(0, 8)}`,
      status: 'open',
      lineItems,
      totals,
      amountPaidCents: 0,
      amountDueCents: totals.totalCents,
      createdBy: tenant.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  it('appends a negative non-taxable line via the PRODUCTION registry and persists reduced totals', async () => {
    const registry = createExecutionHandlerRegistry({ invoiceRepo, auditRepo });
    const proposalRepo = new InMemoryProposalRepository();
    const executionRepo = new InMemoryProposalExecutionRepository();
    const guard = new IdempotencyGuard(executionRepo, proposalRepo);
    const executor = new ProposalExecutor(registry, proposalRepo, guard, auditRepo);

    const input: CreateProposalInput = {
      tenantId: tenant.tenantId,
      proposalType: 'apply_credit',
      payload: { invoiceId, amountCents: 5000, reason: 'goodwill — repeat leak' },
      summary: 'Apply credit from voice',
      createdBy: tenant.userId,
    };
    let proposal: Proposal = createProposal(input);
    proposal = transitionProposal(proposal, 'ready_for_review', tenant.userId);
    proposal = transitionProposal(proposal, 'approved', tenant.userId);
    proposal = { ...proposal, approvedAt: new Date(Date.now() - UNDO_WINDOW_MS - 100) };
    await proposalRepo.create(proposal);

    const context: ExecutionContext = { tenantId: tenant.tenantId, executedBy: tenant.userId };
    const { result } = await executor.execute(proposal, context);

    expect(result.success).toBe(true);
    expect(result.resultEntityId).toBe(invoiceId);

    const { rows: invoiceRows } = await pool.query(
      `SELECT total_cents, amount_due_cents FROM invoices WHERE id = $1`,
      [invoiceId],
    );
    expect(invoiceRows).toHaveLength(1);
    // 30000 base - 5000 credit = 25000.
    expect(Number(invoiceRows[0].total_cents)).toBe(25000);
    expect(Number(invoiceRows[0].amount_due_cents)).toBe(25000);

    const { rows: lineRows } = await pool.query(
      `SELECT description, unit_price_cents, quantity, taxable
         FROM invoice_line_items WHERE invoice_id = $1 ORDER BY sort_order`,
      [invoiceId],
    );
    expect(lineRows).toHaveLength(2);
    const creditRow = lineRows[1];
    expect(creditRow.description).toBe('Credit — goodwill — repeat leak');
    expect(Number(creditRow.unit_price_cents)).toBe(-5000);
    expect(Number(creditRow.quantity)).toBe(1);
    expect(creditRow.taxable).toBe(false);

    const { rows: auditRows } = await pool.query(
      `SELECT event_type FROM audit_events
        WHERE entity_type = 'invoice' AND entity_id = $1 AND event_type = 'credit.applied'`,
      [invoiceId],
    );
    expect(auditRows).toHaveLength(1);
  });
});
