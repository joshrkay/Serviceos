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
import { recordPayment } from '../../src/invoices/payment';
import { buildLineItem, calculateDocumentTotals } from '../../src/shared/billing-engine';

describe('Postgres integration — concurrent distinct payments both credit the invoice', () => {
  let pool: Pool;
  let invoiceRepo: PgInvoiceRepository;
  let paymentRepo: PgPaymentRepository;
  let tenant: { tenantId: string; userId: string };
  let invoiceId: string;

  beforeAll(async () => {
    pool = await getSharedTestDb();
    invoiceRepo = new PgInvoiceRepository(pool);
    paymentRepo = new PgPaymentRepository(pool);
    const customerRepo = new PgCustomerRepository(pool);
    const locationRepo = new PgLocationRepository(pool);
    const jobRepo = new PgJobRepository(pool);
    tenant = await createTestTenant(pool);

    const customerId = crypto.randomUUID();
    await customerRepo.create({
      id: customerId,
      tenantId: tenant.tenantId,
      firstName: 'Con',
      lastName: 'Current',
      displayName: 'Con Current',
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
      tenantId: tenant.tenantId,
      customerId,
      locationId,
      jobNumber: 'JOB-RACE-1',
      summary: 'Race pay job',
      status: 'scheduled',
      priority: 'normal',
      createdBy: tenant.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    invoiceId = crypto.randomUUID();
    const lineItems = [buildLineItem(crypto.randomUUID(), 'Service', 1, 30000, 0, true, 'labor')];
    const totals = calculateDocumentTotals(lineItems, 0, 0);
    await invoiceRepo.create({
      id: invoiceId,
      tenantId: tenant.tenantId,
      jobId,
      invoiceNumber: 'INV-RACE-1',
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

    // Fire both concurrently — they interleave at their await points.
    await Promise.all([
      recordPayment(cash, invoiceRepo, paymentRepo),
      recordPayment(ach, invoiceRepo, paymentRepo),
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
  });
});
