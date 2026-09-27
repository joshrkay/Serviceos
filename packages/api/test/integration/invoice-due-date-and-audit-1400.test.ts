/**
 * #1400 (QA 2026-09-26 §5) at real Postgres:
 * - the owner-chosen due date persists on create (it was dropped) and
 *   survives issuing when no new terms are given (it was overwritten);
 * - invoice update / issue write `invoice.updated` / `invoice.issued` rows
 *   into audit_events (the QA audit window showed none), visible only to
 *   the owning tenant.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { PgInvoiceRepository } from '../../src/invoices/pg-invoice';
import { PgJobRepository } from '../../src/jobs/pg-job';
import { PgCustomerRepository } from '../../src/customers/pg-customer';
import { PgLocationRepository } from '../../src/locations/pg-location';
import { PgAuditRepository } from '../../src/audit/pg-audit';
import { createInvoice, updateInvoice, issueInvoice } from '../../src/invoices/invoice';
import type { LineItem } from '../../src/shared/billing-engine';

async function seedJob(pool: Pool, tenantId: string, userId: string): Promise<string> {
  const customerId = crypto.randomUUID();
  await new PgCustomerRepository(pool).create({
    id: customerId, tenantId, firstName: 'Due', lastName: 'Date', displayName: 'Due Date',
    preferredChannel: 'phone', smsConsent: false, isArchived: false,
    createdBy: userId, createdAt: new Date(), updatedAt: new Date(),
  });
  const locationId = crypto.randomUUID();
  await new PgLocationRepository(pool).create({
    id: locationId, tenantId, customerId, street1: '1 Due Way', city: 'Austin', state: 'TX',
    postalCode: '78701', country: 'USA', isPrimary: true, isArchived: false,
    createdAt: new Date(), updatedAt: new Date(),
  });
  const jobId = crypto.randomUUID();
  await new PgJobRepository(pool).create({
    id: jobId, tenantId, customerId, locationId, jobNumber: `JOB-${jobId.slice(0, 8)}`, summary: 'Work',
    status: 'scheduled', priority: 'normal', createdBy: userId, createdAt: new Date(), updatedAt: new Date(),
  });
  return jobId;
}

const LINES = (): LineItem[] => [
  { id: crypto.randomUUID(), description: 'Labor', quantity: 2, unitPriceCents: 4550, totalCents: 9100, sortOrder: 0, taxable: true },
];

describe('Postgres integration — invoice due date + mutation audit rows (#1400)', () => {
  let pool: Pool;
  let invoiceRepo: PgInvoiceRepository;
  let auditRepo: PgAuditRepository;

  beforeAll(async () => {
    pool = await getSharedTestDb();
    invoiceRepo = new PgInvoiceRepository(pool);
    auditRepo = new PgAuditRepository(pool);
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  it('persists the chosen due date on create and keeps it when issued without new terms', async () => {
    const { tenantId, userId } = await createTestTenant(pool);
    const jobId = await seedJob(pool, tenantId, userId);
    const due = new Date('2026-10-15T12:00:00.000Z');

    const created = await createInvoice(
      { tenantId, jobId, invoiceNumber: 'INV-DUE-1', lineItems: LINES(), dueDate: due, createdBy: userId },
      invoiceRepo,
    );
    expect((await invoiceRepo.findById(tenantId, created.id))!.dueDate?.toISOString()).toBe(due.toISOString());

    await issueInvoice(tenantId, created.id, undefined, invoiceRepo);
    const issued = (await invoiceRepo.findById(tenantId, created.id))!;
    expect(issued.status).toBe('open');
    expect(issued.dueDate?.toISOString()).toBe(due.toISOString());
  });

  it('update and issue write invoice.updated / invoice.issued rows, scoped to the owning tenant', async () => {
    const a = await createTestTenant(pool);
    const b = await createTestTenant(pool);
    const jobId = await seedJob(pool, a.tenantId, a.userId);
    const actor = { actorId: a.userId, actorRole: 'owner' };

    const inv = await createInvoice(
      { tenantId: a.tenantId, jobId, invoiceNumber: 'INV-AUD-1', lineItems: LINES(), createdBy: a.userId },
      invoiceRepo,
    );
    await updateInvoice(a.tenantId, inv.id, { discountCents: 500 }, invoiceRepo, { auditRepo, actor });
    await issueInvoice(a.tenantId, inv.id, 15, invoiceRepo, undefined, { auditRepo, actor });

    const rows = await auditRepo.findByEntity(a.tenantId, 'invoice', inv.id);
    const byType = Object.fromEntries(rows.map((r) => [r.eventType, r]));
    expect(byType['invoice.updated']?.actorId).toBe(a.userId);
    expect(byType['invoice.updated']?.metadata).toMatchObject({ previousTotalCents: 9100, totalCents: 8600 });
    expect(byType['invoice.issued']?.metadata).toMatchObject({ paymentTermDays: 15, totalCents: 8600 });

    expect(await auditRepo.findByEntity(b.tenantId, 'invoice', inv.id)).toEqual([]);
  });
});
