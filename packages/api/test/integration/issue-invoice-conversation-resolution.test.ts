/**
 * B4 (feat: voice-transcript-and-agent-paths) — Postgres integration for the
 * unified `issue_invoice` handler's conversation-context resolution rung
 * ("the one we just drafted"). Unit-level coverage
 * (test/ai/orchestration/invoice-intents.test.ts) mocks the proposal repo;
 * this test exercises the SAME `IssueInvoiceTaskHandler` against a REAL
 * `PgProposalRepository` + `PgInvoiceRepository`, proving:
 *   - `findByConversation` is a real SQL-filtered lookup (source_context->>
 *     'conversationId'), not a mocked shape;
 *   - a draft_invoice proposal's real `resultEntityId` — persisted by the
 *     PRODUCTION executor after a genuine invoice INSERT — round-trips
 *     through to the issue_invoice proposal's payload;
 *   - the resulting proposal is ungated (`missingFields` empty) and
 *     `sourceContext.verifiedIds` is stamped, so it approves and executes
 *     to a real draft → open invoice transition against real columns.
 *
 * Runs only under `npm run test:integration` (vitest globalSetup starts the
 * Postgres testcontainer and sets TEST_DB_URL).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { PgProposalRepository } from '../../src/proposals/pg-proposal';
import { PgProposalExecutionRepository } from '../../src/proposals/pg-proposal-execution';
import { PgInvoiceRepository } from '../../src/invoices/pg-invoice';
import { PgSettingsRepository } from '../../src/settings/pg-settings';
import { PgAuditRepository } from '../../src/audit/pg-audit';
import { PgJobRepository } from '../../src/jobs/pg-job';
import { PgCustomerRepository } from '../../src/customers/pg-customer';
import { PgLocationRepository } from '../../src/locations/pg-location';
import { buildLineItem } from '../../src/shared/billing-engine';
import {
  createProposal,
  CreateProposalInput,
  Proposal,
  missingFieldsFor,
} from '../../src/proposals/proposal';
import { transitionProposal, UNDO_WINDOW_MS } from '../../src/proposals/lifecycle';
import { ProposalExecutor } from '../../src/proposals/execution/executor';
import { IdempotencyGuard } from '../../src/proposals/execution/idempotency';
import {
  createExecutionHandlerRegistry,
  ExecutionContext,
} from '../../src/proposals/execution/handlers';
import { IssueInvoiceTaskHandler } from '../../src/ai/orchestration/task-router';
import { approveProposal } from '../../src/proposals/actions';

describe('Postgres integration — B4: issue_invoice resolves "the one we just drafted" from conversation history', () => {
  let pool: Pool;
  let proposalRepo: PgProposalRepository;
  let invoiceRepo: PgInvoiceRepository;
  let settingsRepo: PgSettingsRepository;
  let auditRepo: PgAuditRepository;
  let jobRepo: PgJobRepository;
  let executor: ProposalExecutor;
  let tenant: { tenantId: string; userId: string };
  let customerId: string;
  let jobId: string;
  const conversationId = 'conv-b4-issue-invoice';

  beforeAll(async () => {
    pool = await getSharedTestDb();
    proposalRepo = new PgProposalRepository(pool);
    invoiceRepo = new PgInvoiceRepository(pool);
    settingsRepo = new PgSettingsRepository(pool);
    auditRepo = new PgAuditRepository(pool);
    jobRepo = new PgJobRepository(pool);
    const customerRepo = new PgCustomerRepository(pool);
    const locationRepo = new PgLocationRepository(pool);
    tenant = await createTestTenant(pool);

    const registry = createExecutionHandlerRegistry({
      invoiceRepo,
      settingsRepo,
      auditRepo,
      jobRepo,
    });
    const executionRepo = new PgProposalExecutionRepository(pool);
    const guard = new IdempotencyGuard(executionRepo, proposalRepo);
    executor = new ProposalExecutor(registry, proposalRepo, guard, auditRepo);

    customerId = crypto.randomUUID();
    await customerRepo.create({
      id: customerId,
      tenantId: tenant.tenantId,
      firstName: 'Issue',
      lastName: 'Customer',
      displayName: 'Issue Customer',
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
      street1: '456 Main St',
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
      jobNumber: 'JOB-B4-ISSUE-1',
      summary: 'B4 issue_invoice test job',
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

  it('draft an invoice in a conversation, issue "the one we just drafted", approve — real invoice transitions draft → open', async () => {
    // 1) Draft — a real draft_invoice proposal, stamped with conversationId,
    // approved and executed through the PRODUCTION registry so the
    // resultEntityId is a genuine invoice row (not a synthetic id).
    const draftInput: CreateProposalInput = {
      tenantId: tenant.tenantId,
      proposalType: 'draft_invoice',
      payload: {
        customerId,
        jobId,
        lineItems: [buildLineItem('1', 'B4 diagnostic', 1, 12000, 1, true, 'labor')],
      },
      summary: 'Draft invoice from voice',
      sourceContext: { conversationId },
      createdBy: tenant.userId,
    };
    let draftProposal: Proposal = createProposal(draftInput);
    draftProposal = transitionProposal(draftProposal, 'ready_for_review', tenant.userId);
    draftProposal = transitionProposal(draftProposal, 'approved', tenant.userId);
    draftProposal = { ...draftProposal, approvedAt: new Date(Date.now() - UNDO_WINDOW_MS - 100) };
    await proposalRepo.create(draftProposal);

    const draftContext: ExecutionContext = { tenantId: tenant.tenantId, executedBy: tenant.userId };
    const { result: draftResult } = await executor.execute(draftProposal, draftContext);
    expect(draftResult.success).toBe(true);
    const invoiceId = draftResult.resultEntityId as string;
    expect(invoiceId).toBeTruthy();

    // Sanity: the invoice landed as a real draft row.
    const draftedInvoice = await invoiceRepo.findById(tenant.tenantId, invoiceId);
    expect(draftedInvoice?.status).toBe('draft');

    // 2) "Issue the one we just drafted" — no explicit invoiceId/reference,
    // only the conversationId. IssueInvoiceTaskHandler must resolve it via a
    // REAL findByConversation query against the persisted draft_invoice row
    // above (source_context->>'conversationId' = $2, source_context->>
    // 'resultEntityId' is NOT how it's stored — resultEntityId is a top-level
    // column the executor wrote via updateStatus).
    const issueHandler = new IssueInvoiceTaskHandler({ proposalRepo, invoiceRepo });
    const { proposal: issueProposal } = await issueHandler.handle({
      tenantId: tenant.tenantId,
      userId: tenant.userId,
      message: 'Issue the invoice we just drafted',
      conversationId,
    });

    expect((issueProposal.payload as Record<string, unknown>).invoiceId).toBe(invoiceId);
    expect(missingFieldsFor(issueProposal)).toEqual([]);
    expect(issueProposal.sourceContext?.verifiedIds).toEqual({ invoiceId });

    // 3) Approve — the gate is satisfied (ungated from drafting), so this
    // must not throw the "unfilled required fields" ValidationError.
    await proposalRepo.create(issueProposal);
    await proposalRepo.updateStatus(tenant.tenantId, issueProposal.id, 'ready_for_review');
    const approved = await approveProposal(
      proposalRepo,
      tenant.tenantId,
      issueProposal.id,
      tenant.userId,
      'owner',
      auditRepo,
    );
    expect(approved.status).toBe('approved');

    // 4) Execute — draft → open on the REAL invoice row.
    const issueContext: ExecutionContext = { tenantId: tenant.tenantId, executedBy: tenant.userId };
    const backdated = { ...approved, approvedAt: new Date(Date.now() - UNDO_WINDOW_MS - 100) };
    const { result: issueResult } = await executor.execute(backdated, issueContext);
    expect(issueResult.success).toBe(true);
    expect(issueResult.resultEntityId).toBe(invoiceId);

    const { rows } = await pool.query(
      `SELECT status, issued_at, due_date FROM invoices WHERE id = $1`,
      [invoiceId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('open');
    expect(rows[0].issued_at).toBeTruthy();
    expect(rows[0].due_date).toBeTruthy();

    const { rows: auditRows } = await pool.query(
      `SELECT event_type FROM audit_events
        WHERE entity_type = 'invoice' AND entity_id = $1 AND event_type = 'invoice.issued'`,
      [invoiceId],
    );
    expect(auditRows).toHaveLength(1);
  });

  it('a different conversation with no drafts lands the issue_invoice proposal GATED (never a doomed empty-payload approval)', async () => {
    const issueHandler = new IssueInvoiceTaskHandler({ proposalRepo, invoiceRepo });
    const { proposal } = await issueHandler.handle({
      tenantId: tenant.tenantId,
      userId: tenant.userId,
      message: 'Issue the invoice',
      conversationId: 'conv-b4-no-history',
    });

    expect(proposal.payload).toEqual({});
    expect(missingFieldsFor(proposal)).toEqual(['invoiceId']);

    await proposalRepo.create(proposal);
    await proposalRepo.updateStatus(tenant.tenantId, proposal.id, 'ready_for_review');
    await expect(
      approveProposal(proposalRepo, tenant.tenantId, proposal.id, tenant.userId, 'owner', auditRepo),
    ).rejects.toThrow(/unfilled required fields/);
  });
});
