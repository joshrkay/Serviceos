/**
 * #1498 slices 3–4 — document numbers on the DRAFTING side of
 * POST /api/assistant/chat, plus the P3 money-state refusals.
 *
 *   C16  "Create an invoice for job JOB-0081." asked for the customer's name:
 *        the job resolver never scored `job_number`, so JOB-0081 matched
 *        nothing and the draft gated on a customer the operator had named.
 *   C21  "Send a payment reminder for invoice INV-0060." asked for the invoice
 *        number — and INV-0060 is already PAID, which nobody flagged.
 *   C26  "Mark INV-0067 as paid" drafted record_payment on a DRAFT invoice.
 *
 * Seam: the chat route with a scripted gateway answering the classifier (the
 * intent the production classifier returned, per the recorded `taskType`) and
 * in-memory repos behind the real route.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express, { type Request, type Response, type NextFunction } from 'express';
import request from 'supertest';
import { createAssistantRouter } from '../../src/routes/assistant';
import { InMemoryProposalRepository, missingFieldsFor } from '../../src/proposals/proposal';
import type { AuthenticatedRequest } from '../../src/auth/clerk';
import type { LLMGateway, LLMResponse } from '../../src/ai/gateway/gateway';
import type { EntityResolver } from '../../src/ai/resolution/entity-resolver';
import { InMemoryJobRepository } from '../../src/jobs/job';
import { InMemoryInvoiceRepository } from '../../src/invoices/invoice';
import type { Invoice, InvoiceStatus } from '../../src/invoices/invoice';
import { buildJob } from '../factories/job.factory';
import {
  setSupervisorPresenceLoader,
  _resetSupervisorPresenceCache,
} from '../../src/ai/supervisor-presence';

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const JOB_ID = '9b2c4d6e-1f3a-4b5c-8d7e-0a1b2c3d4e5f';
const CUSTOMER = '7c9e6679-7425-40de-944b-e07fc1f90ae7';

function classifierReply(intentType: string, entities: Record<string, unknown>): string {
  return JSON.stringify({ intentType, confidence: 0.95, reasoning: 'test', extractedEntities: entities });
}

/** Classifier and drafting model answered by task, not by call order. */
function gatewayByTask(replies: Record<string, string>): LLMGateway {
  return {
    complete: vi.fn(
      async (req: { taskType?: string }) =>
        ({
          content: replies[req.taskType ?? ''] ?? '{}',
          model: 'mock',
          provider: 'mock',
          tokenUsage: { input: 1, output: 1, total: 2 },
          latencyMs: 1,
        }) satisfies LLMResponse,
    ),
  } as unknown as LLMGateway;
}

/** Free text finds nothing — only a literal number can name the record. */
const nothingByName = {
  resolve: vi.fn(async () => ({ kind: 'not_found' })),
} as unknown as EntityResolver;

function buildApp(
  gateway: LLMGateway,
  proposalRepo: InMemoryProposalRepository,
  extraDeps: Partial<Parameters<typeof createAssistantRouter>[0]> = {},
) {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as AuthenticatedRequest).auth = { userId: USER, sessionId: 'sess', tenantId: TENANT, role: 'owner' };
    next();
  });
  app.use(
    '/api/assistant',
    createAssistantRouter({
      gateway,
      proposalRepo,
      entityResolver: nothingByName,
      tenantTimezoneResolver: async () => 'America/New_York',
      ...extraDeps,
    }),
  );
  return app;
}

beforeEach(() => {
  setSupervisorPresenceLoader(async () => true);
});
afterEach(() => {
  _resetSupervisorPresenceCache();
});

describe('#1498 slice 3 — JOB- numbers resolve on drafts', () => {
  it('C16: "Create an invoice for job JOB-0081." drafts for that job\'s customer, not "reply with the customer\'s name"', async () => {
    const jobRepo = new InMemoryJobRepository();
    await jobRepo.create(buildJob({ id: JOB_ID, tenantId: TENANT, customerId: CUSTOMER, jobNumber: 'JOB-0081' }));
    await jobRepo.create(buildJob({ tenantId: TENANT, jobNumber: 'JOB-0082' }));
    const proposalRepo = new InMemoryProposalRepository();
    const app = buildApp(
      gatewayByTask({
        classify_intent: classifierReply('create_invoice', { jobReference: 'JOB-0081' }),
        draft_invoice: JSON.stringify({
          lineItems: [{ description: 'Blower motor replacement', quantity: 1, unitPrice: 42500 }],
        }),
      }),
      proposalRepo,
      { jobRepo },
    );

    await request(app)
      .post('/api/assistant/chat')
      .send({ messages: [{ role: 'user', content: 'Create an invoice for job JOB-0081.' }] });

    const [persisted] = await proposalRepo.findByTenant(TENANT);
    expect(persisted.proposalType).toBe('draft_invoice');
    expect(persisted.payload.jobId).toBe(JOB_ID);
    expect(persisted.payload.customerId).toBe(CUSTOMER);
    expect(missingFieldsFor(persisted)).not.toContain('customerId');
  });
});

/** A stable UUID per invoice number ("INV-0061" → …-000000000061). */
function invoiceIdFor(number: string): string {
  return `00000000-0000-4000-8000-00000000${number.slice(-4)}`;
}

function invoiceRow(number: string, status: InvoiceStatus, amountDueCents: number): Invoice {
  const now = new Date('2026-09-29T17:00:00Z');
  return {
    id: invoiceIdFor(number),
    tenantId: TENANT,
    jobId: JOB_ID,
    invoiceNumber: number,
    status,
    lineItems: [],
    totals: { subtotalCents: 18_000, discountCents: 0, taxCents: 0, totalCents: 18_000 } as never,
    amountPaidCents: 18_000 - amountDueCents,
    amountDueCents,
    createdBy: USER,
    createdAt: now,
    updatedAt: now,
  };
}

describe('#1498 slice 3 — INV- numbers resolve on invoice actions', () => {
  it('C21: "Send a payment reminder for invoice INV-0061." drafts the reminder for that invoice', async () => {
    const invoiceRepo = new InMemoryInvoiceRepository();
    await invoiceRepo.create(invoiceRow('INV-0061', 'open', 18_000));
    const proposalRepo = new InMemoryProposalRepository();
    const app = buildApp(
      gatewayByTask({ classify_intent: classifierReply('send_payment_reminder', {}) }),
      proposalRepo,
      { invoiceRepo },
    );

    await request(app)
      .post('/api/assistant/chat')
      .send({ messages: [{ role: 'user', content: 'Send a payment reminder for invoice INV-0061.' }] });

    const [persisted] = await proposalRepo.findByTenant(TENANT);
    expect(persisted.proposalType).toBe('send_payment_reminder');
    expect(persisted.payload.invoiceId).toBe(invoiceIdFor('INV-0061'));
    expect(missingFieldsFor(persisted)).not.toContain('invoiceId');
  });

  it('C21: a reminder for an invoice that is already PAID is refused, with the reason, and drafts nothing', async () => {
    const invoiceRepo = new InMemoryInvoiceRepository();
    await invoiceRepo.create(invoiceRow('INV-0060', 'paid', 0));
    const proposalRepo = new InMemoryProposalRepository();
    const app = buildApp(
      gatewayByTask({ classify_intent: classifierReply('send_payment_reminder', {}) }),
      proposalRepo,
      { invoiceRepo },
    );

    const res = await request(app)
      .post('/api/assistant/chat')
      .send({ messages: [{ role: 'user', content: 'Send a payment reminder for invoice INV-0060.' }] });

    expect(res.status).toBe(200);
    expect(res.body.message.content).toBe(
      "INV-0060 is already paid in full, so there's nothing to remind the customer about.",
    );
    expect(res.body.message.proposal).toBeUndefined();
    expect(await proposalRepo.findByTenant(TENANT)).toHaveLength(0);
  });
});

describe('#1498 slice 4 — "overdue" means past its due date', () => {
  it('C37: "Which invoices are overdue?" lists only the unpaid invoices whose due date has passed', async () => {
    const DAY = 86_400_000;
    const invoiceRepo = new InMemoryInvoiceRepository();
    const pastDue = { ...invoiceRow('INV-0050', 'open', 18_000), dueDate: new Date(Date.now() - 5 * DAY) };
    const notYetDue = { ...invoiceRow('INV-0055', 'open', 25_000), dueDate: new Date(Date.now() + 10 * DAY) };
    const partlyPaidPastDue = {
      ...invoiceRow('INV-0053', 'partially_paid', 5_000),
      dueDate: new Date(Date.now() - 2 * DAY),
    };
    const paidPastDue = { ...invoiceRow('INV-0040', 'paid', 0), dueDate: new Date(Date.now() - 9 * DAY) };
    for (const inv of [pastDue, notYetDue, partlyPaidPastDue, paidPastDue]) await invoiceRepo.create(inv);
    const app = buildApp(gatewayByTask({}), new InMemoryProposalRepository(), { invoiceRepo });

    const res = await request(app)
      .post('/api/assistant/chat')
      .send({ messages: [{ role: 'user', content: 'Which invoices are overdue?' }] });

    expect(res.body.message.content).toBe(
      '2 overdue invoices, $230.00 past due: INV-0050 — $180.00 due (open); INV-0053 — $50.00 due (partially_paid)',
    );
  });
});

describe('#1498 slice 4 — record_payment on a draft invoice', () => {
  it('C26: "Mark invoice INV-0067 as paid." on a DRAFT is refused with what to do instead', async () => {
    const invoiceRepo = new InMemoryInvoiceRepository();
    await invoiceRepo.create(invoiceRow('INV-0067', 'draft', 18_000));
    const proposalRepo = new InMemoryProposalRepository();
    const app = buildApp(
      gatewayByTask({ classify_intent: classifierReply('record_payment', {}) }),
      proposalRepo,
      { invoiceRepo },
    );

    const res = await request(app)
      .post('/api/assistant/chat')
      .send({ messages: [{ role: 'user', content: 'Mark invoice INV-0067 as paid.' }] });

    expect(res.body.message.content).toBe(
      "INV-0067 is still a draft — it hasn't been issued, so there's no payment to record yet. Issue it first, then record the payment.",
    );
    expect(await proposalRepo.findByTenant(TENANT)).toHaveLength(0);
  });
});
