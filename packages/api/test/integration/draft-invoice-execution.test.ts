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
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { PgInvoiceRepository } from '../../src/invoices/pg-invoice';
import { PgJobRepository } from '../../src/jobs/pg-job';
import { PgCustomerRepository } from '../../src/customers/pg-customer';
import { PgLocationRepository } from '../../src/locations/pg-location';
import { PgSettingsRepository } from '../../src/settings/pg-settings';
import { PgAuditRepository } from '../../src/audit/pg-audit';
import { buildLineItem } from '../../src/shared/billing-engine';
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
