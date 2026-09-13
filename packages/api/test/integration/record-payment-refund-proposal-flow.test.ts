/**
 * Postgres integration — A22/A37 (2026-08-29 AI-catalog sweep, #912).
 *
 * A22: `record_payment` drafted with only a resolver-verified
 * `existingEntities.invoiceId` (never a raw UUID handed to the classifier,
 * exactly what `RecordPaymentTaskHandler` receives on the real chat/voice
 * path once the router's entity resolver has run) used to draft
 * `missingFields: ['invoiceId']` unconditionally — the proposal approved
 * cleanly and then execution deterministically failed with "Payload must
 * include a valid invoiceId UUID". This pins the FIXED chain end to end
 * against a real Postgres invoice/payment schema (a mocked Pool cannot
 * prove `recordPayment()`'s real column names or its PAYABLE_STATUSES /
 * amountDueCents guards — CLAUDE.md: "mocked-DB never sole proof for
 * queries").
 *
 * A37: `record_refund` fails execution with "This invoice has no completed
 * payments with refundable amount remaining" whenever the invoice has no
 * completed payment yet — RATIFIED-correct behavior, not a bug in
 * `RecordRefundTaskHandler`/`RecordRefundExecutionHandler` (see #912 and
 * the 34→0 plan's WS-B brief: "downstream of A22 — flips when A22 lands +
 * fixture has a completed payment"). This test proves that self-heal: once
 * the A22 chain above records a real completed payment, drafting and
 * executing `record_refund` against the SAME invoice succeeds with no
 * further code change.
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
import { buildLineItem, calculateDocumentTotals } from '../../src/shared/billing-engine';
import { RecordPaymentTaskHandler, RecordRefundTaskHandler } from '../../src/ai/tasks/voice-extended-tasks';
import { RecordPaymentExecutionHandler } from '../../src/proposals/execution/voice-extended-handlers';
import { RecordRefundExecutionHandler } from '../../src/proposals/execution/record-refund-handler';
import type { TaskContext } from '../../src/ai/tasks/task-handlers';
import { missingFieldsFor } from '../../src/proposals/proposal';

describe('Postgres integration — record_payment / record_refund proposal flow (A22/A37)', () => {
  let pool: Pool;
  let invoiceRepo: PgInvoiceRepository;
  let paymentRepo: PgPaymentRepository;
  let tenant: { tenantId: string; userId: string };
  let invoiceId: string;

  function ctx(overrides: Partial<TaskContext> = {}): TaskContext {
    return { tenantId: tenant.tenantId, userId: tenant.userId, message: 'test transcript', ...overrides };
  }

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
      firstName: 'QA',
      lastName: 'Matrix',
      displayName: 'QA Matrix',
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
      street1: '1 Sweep Way',
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
      jobNumber: 'JOB-A22',
      summary: 'QA Sweep Furnace Inspection',
      status: 'scheduled',
      priority: 'normal',
      createdBy: tenant.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const lineItems = [buildLineItem(crypto.randomUUID(), 'Diagnostic visit', 1, 45000, 0, true, 'labor')];
    const totals = calculateDocumentTotals(lineItems, 0, 0);

    invoiceId = crypto.randomUUID();
    // status 'open' — recordPayment()'s PAYABLE_STATUSES gate requires it
    // (draft/void/paid invoices are not payable).
    await invoiceRepo.create({
      id: invoiceId,
      tenantId: tenant.tenantId,
      jobId,
      invoiceNumber: 'INV-A22',
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

  it('A22: drafts ungated from a router-verified existingEntities.invoiceId and executes a real payment write', async () => {
    // Simulates the router-resolved seam RecordPaymentTaskHandler reads on
    // the real chat/voice path — record_payment is an INVOICE_DOC_INTENT, so
    // the entity resolver has already verified the spoken invoice reference
    // by the time this handler runs (ai/agents/customer-calling/
    // entity-resolution.ts).
    const draftResult = await new RecordPaymentTaskHandler().handle(
      ctx({
        existingEntities: {
          invoiceId,
          customerName: 'QA Matrix',
          amount: 45000,
          paymentMethod: 'check',
          paymentReference: 'check 2044',
        },
      }),
    );

    expect(draftResult.proposal.proposalType).toBe('record_payment');
    expect(draftResult.proposal.payload.invoiceId).toBe(invoiceId);
    // BEFORE the A22 fix this was unconditionally gated even with a
    // resolver-verified invoiceId in existingEntities.
    expect(missingFieldsFor(draftResult.proposal)).toEqual([]);

    const executed = await new RecordPaymentExecutionHandler(paymentRepo, invoiceRepo).execute(
      draftResult.proposal,
      { tenantId: tenant.tenantId, executedBy: tenant.userId },
    );
    // BEFORE the fix this proposal never reached a real payment write in
    // the real flow — every draft was permanently gated on invoiceId.
    expect(executed.success).toBe(true);
    expect(executed.resultEntityId).toBeTruthy();

    const payments = await paymentRepo.findByInvoice(tenant.tenantId, invoiceId);
    expect(payments).toHaveLength(1);
    expect(payments[0].status).toBe('completed');
    expect(payments[0].amountCents).toBe(45000);
    expect(payments[0].refundedAmountCents).toBe(0);

    const invoice = await invoiceRepo.findById(tenant.tenantId, invoiceId);
    expect(invoice?.amountPaidCents).toBe(45000);
  });

  it('A37: record_refund self-heals once a completed payment exists — no code change needed beyond the A22 fix', async () => {
    // This row only makes sense after the A22 test above has recorded a
    // real completed payment against invoiceId — record_refund's execution
    // handler filters payments to status === 'completed' with positive
    // refundable headroom (record-refund-handler.ts).
    const draftResult = await new RecordRefundTaskHandler().handle(
      ctx({
        existingEntities: {
          invoiceId,
          amount: 10000,
          refundReason: "recharge didn't hold",
        } as Record<string, unknown>,
      }),
    );

    expect(draftResult.proposal.proposalType).toBe('record_refund');
    expect(draftResult.proposal.payload.invoiceId).toBe(invoiceId);
    expect(missingFieldsFor(draftResult.proposal)).toEqual([]);

    const executed = await new RecordRefundExecutionHandler(paymentRepo).execute(draftResult.proposal, {
      tenantId: tenant.tenantId,
      executedBy: tenant.userId,
    });
    // BEFORE the A22 fix, no completed payment ever existed on the real
    // flow (record_payment's own proposal never got past drafting), so this
    // failed with "This invoice has no completed payments with refundable
    // amount remaining" on every run — not because of a bug in
    // record_refund itself, but because its precondition never became true.
    expect(executed.success).toBe(true);

    const payments = await paymentRepo.findByInvoice(tenant.tenantId, invoiceId);
    const refunded = payments.find((p) => p.refundedAmountCents > 0);
    expect(refunded).toBeDefined();
    expect(refunded?.refundedAmountCents).toBe(10000);
  });
});
