import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { PgProposalRepository } from '../../src/proposals/pg-proposal';
import { PgAuditRepository } from '../../src/audit/pg-audit';
import { PgInvoiceRepository } from '../../src/invoices/pg-invoice';
import { PgJobRepository } from '../../src/jobs/pg-job';
import { PgCustomerRepository } from '../../src/customers/pg-customer';
import { PgLocationRepository } from '../../src/locations/pg-location';
import { buildLineItem, calculateDocumentTotals } from '../../src/shared/billing-engine';
import { SendInvoiceTaskHandler } from '../../src/ai/tasks/voice-extended-tasks';
import { resolveProposalEntity } from '../../src/proposals/resolve-entity';
import { approveProposal } from '../../src/proposals/actions';
import { missingFieldsFor } from '../../src/proposals/proposal';

/**
 * B2 integration — a real Postgres round trip for the reference→candidates
 * flow on a TYPED money proposal: SendInvoiceTaskHandler gates
 * missingFields:['invoiceId'] on a free-text invoiceReference AND (this
 * unit) records candidates via candidatesForReference's real ILIKE search
 * against the real invoices table; resolveProposalEntity then picks one,
 * clears the gate, and approveProposal — which reads real jsonb columns,
 * not a mocked repo — succeeds. Pins the real `invoice_number` /
 * `customer_message` columns candidatesForReference's search depends on.
 */
describe('Postgres integration — B2 reference→candidates on a gated send_invoice', () => {
  let pool: Pool;
  let proposalRepo: PgProposalRepository;
  let auditRepo: PgAuditRepository;
  let invoiceRepo: PgInvoiceRepository;
  let tenant: { tenantId: string; userId: string };
  let invoiceId: string;

  beforeAll(async () => {
    pool = await getSharedTestDb();
    proposalRepo = new PgProposalRepository(pool);
    auditRepo = new PgAuditRepository(pool);
    invoiceRepo = new PgInvoiceRepository(pool);
    const jobRepo = new PgJobRepository(pool);
    const customerRepo = new PgCustomerRepository(pool);
    const locationRepo = new PgLocationRepository(pool);
    tenant = await createTestTenant(pool);

    const customerId = crypto.randomUUID();
    await customerRepo.create({
      id: customerId,
      tenantId: tenant.tenantId,
      firstName: 'Henderson',
      lastName: 'Household',
      displayName: 'Henderson Household',
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

    const jobId = crypto.randomUUID();
    await jobRepo.create({
      id: jobId,
      tenantId: tenant.tenantId,
      customerId,
      locationId,
      jobNumber: 'JOB-001',
      summary: 'Test job',
      status: 'scheduled',
      priority: 'normal',
      createdBy: tenant.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const lineItems = [buildLineItem(crypto.randomUUID(), 'Water heater install', 1, 45000, 0, true, 'labor')];
    const totals = calculateDocumentTotals(lineItems, 0, 0);
    const invoice = await invoiceRepo.create({
      id: crypto.randomUUID(),
      tenantId: tenant.tenantId,
      jobId,
      invoiceNumber: 'INV-HENDERSON-01',
      status: 'open',
      lineItems,
      totals,
      amountPaidCents: 0,
      amountDueCents: totals.totalCents,
      customerMessage: 'Henderson water heater job',
      createdBy: tenant.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    invoiceId = invoice.id;
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  it('drafts gated with real candidates, resolves, and approves', async () => {
    // 1) Draft — SendInvoiceTaskHandler with the REAL invoiceRepo wired.
    // "Henderson" matches the seeded invoice's customer_message via the
    // real ILIKE search, not a mock.
    const handler = new SendInvoiceTaskHandler({ invoiceRepo });
    const { proposal: drafted } = await handler.handle({
      tenantId: tenant.tenantId,
      userId: tenant.userId,
      message: 'send the Henderson invoice',
      existingEntities: { customerName: 'Henderson' },
    });

    expect(missingFieldsFor(drafted)).toContain('invoiceId');
    const draftedCtx = drafted.sourceContext as Record<string, unknown>;
    expect(draftedCtx.entityKind).toBe('invoice');
    const candidates = draftedCtx.entityCandidates as Array<Record<string, unknown>>;
    expect(candidates.some((c) => c.id === invoiceId)).toBe(true);

    await proposalRepo.create(drafted);

    // 2) Resolve — pick the real invoice out of the real candidate list.
    const resolved = await resolveProposalEntity(
      {
        tenantId: tenant.tenantId,
        proposalId: drafted.id,
        candidateId: invoiceId,
        actorId: tenant.userId,
        actorRole: 'owner',
      },
      { proposalRepo, auditRepo },
    );

    expect((resolved.payload as Record<string, unknown>).invoiceId).toBe(invoiceId);
    expect(resolved.status).toBe('ready_for_review');
    expect(missingFieldsFor(resolved)).toHaveLength(0);

    // Re-read from Postgres to prove the jsonb merge persisted, not just an
    // in-memory return value.
    const stored = await proposalRepo.findById(tenant.tenantId, drafted.id);
    expect((stored!.payload as Record<string, unknown>).invoiceId).toBe(invoiceId);
    expect(stored!.status).toBe('ready_for_review');

    const audits = await auditRepo.findByEntity(tenant.tenantId, 'proposal', drafted.id);
    expect(audits.some((a) => a.eventType === 'proposal.entity_resolved')).toBe(true);

    // 3) Approve — the gate is satisfied, so this must not throw.
    const approved = await approveProposal(
      proposalRepo,
      tenant.tenantId,
      drafted.id,
      tenant.userId,
      'owner',
      auditRepo,
    );
    expect(approved.status).toBe('approved');
  });
});
