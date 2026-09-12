/**
 * Postgres integration — two DISTINCT legitimate payments racing on one invoice
 * must both credit it (no lost update).
 *
 * Regression for the recordPayment lost-update race: the old path read
 * amountPaidCents into a snapshot and blind-set snapshot+delta, so a manual cash
 * entry racing a Stripe/ACH webhook (each with its OWN providerReference, so the
 * insert dedup does NOT collapse them) both read the same paid balance and the
 * second write clobbered the first — one payment silently vanished from the
 * invoice balance. incrementAmountPaidAtomic derives the new balance from the
 * row's own value in a single UPDATE, so both credits apply.
 *
 * #1022 row 8.6: the credit is only half the record. Each credit's
 * `payment.recorded` audit event is now read back through the REAL
 * PgAuditRepository (payment.ts: "a payment with no audit record is not an
 * acceptable committed state"), and a NEIGHBOUR tenant races its own payment in
 * the same run — its money must never land on this tenant's balance, its
 * payment rows must never appear in this tenant's ledger, and neither tenant
 * may read the other's audit trail.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'crypto';
import type { Pool } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { PgInvoiceRepository } from '../../src/invoices/pg-invoice';
import { PgPaymentRepository } from '../../src/invoices/pg-payment';
import { PgCustomerRepository } from '../../src/customers/pg-customer';
import { PgLocationRepository } from '../../src/locations/pg-location';
import { PgJobRepository } from '../../src/jobs/pg-job';
import { PgAuditRepository } from '../../src/audit/pg-audit';
import { recordPayment } from '../../src/invoices/payment';
import { buildLineItem, calculateDocumentTotals } from '../../src/shared/billing-engine';

describe('Postgres integration — concurrent distinct payments both credit the invoice', () => {
  let pool: Pool;
  let invoiceRepo: PgInvoiceRepository;
  let paymentRepo: PgPaymentRepository;
  let auditRepo: PgAuditRepository;
  let tenant: { tenantId: string; userId: string };
  let otherTenant: { tenantId: string; userId: string };
  let invoiceId: string;
  let otherTenantInvoiceId: string;

  /**
   * Seed one tenant's full fixture chain (customer → location → job → open
   * invoice) and return the invoice id. Used for BOTH the tenant under test and
   * the neighbour tenant, so the two are identical apart from tenant_id — the
   * only variable the isolation assertions are about.
   */
  async function seedOpenInvoice(
    t: { tenantId: string; userId: string },
    label: string,
    totalCents: number,
  ): Promise<string> {
    const customerRepo = new PgCustomerRepository(pool);
    const locationRepo = new PgLocationRepository(pool);
    const jobRepo = new PgJobRepository(pool);

    const customerId = crypto.randomUUID();
    await customerRepo.create({
      id: customerId,
      tenantId: t.tenantId,
      firstName: 'Con',
      lastName: 'Current',
      displayName: 'Con Current',
      preferredChannel: 'phone',
      smsConsent: false,
      isArchived: false,
      createdBy: t.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const locationId = crypto.randomUUID();
    await locationRepo.create({
      id: locationId,
      tenantId: t.tenantId,
      customerId,
      street1: '1 Race St',
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
      tenantId: t.tenantId,
      customerId,
      locationId,
      jobNumber: `JOB-${label}`,
      summary: 'Race pay job',
      status: 'scheduled',
      priority: 'normal',
      createdBy: t.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const newInvoiceId = crypto.randomUUID();
    const lineItems = [
      buildLineItem(crypto.randomUUID(), 'Service', 1, totalCents, 0, true, 'labor'),
    ];
    const totals = calculateDocumentTotals(lineItems, 0, 0);
    await invoiceRepo.create({
      id: newInvoiceId,
      tenantId: t.tenantId,
      jobId,
      invoiceNumber: `INV-${label}`,
      status: 'open',
      lineItems,
      totals,
      amountPaidCents: 0,
      amountDueCents: totals.totalCents,
      createdBy: t.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    return newInvoiceId;
  }

  beforeAll(async () => {
    pool = await getSharedTestDb();
    invoiceRepo = new PgInvoiceRepository(pool);
    paymentRepo = new PgPaymentRepository(pool);
    auditRepo = new PgAuditRepository(pool);
    tenant = await createTestTenant(pool);
    otherTenant = await createTestTenant(pool);

    invoiceId = await seedOpenInvoice(tenant, 'RACE-1', 30000);
    otherTenantInvoiceId = await seedOpenInvoice(otherTenant, 'RACE-NEIGHBOUR', 30000);
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  it('a $100 cash entry racing a $150 ACH webhook both credit the invoice (no lost update)', async () => {
    const cash = {
      tenantId: tenant.tenantId,
      invoiceId,
      amountCents: 10000,
      method: 'cash' as const,
      providerReference: 'manual-cash-1',
      processedBy: 'owner',
    };
    const ach = {
      tenantId: tenant.tenantId,
      invoiceId,
      amountCents: 15000,
      method: 'bank_transfer' as const, // ACH
      providerReference: 'pi_ach_race_1',
      processedBy: 'stripe_webhook',
    };

    // Fire both concurrently — they interleave at their await points. The real
    // PgAuditRepository is wired (positional arg 6) so the audit leg commits to
    // real Postgres alongside the money leg.
    await Promise.all([
      recordPayment(cash, invoiceRepo, paymentRepo, undefined, undefined, auditRepo),
      recordPayment(ach, invoiceRepo, paymentRepo, undefined, undefined, auditRepo),
    ]);

    // Both credits landed: 10000 + 15000 = 25000 (the old blind-set would leave
    // 10000 OR 15000 — one payment lost).
    const reloaded = await invoiceRepo.findById(tenant.tenantId, invoiceId);
    expect(reloaded!.amountPaidCents).toBe(25000);
    expect(reloaded!.amountDueCents).toBe(5000);
    expect(reloaded!.status).toBe('partially_paid');

    // Both distinct payment rows persisted.
    const { rows } = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM payments WHERE tenant_id = $1 AND invoice_id = $2`,
      [tenant.tenantId, invoiceId],
    );
    expect(rows[0].n).toBe(2);

    // …and BOTH are on the audit trail, read back through the real repo. An
    // invoice whose balance moved with only one `payment.recorded` event is
    // exactly the reconciliation hole the atomic credit exists to close.
    const events = await auditRepo.findByEntity(tenant.tenantId, 'invoice', invoiceId);
    const recorded = events.filter((e) => e.eventType === 'payment.recorded');
    expect(recorded).toHaveLength(2);
    expect(recorded.map((e) => e.metadata!.amountCents as number).sort((a, b) => a - b)).toEqual([
      10000, 15000,
    ]);
    const paymentIds = await pool.query<{ id: string }>(
      `SELECT id FROM payments WHERE tenant_id = $1 AND invoice_id = $2`,
      [tenant.tenantId, invoiceId],
    );
    expect(new Set(recorded.map((e) => e.metadata!.paymentId as string))).toEqual(
      new Set(paymentIds.rows.map((r) => r.id)),
    );
    // Every audited credit is stamped with the tenant that owns the money.
    expect(recorded.every((e) => e.tenantId === tenant.tenantId)).toBe(true);
  });

  it("a neighbour tenant's concurrent payment never counts toward this tenant's balance", async () => {
    // Both tenants pay their OWN invoice at the same moment. Same code path,
    // same pool, same instant — only tenant_id differs.
    const mine = {
      tenantId: tenant.tenantId,
      invoiceId,
      amountCents: 5000,
      method: 'cash' as const,
      providerReference: 'manual-cash-mine',
      processedBy: 'owner',
    };
    const theirs = {
      tenantId: otherTenant.tenantId,
      invoiceId: otherTenantInvoiceId,
      amountCents: 22000,
      method: 'bank_transfer' as const,
      providerReference: 'pi_ach_neighbour',
      processedBy: 'stripe_webhook',
    };

    await Promise.all([
      recordPayment(mine, invoiceRepo, paymentRepo, undefined, undefined, auditRepo),
      recordPayment(theirs, invoiceRepo, paymentRepo, undefined, undefined, auditRepo),
    ]);

    // This tenant's invoice moved by ITS payment only (25000 + 5000); the
    // neighbour's 22000 is nowhere in it.
    const mineReloaded = await invoiceRepo.findById(tenant.tenantId, invoiceId);
    expect(mineReloaded!.amountPaidCents).toBe(30000);
    expect(mineReloaded!.amountDueCents).toBe(0);
    expect(mineReloaded!.status).toBe('paid');

    // The neighbour's invoice moved by ITS payment only.
    const theirsReloaded = await invoiceRepo.findById(otherTenant.tenantId, otherTenantInvoiceId);
    expect(theirsReloaded!.amountPaidCents).toBe(22000);
    expect(theirsReloaded!.amountDueCents).toBe(8000);

    // Ledgers stay disjoint: three rows here (10000 + 15000 + 5000), one there.
    const mineRows = await pool.query<{ n: number; total: string }>(
      `SELECT count(*)::int AS n, COALESCE(sum(amount_cents), 0)::text AS total
         FROM payments WHERE tenant_id = $1 AND invoice_id = $2`,
      [tenant.tenantId, invoiceId],
    );
    expect(mineRows.rows[0].n).toBe(3);
    expect(Number(mineRows.rows[0].total)).toBe(30000);

    // Audit trails stay disjoint too — the neighbour's credit is not on this
    // tenant's invoice timeline, and this tenant cannot read the neighbour's.
    const mineEvents = await auditRepo.findByEntity(tenant.tenantId, 'invoice', invoiceId);
    expect(
      mineEvents
        .filter((e) => e.eventType === 'payment.recorded')
        .map((e) => e.metadata!.amountCents),
    ).not.toContain(22000);
    const crossRead = await auditRepo.findByEntity(
      tenant.tenantId,
      'invoice',
      otherTenantInvoiceId,
    );
    expect(crossRead).toEqual([]);
    const theirEvents = await auditRepo.findByEntity(
      otherTenant.tenantId,
      'invoice',
      otherTenantInvoiceId,
    );
    expect(theirEvents.filter((e) => e.eventType === 'payment.recorded')).toHaveLength(1);
  });
});
