/**
 * Docker-gated integration tests — NOT run in web sessions. Requires the
 * testcontainer Postgres started by `npm run test:integration`.
 *
 * fix/approve-stall-five — five chat/voice-session proposal types
 * (update_invoice=A04, send_payment_reminder=A20, apply_late_fee=A21,
 * notify_delay=A31, update_brand_voice=A48) were flagged by the
 * 2026-08-29T23-20-24-666Z AI-catalog sweep as stalling at
 * `ready_for_review` forever after `POST /api/proposals/:id/approve` was
 * called — `approve_no_terminal_status: ready_for_review`.
 *
 * The sweep runner's `approveAndAwaitExecution` (scripts/ai-catalog-sweep/
 * run-sweep.mjs) discards the approve POST's own response body — it only
 * polls a later GET — so a 4xx from `approveProposal` is invisible; the
 * reported status is just whatever the GET saw afterward. This file drives
 * the REAL chat/voice-session drafting path against REAL seeded Postgres
 * rows, then calls the REAL `approveProposal` guard (the exact function the
 * sweep's opaque approve POST resolves to) and asserts what it does — the
 * static+local pin the live sweep couldn't give us.
 *
 * Per row, `describe` block names the row id and states the verified root
 * cause / fix in its own comment.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { Pool } from 'pg';
import express, { type Request, type Response, type NextFunction } from 'express';
import supertest from 'supertest';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { PgEntityResolver } from '../../src/ai/resolution/pg-entity-resolver';
import { PgAppointmentRepository } from '../../src/appointments/pg-appointment';
import { PgJobRepository } from '../../src/jobs/pg-job';
import { PgCustomerRepository } from '../../src/customers/pg-customer';
import { PgLocationRepository } from '../../src/locations/pg-location';
import { PgInvoiceRepository } from '../../src/invoices/pg-invoice';
import { PgDunningEventRepository } from '../../src/invoices/pg-dunning-config';
import { PgAuditRepository } from '../../src/audit/pg-audit';
import { createAssistantRouter } from '../../src/routes/assistant';
import type { AuthenticatedRequest } from '../../src/middleware/auth';
import type { LLMGateway, LLMResponse } from '../../src/ai/gateway/gateway';
import {
  InMemoryProposalRepository,
  missingFieldsFor,
  type Proposal,
} from '../../src/proposals/proposal';
import { approveProposal } from '../../src/proposals/actions';
import { InMemoryProposalExecutionRepository } from '../../src/proposals/proposal-execution';
import { ProposalExecutor } from '../../src/proposals/execution/executor';
import { IdempotencyGuard } from '../../src/proposals/execution/idempotency';
import {
  createExecutionHandlerRegistry,
  type ExecutionContext,
} from '../../src/proposals/execution/handlers';
import { UNDO_WINDOW_MS } from '../../src/proposals/lifecycle';
import {
  setSupervisorPresenceLoader,
  _resetSupervisorPresenceCache,
} from '../../src/ai/supervisor-presence';
import type { TransactionalCommsService, ReminderDeliveryOutcome } from '../../src/notifications/transactional-comms-service';
import { calculateDocumentTotals, buildLineItem } from '../../src/shared/billing-engine';
import type { Invoice } from '../../src/invoices/invoice';

const TZ = 'America/Phoenix';
const CUSTOMER_NAME = 'qa-matrix-A-customer';

function classifierReply(intentType: string, entities: Record<string, unknown>): string {
  return JSON.stringify({ intentType, confidence: 0.95, reasoning: 'test', extractedEntities: entities });
}

function scriptedGateway(responses: string[]): LLMGateway {
  let i = 0;
  return {
    complete: vi.fn(
      async () =>
        ({
          content: responses[Math.min(i++, responses.length - 1)],
          model: 'mock',
          provider: 'mock',
          tokenUsage: { input: 1, output: 1, total: 2 },
          latencyMs: 1,
        }) satisfies LLMResponse,
    ),
  } as unknown as LLMGateway;
}

describe('Integration — fix/approve-stall-five (real Postgres + real resolver)', () => {
  let pool: Pool;
  let resolver: PgEntityResolver;
  let appointmentRepo: PgAppointmentRepository;
  let jobRepo: PgJobRepository;
  let customerRepo: PgCustomerRepository;
  let locationRepo: PgLocationRepository;
  let invoiceRepo: PgInvoiceRepository;
  let dunningEventRepo: PgDunningEventRepository;
  let auditRepo: PgAuditRepository;

  beforeAll(async () => {
    pool = await getSharedTestDb();
    resolver = new PgEntityResolver(pool);
    appointmentRepo = new PgAppointmentRepository(pool);
    jobRepo = new PgJobRepository(pool);
    customerRepo = new PgCustomerRepository(pool);
    locationRepo = new PgLocationRepository(pool);
    invoiceRepo = new PgInvoiceRepository(pool);
    dunningEventRepo = new PgDunningEventRepository(pool);
    auditRepo = new PgAuditRepository(pool);
    setSupervisorPresenceLoader(async () => true);
  });

  afterAll(async () => {
    _resetSupervisorPresenceCache();
    await closeSharedTestDb();
  });

  interface Seed {
    tenantId: string;
    userId: string;
    customerId: string;
    jobId: string;
  }

  async function seedTenant(customerName = CUSTOMER_NAME): Promise<Seed> {
    const t = await createTestTenant(pool);
    await pool.query(
      `INSERT INTO tenant_settings (id, tenant_id, business_name, timezone, region)
       VALUES ($1, $2, 'Sweep Test Shop', $3, 'AZ')`,
      [crypto.randomUUID(), t.tenantId, TZ],
    );

    const customerId = crypto.randomUUID();
    await customerRepo.create({
      id: customerId,
      tenantId: t.tenantId,
      firstName: customerName,
      lastName: '',
      displayName: customerName,
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
      street1: '9 Elm Court',
      city: 'Mesa',
      state: 'AZ',
      postalCode: '85201',
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
      jobNumber: `JOB-STALL5-${jobId.slice(0, 8)}`,
      summary: 'Furnace tune-up',
      status: 'scheduled',
      priority: 'normal',
      createdBy: t.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    return { tenantId: t.tenantId, userId: t.userId, customerId, jobId };
  }

  /** A second, unrelated customer with their own job + appointment. Negative
   * control: the tenant genuinely has more than one active appointment, so
   * a resolution that "just picks one" would be caught. */
  async function seedOtherCustomerWithAppointment(seed: Seed, start: Date): Promise<string> {
    const customerId = crypto.randomUUID();
    await customerRepo.create({
      id: customerId,
      tenantId: seed.tenantId,
      firstName: 'Wendell',
      lastName: 'Okonkwo',
      displayName: 'Wendell Okonkwo',
      preferredChannel: 'phone',
      smsConsent: false,
      isArchived: false,
      createdBy: seed.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const locationId = crypto.randomUUID();
    await locationRepo.create({
      id: locationId,
      tenantId: seed.tenantId,
      customerId,
      street1: '41 Saguaro Way',
      city: 'Tempe',
      state: 'AZ',
      postalCode: '85281',
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
      tenantId: seed.tenantId,
      customerId,
      locationId,
      jobNumber: `JOB-STALL5B-${jobId.slice(0, 8)}`,
      summary: 'Water heater replacement',
      status: 'scheduled',
      priority: 'normal',
      createdBy: seed.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const appointmentId = crypto.randomUUID();
    await appointmentRepo.create({
      id: appointmentId,
      tenantId: seed.tenantId,
      jobId,
      scheduledStart: start,
      scheduledEnd: new Date(start.getTime() + 60 * 60 * 1000),
      timezone: TZ,
      status: 'scheduled',
      holdPendingApproval: false,
      createdBy: seed.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    return appointmentId;
  }

  async function seedAppointment(seed: Seed, start: Date): Promise<string> {
    const id = crypto.randomUUID();
    await appointmentRepo.create({
      id,
      tenantId: seed.tenantId,
      jobId: seed.jobId,
      scheduledStart: start,
      scheduledEnd: new Date(start.getTime() + 2 * 60 * 60 * 1000),
      timezone: TZ,
      status: 'scheduled',
      holdPendingApproval: false,
      createdBy: seed.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    return id;
  }

  /** A minimal open/issued invoice — the state apply_late_fee/
   * send_payment_reminder both require. `invoiceNumber` mirrors the corpus's
   * real fixture ("INV-0001") so free-text resolution is realistic. */
  async function seedIssuedInvoice(seed: Seed, invoiceNumber = 'INV-0001'): Promise<Invoice> {
    const line = buildLineItem(crypto.randomUUID(), 'Furnace tune-up', 1, 45000, 0, false, 'labor');
    const totals = calculateDocumentTotals([line], 0, 0);
    const invoice: Invoice = {
      id: crypto.randomUUID(),
      tenantId: seed.tenantId,
      jobId: seed.jobId,
      invoiceNumber,
      status: 'open',
      lineItems: [line],
      totals,
      amountPaidCents: 0,
      amountDueCents: totals.totalCents,
      issuedAt: new Date(),
      dueDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      createdBy: seed.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    await invoiceRepo.create(invoice);
    return invoice;
  }

  /** A draft (unissued) invoice — the state A04's update_invoice targets. */
  async function seedDraftInvoice(seed: Seed, invoiceNumber = 'INV-0001'): Promise<Invoice> {
    const line = buildLineItem(crypto.randomUUID(), 'Furnace tune-up', 1, 45000, 0, false, 'labor');
    const totals = calculateDocumentTotals([line], 0, 0);
    const invoice: Invoice = {
      id: crypto.randomUUID(),
      tenantId: seed.tenantId,
      jobId: seed.jobId,
      invoiceNumber,
      status: 'draft',
      lineItems: [line],
      totals,
      amountPaidCents: 0,
      amountDueCents: totals.totalCents,
      createdBy: seed.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    await invoiceRepo.create(invoice);
    return invoice;
  }

  /** The REAL chat route, wired the way app.ts wires it. */
  function buildChatApp(
    seed: Seed,
    proposalRepo: InMemoryProposalRepository,
    gateway: LLMGateway,
    opts: { transactionalComms?: TransactionalCommsService } = {},
  ) {
    const app = express();
    app.use(express.json());
    app.use((req: Request, _res: Response, next: NextFunction) => {
      (req as AuthenticatedRequest).auth = {
        userId: seed.userId,
        sessionId: 'sess-stall5-int',
        tenantId: seed.tenantId,
        role: 'owner',
      };
      next();
    });
    app.use(
      '/api/assistant',
      createAssistantRouter({
        gateway,
        proposalRepo,
        entityResolver: resolver,
        appointmentRepo,
        jobRepo,
        customerRepo,
        locationRepo,
        invoiceRepo,
        dunningEventRepo,
        auditRepo,
        tenantTimezoneResolver: async () => TZ,
      }),
    );
    return app;
  }

  async function executeApproved(
    proposal: Proposal,
    opts: { transactionalComms?: TransactionalCommsService } = {},
  ): Promise<{ success: boolean; error?: string; resultEntityId?: string }> {
    const executionProposalRepo = new InMemoryProposalRepository();
    const executionRepo = new InMemoryProposalExecutionRepository();
    const handlers = createExecutionHandlerRegistry({
      appointmentRepo,
      jobRepo,
      customerRepo,
      locationRepo,
      invoiceRepo,
      dunningEventRepo,
      auditRepo,
      transactionalComms: opts.transactionalComms,
    });
    const guard = new IdempotencyGuard(executionRepo, executionProposalRepo);
    const executor = new ProposalExecutor(handlers, executionProposalRepo, guard, auditRepo);
    // The undo window must have closed before the executor will act.
    const ready = { ...proposal, approvedAt: new Date(Date.now() - UNDO_WINDOW_MS - 100) };
    await executionProposalRepo.create(ready);
    const context: ExecutionContext = { tenantId: ready.tenantId, executedBy: ready.tenantId };
    const { result } = await executor.execute(ready, context);
    return result;
  }

  // ─────────────────────────────────────────────────────────────────────
  // A04 — update_invoice. Real bug, fixed: InvoiceEditTaskHandler's OWN
  // `resolveInvoiceId` ran an entirely separate, bespoke free-text search
  // (over `payload.invoiceReference`, from this handler's OWN internal LLM
  // extraction pass) and NEVER lifted the `invoiceId` gate for it, by
  // deliberate design — an ILIKE-matched reference was stamped onto the
  // payload for review-card display only (see the method's doc comment).
  // It never once consulted `resolvedInvoiceIdFrom(context)`, the SAME
  // shared pre-draft resolver seam `ApplyLateFeeTaskHandler` /
  // `SendPaymentReminderTaskHandler` / `SendInvoiceTaskHandler` already
  // trust (voice-extended-tasks.ts) — populated from the classifier's OWN
  // extraction (`entities.jobReference`, the catch-all field every
  // INVOICE_DOC_INTENTS member reuses) BEFORE `handle()` ever runs, and
  // already registered in `sourceContext.verifiedIds` so it survives
  // `dropUnverifiedIds`. A resolver-verified match sat right next to the
  // gate with nothing wired to lift it (the #909 class):
  // `missingFields: ['invoiceId']` stuck forever, and `approveProposal`
  // refused every update_invoice proposal chat ever drafted. Fixed by
  // checking `resolvedInvoiceIdFrom(context)` first in `resolveInvoiceId`
  // (invoice-edit-task.ts), falling back to the handler's own search only
  // when that shared seam comes up empty. This test proves the fixed
  // mechanism closes the gate end to end against a real resolver + a real
  // seeded invoice row.
  // ─────────────────────────────────────────────────────────────────────
  it('A04 update_invoice: chat draft → resolve (shared pre-draft resolver seam) → approve → execute adds the real line item', async () => {
    const seed = await seedTenant();
    const invoice = await seedDraftInvoice(seed);

    const proposalRepo = new InMemoryProposalRepository();
    const app = buildChatApp(
      seed,
      proposalRepo,
      scriptedGateway([
        classifierReply('update_invoice', { jobReference: invoice.invoiceNumber, amount: 7500 }),
        JSON.stringify({
          invoiceReference: invoice.invoiceNumber,
          editActions: [
            { type: 'add_line_item', lineItem: { description: 'filter', quantity: 1, unitPrice: 7500 } },
          ],
          confidence_score: 0.9,
        }),
      ]),
    );

    const res = await supertest(app)
      .post('/api/assistant/chat')
      .send({
        messages: [
          { role: 'user', content: `Add a 75 dollar filter line to invoice ${invoice.invoiceNumber}` },
        ],
      });
    expect(res.status).toBe(200);

    const [drafted] = await proposalRepo.findByTenant(seed.tenantId);
    expect(drafted).toBeTruthy();
    expect(drafted.proposalType).toBe('update_invoice');
    // InvoiceEditTaskHandler's OWN resolution stamps this for display, but
    // ONLY the post-draft generic lifter is allowed to clear the gate.
    expect(drafted.payload.invoiceId).toBe(invoice.id);
    expect(missingFieldsFor(drafted)).toEqual([]);

    // The exact call that stalled at 'ready_for_review' forever in the live
    // sweep (A04, reason `approve_no_terminal_status: ready_for_review`).
    const approved = await approveProposal(proposalRepo, seed.tenantId, drafted.id, seed.userId, 'owner');
    expect(approved.status).toBe('approved');

    const result = await executeApproved(approved);
    expect(result.success, result.error).toBe(true);

    const updated = await invoiceRepo.findById(seed.tenantId, invoice.id);
    expect(updated).toBeTruthy();
    expect(
      updated!.lineItems.some((li) => li.description === 'filter' && li.unitPriceCents === 7500),
    ).toBe(true);
  });

  // ─────────────────────────────────────────────────────────────────────
  // A20 — send_payment_reminder. Wiring check confirmed complete on main:
  // SendPaymentReminderTaskHandler reads `context.existingEntities.invoiceId`
  // (resolvedInvoiceIdFrom), which the chat pre-draft resolver populates for
  // every INVOICE_DOC_INTENTS member off `entities.jobReference` (the shared
  // free-text-reference field every invoice-doc intent's classifier
  // extraction reuses — there is no separate `invoiceReference` field).
  // This test PROVES that wiring closes the loop end to end with a real
  // resolver over a real invoice row.
  // ─────────────────────────────────────────────────────────────────────
  it('A20 send_payment_reminder: chat draft → resolve → approve → execute records a real dunning event', async () => {
    const seed = await seedTenant();
    const invoice = await seedIssuedInvoice(seed);

    const proposalRepo = new InMemoryProposalRepository();
    let sent: { tenantId: string; invoiceId: string; occurrenceToken: string } | undefined;
    const fakeComms = {
      notifyInvoiceOverdue: vi.fn(
        async (tenantId: string, invoiceId: string, occurrenceToken: string): Promise<ReminderDeliveryOutcome> => {
          sent = { tenantId, invoiceId, occurrenceToken };
          return { status: 'sent' };
        },
      ),
    } as unknown as TransactionalCommsService;

    const app = buildChatApp(
      seed,
      proposalRepo,
      scriptedGateway([
        classifierReply('send_payment_reminder', {
          customerName: CUSTOMER_NAME,
          jobReference: invoice.invoiceNumber,
        }),
      ]),
    );

    const res = await supertest(app)
      .post('/api/assistant/chat')
      .send({
        messages: [
          {
            role: 'user',
            content: `Send ${CUSTOMER_NAME} a payment reminder on invoice ${invoice.invoiceNumber}`,
          },
        ],
      });
    expect(res.status).toBe(200);

    const [drafted] = await proposalRepo.findByTenant(seed.tenantId);
    expect(drafted).toBeTruthy();
    expect(drafted.proposalType).toBe('send_payment_reminder');
    expect(drafted.payload.invoiceId).toBe(invoice.id);
    expect(missingFieldsFor(drafted)).toEqual([]);

    // The exact call that stalled at 'ready_for_review' forever in the live
    // sweep (reason: approve_no_terminal_status).
    const approved = await approveProposal(proposalRepo, seed.tenantId, drafted.id, seed.userId, 'owner');
    expect(approved.status).toBe('approved');

    const result = await executeApproved(approved, { transactionalComms: fakeComms });
    expect(result.success, result.error).toBe(true);
    expect(sent?.invoiceId).toBe(invoice.id);

    const { rows } = await pool.query(
      `SELECT * FROM invoice_dunning_events WHERE tenant_id = $1 AND invoice_id = $2`,
      [seed.tenantId, invoice.id],
    );
    expect(rows.length).toBeGreaterThan(0);
  });

  // ─────────────────────────────────────────────────────────────────────
  // A21 — apply_late_fee. Same wiring family as A20 (ApplyLateFeeTaskHandler
  // also consumes resolvedInvoiceIdFrom). Flagship full draft → approve →
  // execute proof: the real invoice row gets a real late-fee line item in
  // Postgres, matching the sweep's own dbVerify target table (`invoices`).
  // ─────────────────────────────────────────────────────────────────────
  it('A21 apply_late_fee: chat draft → resolve → approve → execute appends a real fee line to the real invoice', async () => {
    const seed = await seedTenant();
    const invoice = await seedIssuedInvoice(seed);

    const proposalRepo = new InMemoryProposalRepository();
    const app = buildChatApp(
      seed,
      proposalRepo,
      scriptedGateway([
        classifierReply('apply_late_fee', {
          customerName: CUSTOMER_NAME,
          jobReference: invoice.invoiceNumber,
          amount: 2500,
        }),
      ]),
    );

    const res = await supertest(app)
      .post('/api/assistant/chat')
      .send({
        messages: [
          { role: 'user', content: `Apply a 25 dollar late fee to invoice ${invoice.invoiceNumber}` },
        ],
      });
    expect(res.status).toBe(200);

    const [drafted] = await proposalRepo.findByTenant(seed.tenantId);
    expect(drafted.proposalType).toBe('apply_late_fee');
    expect(drafted.payload.invoiceId).toBe(invoice.id);
    expect(drafted.payload.feeCents).toBe(2500);
    expect(missingFieldsFor(drafted)).toEqual([]);

    const approved = await approveProposal(proposalRepo, seed.tenantId, drafted.id, seed.userId, 'owner');
    expect(approved.status).toBe('approved');

    const result = await executeApproved(approved);
    expect(result.success, result.error).toBe(true);

    const updated = await invoiceRepo.findById(seed.tenantId, invoice.id);
    expect(updated).toBeTruthy();
    expect(updated!.lineItems.some((li) => li.description === 'Late fee' && li.totalCents === 2500)).toBe(true);
    expect(updated!.amountDueCents).toBe(invoice.amountDueCents + 2500);
  });

  // ─────────────────────────────────────────────────────────────────────
  // A31 — notify_delay. TWO compounding root causes, both fixed:
  //
  // 1. `notify_delay` was ABSENT from routes/assistant.ts's
  //    `CHAT_CONTEXT_CUSTOMER_ID_INTENTS` allowlist, so `context.customerId`
  //    never threaded through on chat and `NotifyDelayTaskHandler`'s
  //    customer-scoped `resolveActiveAppointmentId` could only auto-pick
  //    when the ENTIRE TENANT had exactly one active appointment — never
  //    true with a second customer's appointment also on the books, and the
  //    utterance never names a specific appointment either. This alone
  //    reproduces the sweep's exact symptom: `missingFields: ['appointmentId']`
  //    with nothing that can ever lift it (the #909 "gate with no lifter"
  //    class) — `approveProposal` refuses forever. Fixed by adding
  //    'notify_delay' to that allowlist (routes/assistant.ts).
  //
  // 2. Fixing (1) exposed a SECOND, subtler bug the sweep's evidence
  //    couldn't distinguish (its approve-response body was discarded): once
  //    `resolveActiveAppointmentId` DOES resolve a real id,
  //    `NotifyDelayTaskHandler` set `payload.appointmentId` but never
  //    recorded it in `sourceContext.verifiedIds`. routes/assistant.ts's
  //    `dropUnverifiedIds` scrub — which deletes any id-shaped payload
  //    value that isn't verbatim in the operator's words unless it's
  //    allowlisted there — then deleted it right back out (a spoken
  //    customer name never contains the appointment's UUID), and because
  //    this handler's resolved branch never pushes 'appointmentId' onto
  //    `missing` either, the proposal was left with NO appointmentId AND NO
  //    gate: it read as fully approvable but was doomed to fail at
  //    execution — worse than a stall. Fixed by stamping
  //    `sourceContext.verifiedIds.appointmentId` (ai/tasks/
  //    voice-extended-tasks.ts), mirroring InvoiceEditTaskHandler's
  //    verifiedIds stamp for its own repo-confirmed invoiceId.
  // ─────────────────────────────────────────────────────────────────────
  it('A31 notify_delay: chat draft → resolve (customer-scoped) → approve → execute, with a second customer\'s appointment present as a negative control', async () => {
    const seed = await seedTenant();
    const start = new Date(Date.now() + 2 * 60 * 60 * 1000);
    const appointmentId = await seedAppointment(seed, start);

    // A second, unrelated customer's appointment. Pre-fix, unscoped
    // resolution saw TWO active appointments tenant-wide and stayed gated
    // forever (no appointmentReference in the utterance to fall back on).
    const other = await seedOtherCustomerWithAppointment(seed, new Date(start.getTime() + 3 * 60 * 60 * 1000));
    expect(other).not.toBe(appointmentId);

    const proposalRepo = new InMemoryProposalRepository();
    const app = buildChatApp(
      seed,
      proposalRepo,
      scriptedGateway([
        classifierReply('notify_delay', {
          customerName: CUSTOMER_NAME,
          delayMinutes: 30,
        }),
      ]),
    );

    const res = await supertest(app)
      .post('/api/assistant/chat')
      .send({
        messages: [{ role: 'user', content: `Tell ${CUSTOMER_NAME} we're running 30 minutes late` }],
      });
    expect(res.status).toBe(200);

    const [drafted] = await proposalRepo.findByTenant(seed.tenantId);
    expect(drafted).toBeTruthy();
    expect(drafted.proposalType).toBe('notify_delay');
    // The fix's defining assertion: customer-scoped resolution picked the
    // RIGHT appointment despite a second, unrelated one in the tenant.
    expect(drafted.payload.appointmentId).toBe(appointmentId);
    expect(missingFieldsFor(drafted)).toEqual([]);

    // The exact call that stalled at 'ready_for_review' forever in the live
    // sweep (A31, reason `approve_no_terminal_status: ready_for_review`).
    const approved = await approveProposal(proposalRepo, seed.tenantId, drafted.id, seed.userId, 'owner');
    expect(approved.status).toBe('approved');

    const result = await executeApproved(approved);
    expect(result.success, result.error).toBe(true);
    expect(result.resultEntityId).toBe(appointmentId);
  });
});
