/**
 * Seeds the money rows the L5 reconciliation gate joins against: a job (with
 * its customer and location), an invoice on it, and a completed payment whose
 * `reference_number` is the Stripe payment_intent. Shared by the
 * webhook_events minimization suites, which prove the gate still matches on a
 * minimized receipt.
 */
import crypto from 'crypto';
import type { Pool } from 'pg';
import { PgInvoiceRepository } from '../../src/invoices/pg-invoice';
import { PgPaymentRepository } from '../../src/invoices/pg-payment';
import { PgCustomerRepository } from '../../src/customers/pg-customer';
import { PgLocationRepository } from '../../src/locations/pg-location';
import { PgJobRepository } from '../../src/jobs/pg-job';
import { buildLineItem, calculateDocumentTotals } from '../../src/shared/billing-engine';
import type { TestTenant } from './shared';

/** A paid invoice of `amountCents` with one completed payment referencing `paymentIntent`. */
export async function seedPaidInvoice(
  pool: Pool,
  tenant: TestTenant,
  opts: { amountCents: number; paymentIntent: string },
): Promise<string> {
  const customerId = crypto.randomUUID();
  await new PgCustomerRepository(pool).create({
    id: customerId,
    tenantId: tenant.tenantId,
    firstName: 'Recon',
    lastName: 'Seed',
    displayName: 'Recon Seed',
    preferredChannel: 'phone',
    smsConsent: false,
    isArchived: false,
    createdBy: tenant.userId,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  const locationId = crypto.randomUUID();
  await new PgLocationRepository(pool).create({
    id: locationId,
    tenantId: tenant.tenantId,
    customerId,
    street1: '1 Invariant Way',
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
  await new PgJobRepository(pool).create({
    id: jobId,
    tenantId: tenant.tenantId,
    customerId,
    locationId,
    jobNumber: `JOB-${jobId.slice(0, 8)}`,
    summary: 'Reconciliation seed job',
    status: 'completed',
    priority: 'normal',
    createdBy: tenant.userId,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  const invoiceId = crypto.randomUUID();
  const lineItems = [buildLineItem(crypto.randomUUID(), 'Service', 1, opts.amountCents, 0, true, 'labor')];
  const totals = calculateDocumentTotals(lineItems, 0, 0);
  await new PgInvoiceRepository(pool).create({
    id: invoiceId,
    tenantId: tenant.tenantId,
    jobId,
    invoiceNumber: `INV-${invoiceId.slice(0, 8)}`,
    status: 'paid',
    lineItems,
    totals,
    amountPaidCents: opts.amountCents,
    amountDueCents: 0,
    createdBy: tenant.userId,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  await new PgPaymentRepository(pool).create({
    id: crypto.randomUUID(),
    tenantId: tenant.tenantId,
    invoiceId,
    amountCents: opts.amountCents,
    method: 'credit_card',
    status: 'completed',
    providerReference: opts.paymentIntent,
    receivedAt: new Date(),
    processedBy: 'stripe_webhook',
    createdAt: new Date(),
    updatedAt: new Date(),
    refundedAmountCents: 0,
    refundedAt: null,
    lastRefundStripeId: null,
    reversedAt: null,
    reversalReason: null,
  });
  return invoiceId;
}
