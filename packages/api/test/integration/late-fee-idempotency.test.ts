/**
 * Collections cadence — apply_late_fee idempotency against real Postgres.
 *
 * Regression guard: pg-invoice.insertLineItems replaces any non-UUID
 * line-item id with a random uuidv4, so the old human-readable
 * `late-fee:<stepKey>` id never survived a reload and the handler's
 * idempotency guard could not match — a retried/duplicate proposal appended
 * a SECOND late-fee line (double charge). The fee id is now a deterministic
 * UUID (lateFeeLineId), which the repo preserves. This test round-trips
 * through the REAL repo (the InMemory repo preserves all ids and therefore
 * cannot catch this — the exact mocked-DB trap CLAUDE.md warns about).
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
import { PgAuditRepository } from '../../src/audit/pg-audit';
import { buildLineItem, calculateDocumentTotals } from '../../src/shared/billing-engine';
import {
  ApplyLateFeeExecutionHandler,
  lateFeeLineId,
} from '../../src/proposals/execution/apply-late-fee-handler';
import { Proposal } from '../../src/proposals/proposal';

describe('Postgres integration — apply_late_fee idempotency across reload', () => {
  let pool: Pool;
  let invoiceRepo: PgInvoiceRepository;
  let handler: ApplyLateFeeExecutionHandler;
  let tenant: { tenantId: string; userId: string };
  let customerId: string;
  let jobId: string;
  let invoiceId: string;

  function makeProposal(): Proposal {
    return {
      id: crypto.randomUUID(),
      tenantId: tenant.tenantId,
      proposalType: 'apply_late_fee',
      status: 'approved',
      payload: { invoiceId, feeCents: 2500, stepKey: 'initial' },
      summary: 'Apply late fee',
      createdBy: tenant.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
  }

  beforeAll(async () => {
    pool = await getSharedTestDb();
    invoiceRepo = new PgInvoiceRepository(pool);
    handler = new ApplyLateFeeExecutionHandler(invoiceRepo, new PgAuditRepository(pool));
    const customerRepo = new PgCustomerRepository(pool);
    const locationRepo = new PgLocationRepository(pool);
    const jobRepo = new PgJobRepository(pool);
    tenant = await createTestTenant(pool);

    customerId = crypto.randomUUID();
    await customerRepo.create({
      id: customerId,
      tenantId: tenant.tenantId,
      firstName: 'Late',
      lastName: 'Fee',
      displayName: 'Late Fee',
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
      street1: '1 Fee St',
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

    jobId = crypto.randomUUID();
    await jobRepo.create({
      id: jobId,
      tenantId: tenant.tenantId,
      customerId,
      locationId,
      jobNumber: 'JOB-LF-1',
      summary: 'Late fee job',
      status: 'scheduled',
      priority: 'normal',
      createdBy: tenant.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    invoiceId = crypto.randomUUID();
    const lineItems = [buildLineItem(crypto.randomUUID(), 'Labor', 1, 15000, 0, true, 'labor')];
    const totals = calculateDocumentTotals(lineItems, 0, 0);
    await invoiceRepo.create({
      id: invoiceId,
      tenantId: tenant.tenantId,
      jobId,
      invoiceNumber: 'INV-LF-0001',
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

  it('re-executing the same proposal does not append a second fee line (real DB reload)', async () => {
    const first = await handler.execute(makeProposal(), {
      tenantId: tenant.tenantId,
      executedBy: tenant.userId,
    });
    expect(first.success).toBe(true);

    // Reload proves the fee-line id was persisted as-is (a valid UUID). A
    // second, distinct proposal for the same stepKey must be a no-op.
    const second = await handler.execute(makeProposal(), {
      tenantId: tenant.tenantId,
      executedBy: tenant.userId,
    });
    expect(second.success).toBe(true);

    const reloaded = await invoiceRepo.findById(tenant.tenantId, invoiceId);
    const feeLines = reloaded!.lineItems.filter((li) => li.id === lateFeeLineId(invoiceId, 'initial'));
    expect(feeLines).toHaveLength(1);
    // 15000 base + 2500 fee once — never 20000.
    expect(reloaded!.amountDueCents).toBe(17500);
  });
});
