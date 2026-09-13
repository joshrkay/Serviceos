/**
 * Postgres integration — P0-1: voiding an invoice kills its charge vectors.
 *
 * #1022 row 8.7. The void → payment-link deactivation → PaymentIntent
 * cancellation path was unit-only (in-memory repo + fake provider). This drives
 * the SAME production service — `transitionInvoiceStatus` (src/invoices/
 * invoice.ts:539), which calls `deactivateInvoicePaymentLink` (invoice-payment-
 * link.ts:150) and `cancelInvoicePaymentIntents` (invoice-payment-link.ts:295)
 * — against REAL Postgres through `PgInvoiceRepository`, and reads the audit
 * rows back through the REAL `PgAuditRepository`.
 *
 * What is proven here, and what is NOT:
 *
 *  - PROVEN at real Postgres: the link columns are persisted by the guarded
 *    `setPaymentLinkIfPayable` UPDATE and CLEARED by the `clearPaymentLinkIfMatches`
 *    CAS; the status flip commits; the `invoice.payment_link_deactivated` and
 *    `invoice.payment_intent_canceled` audit rows exist and are tenant-scoped;
 *    a neighbour tenant's live link and audit trail are untouched by this
 *    tenant's void, and a cross-tenant void attempt is a no-op.
 *
 *  - NOT proven: that STRIPE deactivated anything. The provider seam is
 *    `MockPaymentLinkProvider` (src/payments/payment-link-provider.ts:68) —
 *    an in-repo fake — and the PI half uses a test-local fake implementing the
 *    optional `listInvoicePaymentIntents` / `cancelPaymentIntent` capability
 *    (the Mock provider does not implement them, so the sweep no-ops through
 *    it). There are no Stripe test-mode credentials in this sandbox and no
 *    recorded cassettes in the repo, so the provider call is RECORDED, never
 *    verified against Stripe. Everything on OUR side of that seam is real.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'crypto';
import type { Pool } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { PgInvoiceRepository } from '../../src/invoices/pg-invoice';
import { PgCustomerRepository } from '../../src/customers/pg-customer';
import { PgLocationRepository } from '../../src/locations/pg-location';
import { PgJobRepository } from '../../src/jobs/pg-job';
import { PgAuditRepository } from '../../src/audit/pg-audit';
import { transitionInvoiceStatus } from '../../src/invoices/invoice';
import { createInvoicePaymentLink } from '../../src/invoices/invoice-payment-link';
import { MockPaymentLinkProvider } from '../../src/payments/payment-link-provider';
import type {
  InvoicePaymentIntentSummary,
  PaymentLinkProvider,
} from '../../src/payments/payment-link-provider';
import { buildLineItem, calculateDocumentTotals } from '../../src/shared/billing-engine';

/**
 * The Mock provider deliberately does not implement the optional PaymentIntent
 * capability, so `cancelInvoicePaymentIntents` no-ops through it. This fake
 * adds it — and RECORDS the calls, which is the only thing a fake can prove.
 */
class PaymentIntentCapableFake extends MockPaymentLinkProvider implements PaymentLinkProvider {
  readonly canceled: string[] = [];
  readonly listedFor: Array<{ invoiceId: string; stripeAccountId?: string }> = [];

  constructor(private readonly intents: InvoicePaymentIntentSummary[]) {
    super();
  }

  async listInvoicePaymentIntents(
    _tenantId: string,
    invoiceId: string,
    stripeAccountId?: string,
  ): Promise<InvoicePaymentIntentSummary[]> {
    this.listedFor.push({ invoiceId, stripeAccountId });
    return this.intents;
  }

  async cancelPaymentIntent(paymentIntentId: string): Promise<void> {
    this.canceled.push(paymentIntentId);
  }
}

describe('Postgres integration — voiding an invoice kills its payment link + intents (P0-1)', () => {
  let pool: Pool;
  let invoiceRepo: PgInvoiceRepository;
  let auditRepo: PgAuditRepository;
  let tenant: { tenantId: string; userId: string };
  let otherTenant: { tenantId: string; userId: string };
  let jobId: string;
  let otherTenantJobId: string;

  /** Seed one tenant's customer → location → job chain; returns the job id. */
  async function seedJobChain(
    t: { tenantId: string; userId: string },
    label: string,
  ): Promise<string> {
    const customerRepo = new PgCustomerRepository(pool);
    const locationRepo = new PgLocationRepository(pool);
    const jobRepo = new PgJobRepository(pool);

    const customerId = crypto.randomUUID();
    await customerRepo.create({
      id: customerId,
      tenantId: t.tenantId,
      firstName: 'Void',
      lastName: 'Link',
      displayName: 'Void Link',
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
      street1: '9 Void Way',
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
    const newJobId = crypto.randomUUID();
    await jobRepo.create({
      id: newJobId,
      tenantId: t.tenantId,
      customerId,
      locationId,
      jobNumber: `JOB-${label}`,
      summary: 'Void link job',
      status: 'scheduled',
      priority: 'normal',
      createdBy: t.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    return newJobId;
  }

  async function seedOpenInvoice(
    t: { tenantId: string; userId: string },
    job: string,
    label: string,
    totalCents: number,
  ): Promise<string> {
    const invoiceId = crypto.randomUUID();
    const lineItems = [
      buildLineItem(crypto.randomUUID(), 'Service', 1, totalCents, 0, true, 'labor'),
    ];
    const totals = calculateDocumentTotals(lineItems, 0, 0);
    await invoiceRepo.create({
      id: invoiceId,
      tenantId: t.tenantId,
      jobId: job,
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
    return invoiceId;
  }

  /** Raw column read — the persisted truth, not the mapped object. */
  async function linkColumns(
    tenantId: string,
    invoiceId: string,
  ): Promise<{ id: string | null; url: string | null; status: string }> {
    const { rows } = await pool.query<{
      stripe_payment_link_id: string | null;
      stripe_payment_link_url: string | null;
      status: string;
    }>(
      `SELECT stripe_payment_link_id, stripe_payment_link_url, status
         FROM invoices WHERE tenant_id = $1 AND id = $2`,
      [tenantId, invoiceId],
    );
    return {
      id: rows[0].stripe_payment_link_id,
      url: rows[0].stripe_payment_link_url,
      status: rows[0].status,
    };
  }

  beforeAll(async () => {
    pool = await getSharedTestDb();
    invoiceRepo = new PgInvoiceRepository(pool);
    auditRepo = new PgAuditRepository(pool);
    tenant = await createTestTenant(pool);
    otherTenant = await createTestTenant(pool);
    jobId = await seedJobChain(tenant, 'VOID-1');
    otherTenantJobId = await seedJobChain(otherTenant, 'VOID-NEIGHBOUR');
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  it('void deactivates the hosted link, clears the real columns, and audits it', async () => {
    const invoiceId = await seedOpenInvoice(tenant, jobId, 'VOID-A', 40000);
    const provider = new MockPaymentLinkProvider();

    // Mint through the real service → the guarded UPDATE persists the columns.
    const minted = await createInvoicePaymentLink(
      tenant.tenantId,
      invoiceId,
      invoiceRepo,
      provider,
    );
    const before = await linkColumns(tenant.tenantId, invoiceId);
    expect(before.url).toBe(minted.url);
    expect(before.id).not.toBeNull();
    const linkId = before.id!;
    expect(provider.isActive(linkId)).toBe(true);

    // Void through the real service, with the link cleanup armed exactly as
    // the routes arm it.
    const voided = await transitionInvoiceStatus(
      tenant.tenantId,
      invoiceId,
      'void',
      invoiceRepo,
      undefined,
      {
        auditRepo,
        actor: { actorId: tenant.userId, actorRole: 'owner' },
        paymentLink: { provider },
      },
    );
    expect(voided!.status).toBe('void');

    // The link is dead at the provider and the columns are cleared, so no
    // later Pay Now can serve it.
    expect(provider.isActive(linkId)).toBe(false);
    const after = await linkColumns(tenant.tenantId, invoiceId);
    expect(after.status).toBe('void');
    expect(after.id).toBeNull();
    expect(after.url).toBeNull();

    // Both halves are on the audit trail, read back from real Postgres.
    const events = await auditRepo.findByEntity(tenant.tenantId, 'invoice', invoiceId);
    const types = events.map((e) => e.eventType);
    expect(types).toContain('invoice.status_changed');
    expect(types).toContain('invoice.payment_link_deactivated');
    const deactivated = events.find((e) => e.eventType === 'invoice.payment_link_deactivated')!;
    expect(deactivated.metadata!.stripePaymentLinkId).toBe(linkId);
    expect(deactivated.metadata!.reason).toBe('voided');
    expect(deactivated.actorId).toBe(tenant.userId);
    expect(deactivated.tenantId).toBe(tenant.tenantId);
    // No failure event alongside the success — those are mutually exclusive.
    expect(types).not.toContain('invoice.payment_link_deactivation_failed');
    expect(types).not.toContain('invoice.payment_link_clear_failed');
  });

  it('void cancels the live PaymentIntents it finds and skips the terminal ones', async () => {
    const invoiceId = await seedOpenInvoice(tenant, jobId, 'VOID-B', 25000);
    const provider = new PaymentIntentCapableFake([
      { id: 'pi_live_secret', status: 'requires_confirmation' },
      { id: 'pi_already_paid', status: 'succeeded' },
    ]);
    await createInvoicePaymentLink(tenant.tenantId, invoiceId, invoiceRepo, provider);

    await transitionInvoiceStatus(tenant.tenantId, invoiceId, 'void', invoiceRepo, undefined, {
      auditRepo,
      actor: { actorId: tenant.userId, actorRole: 'owner' },
      paymentLink: { provider },
    });

    // The confirmable intent is cancelled; the succeeded one is left alone
    // (Stripe refuses to cancel it, and its money is already real).
    expect(provider.canceled).toEqual(['pi_live_secret']);
    expect(provider.listedFor).toEqual([{ invoiceId, stripeAccountId: undefined }]);

    const events = await auditRepo.findByEntity(tenant.tenantId, 'invoice', invoiceId);
    const canceledEvents = events.filter((e) => e.eventType === 'invoice.payment_intent_canceled');
    expect(canceledEvents).toHaveLength(1);
    expect(canceledEvents[0].metadata!.stripePaymentIntentId).toBe('pi_live_secret');
    expect(canceledEvents[0].metadata!.reason).toBe('voided');
    expect(events.map((e) => e.eventType)).not.toContain('invoice.payment_intent_cancel_failed');
  });

  it("a neighbour tenant's live link survives this tenant's void, and its void cannot be driven cross-tenant", async () => {
    const mineInvoiceId = await seedOpenInvoice(tenant, jobId, 'VOID-C', 15000);
    const theirInvoiceId = await seedOpenInvoice(
      otherTenant,
      otherTenantJobId,
      'VOID-C-NEIGHBOUR',
      15000,
    );
    // One provider instance holds BOTH tenants' links — so if the void reached
    // across the tenant line, the neighbour's link would go dead here.
    const provider = new MockPaymentLinkProvider();
    await createInvoicePaymentLink(tenant.tenantId, mineInvoiceId, invoiceRepo, provider);
    await createInvoicePaymentLink(
      otherTenant.tenantId,
      theirInvoiceId,
      invoiceRepo,
      provider,
    );
    const mineLinkId = (await linkColumns(tenant.tenantId, mineInvoiceId)).id!;
    const theirLinkId = (await linkColumns(otherTenant.tenantId, theirInvoiceId)).id!;
    expect(mineLinkId).not.toBe(theirLinkId);

    // The neighbour cannot void THIS tenant's invoice: the tenant-scoped read
    // finds nothing, so the transition is a no-op and the link stays live.
    const crossTenant = await transitionInvoiceStatus(
      otherTenant.tenantId,
      mineInvoiceId,
      'void',
      invoiceRepo,
      undefined,
      {
        auditRepo,
        actor: { actorId: otherTenant.userId, actorRole: 'owner' },
        paymentLink: { provider },
      },
    );
    expect(crossTenant).toBeNull();
    expect(provider.isActive(mineLinkId)).toBe(true);
    expect((await linkColumns(tenant.tenantId, mineInvoiceId)).status).toBe('open');

    // This tenant voids its own invoice…
    await transitionInvoiceStatus(tenant.tenantId, mineInvoiceId, 'void', invoiceRepo, undefined, {
      auditRepo,
      actor: { actorId: tenant.userId, actorRole: 'owner' },
      paymentLink: { provider },
    });
    expect(provider.isActive(mineLinkId)).toBe(false);

    // …and the neighbour's invoice is still open, still payable, still linked.
    expect(provider.isActive(theirLinkId)).toBe(true);
    const theirs = await linkColumns(otherTenant.tenantId, theirInvoiceId);
    expect(theirs.status).toBe('open');
    expect(theirs.id).toBe(theirLinkId);

    // Audit trails do not cross either way.
    expect(
      (await auditRepo.findByEntity(tenant.tenantId, 'invoice', mineInvoiceId)).map(
        (e) => e.eventType,
      ),
    ).toContain('invoice.payment_link_deactivated');
    expect(await auditRepo.findByEntity(otherTenant.tenantId, 'invoice', mineInvoiceId)).toEqual(
      [],
    );
    expect(await auditRepo.findByEntity(otherTenant.tenantId, 'invoice', theirInvoiceId)).toEqual(
      [],
    );
  });
});
