/**
 * Docker-gated integration test for the customer negotiation-context provider
 * (src/customers/customer-negotiation-context.ts).
 *
 * Mocked-DB tests are NOT sufficient proof for this query (CLAUDE.md): it joins
 * invoices/appointments/payments to the customer via `jobs.customer_id` and sums
 * integer cents. This pins the real columns, the void-invoice exclusion, the
 * GREATEST(appointment, payment) recency, and tenant isolation.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { PgCustomerNegotiationContextProvider } from '../../src/customers/pg-customer-negotiation-context';
import { PgCustomerRepository } from '../../src/customers/pg-customer';
import { PgLocationRepository } from '../../src/locations/pg-location';
import { PgJobRepository } from '../../src/jobs/pg-job';
import { PgInvoiceRepository } from '../../src/invoices/pg-invoice';
import { PgPaymentRepository } from '../../src/invoices/pg-payment';
import { PgAppointmentRepository } from '../../src/appointments/pg-appointment';
import { buildLineItem, calculateDocumentTotals } from '../../src/shared/billing-engine';

describe('Postgres integration — customer negotiation context', () => {
  let pool: Pool;
  let provider: PgCustomerNegotiationContextProvider;
  let customerRepo: PgCustomerRepository;
  let locationRepo: PgLocationRepository;
  let jobRepo: PgJobRepository;
  let invoiceRepo: PgInvoiceRepository;
  let paymentRepo: PgPaymentRepository;
  let appointmentRepo: PgAppointmentRepository;

  let tenantA: { tenantId: string; userId: string };
  let tenantB: { tenantId: string; userId: string };

  // Customer A: rich history (LTV + recency + completed job).
  let customerAId: string;
  // Customer A2: exists but has zero history.
  let emptyCustomerId: string;
  // Customer B: belongs to a different tenant (isolation guard).
  let customerBId: string;

  const apptStart = new Date('2026-05-15T16:00:00.000Z'); // ~30 days before the payment
  const paymentAt = new Date('2026-06-09T18:30:00.000Z'); // the later interaction

  // Helper: create a customer + primary location, return the customer id.
  async function seedCustomer(
    tenant: { tenantId: string; userId: string },
    suffix: string,
  ): Promise<{ customerId: string; locationId: string }> {
    const customerId = crypto.randomUUID();
    await customerRepo.create({
      id: customerId,
      tenantId: tenant.tenantId,
      firstName: 'Test',
      lastName: suffix,
      displayName: `Test ${suffix}`,
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
    return { customerId, locationId };
  }

  async function seedJob(
    tenant: { tenantId: string; userId: string },
    customerId: string,
    locationId: string,
    jobNumber: string,
    status: 'scheduled' | 'completed',
  ): Promise<string> {
    const jobId = crypto.randomUUID();
    await jobRepo.create({
      id: jobId,
      tenantId: tenant.tenantId,
      customerId,
      locationId,
      jobNumber,
      summary: 'Test job',
      status,
      priority: 'normal',
      createdBy: tenant.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    return jobId;
  }

  async function seedInvoice(
    tenant: { tenantId: string; userId: string },
    jobId: string,
    invoiceNumber: string,
    status: 'paid' | 'partially_paid' | 'void',
    amountPaidCents: number,
  ): Promise<string> {
    const lineItems = [buildLineItem(crypto.randomUUID(), 'Labor', 1, 10000, 1, true, 'labor')];
    const totals = calculateDocumentTotals(lineItems, 0, 0);
    const invoice = await invoiceRepo.create({
      id: crypto.randomUUID(),
      tenantId: tenant.tenantId,
      jobId,
      invoiceNumber,
      status,
      lineItems,
      totals,
      amountPaidCents,
      amountDueCents: Math.max(0, totals.totalCents - amountPaidCents),
      createdBy: tenant.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    return invoice.id;
  }

  beforeAll(async () => {
    pool = await getSharedTestDb();
    provider = new PgCustomerNegotiationContextProvider(pool);
    customerRepo = new PgCustomerRepository(pool);
    locationRepo = new PgLocationRepository(pool);
    jobRepo = new PgJobRepository(pool);
    invoiceRepo = new PgInvoiceRepository(pool);
    paymentRepo = new PgPaymentRepository(pool);
    appointmentRepo = new PgAppointmentRepository(pool);

    tenantA = await createTestTenant(pool);
    tenantB = await createTestTenant(pool);

    // --- Customer A: a completed job + a scheduled job, three invoices
    //     (paid 5000, partially_paid 2500, void 9999), an appointment, and a
    //     completed payment. Expected LTV = 7500 (void excluded), 1 completed
    //     job, recency = the payment (later than the appointment).
    const a = await seedCustomer(tenantA, 'Alpha');
    customerAId = a.customerId;
    const completedJob = await seedJob(tenantA, customerAId, a.locationId, 'JOB-A1', 'completed');
    const scheduledJob = await seedJob(tenantA, customerAId, a.locationId, 'JOB-A2', 'scheduled');

    const paidInvoice = await seedInvoice(tenantA, completedJob, 'INV-A1', 'paid', 5000);
    await seedInvoice(tenantA, scheduledJob, 'INV-A2', 'partially_paid', 2500);
    await seedInvoice(tenantA, completedJob, 'INV-A3', 'void', 9999);

    await appointmentRepo.create({
      id: crypto.randomUUID(),
      tenantId: tenantA.tenantId,
      jobId: completedJob,
      scheduledStart: apptStart,
      scheduledEnd: new Date(apptStart.getTime() + 60 * 60 * 1000),
      timezone: 'America/Chicago',
      status: 'completed',
      createdBy: tenantA.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await paymentRepo.create({
      id: crypto.randomUUID(),
      tenantId: tenantA.tenantId,
      invoiceId: paidInvoice,
      amountCents: 5000,
      method: 'stripe',
      status: 'completed',
      receivedAt: paymentAt,
      processedBy: tenantA.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // --- Customer A2: no jobs, invoices, or appointments.
    const empty = await seedCustomer(tenantA, 'Empty');
    emptyCustomerId = empty.customerId;

    // --- Customer B on tenant B: a paid invoice that must NOT leak into A.
    const b = await seedCustomer(tenantB, 'Bravo');
    customerBId = b.customerId;
    const bJob = await seedJob(tenantB, customerBId, b.locationId, 'JOB-B1', 'completed');
    await seedInvoice(tenantB, bJob, 'INV-B1', 'paid', 100000);
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  it('sums collected cents across non-void invoices and counts completed jobs', async () => {
    const ctx = await provider.getContext(tenantA.tenantId, customerAId);
    expect(ctx.lifetimeValueCents).toBe(7500); // 5000 + 2500; the 9999 void invoice is excluded
    expect(ctx.jobsCompletedCount).toBe(1);
  });

  it('reports recency as the latest of the appointment and the completed payment', async () => {
    const ctx = await provider.getContext(tenantA.tenantId, customerAId);
    expect(ctx.lastSeenAt).not.toBeNull();
    // The payment (paymentAt) is later than the appointment (apptStart).
    expect(Math.abs(ctx.lastSeenAt!.getTime() - paymentAt.getTime())).toBeLessThan(1000);
  });

  it('returns an empty context for a customer with no history', async () => {
    const ctx = await provider.getContext(tenantA.tenantId, emptyCustomerId);
    expect(ctx.lifetimeValueCents).toBe(0);
    expect(ctx.jobsCompletedCount).toBe(0);
    expect(ctx.lastSeenAt).toBeNull();
  });

  it('does not leak another tenant\'s history (RLS isolation)', async () => {
    // Tenant A asking for tenant A's customer never sees tenant B's 100000.
    const aCtx = await provider.getContext(tenantA.tenantId, customerAId);
    expect(aCtx.lifetimeValueCents).toBe(7500);
    // Tenant B's own customer resolves correctly under tenant B's context.
    const bCtx = await provider.getContext(tenantB.tenantId, customerBId);
    expect(bCtx.lifetimeValueCents).toBe(100000);
  });
});
