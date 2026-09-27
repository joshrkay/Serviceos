/**
 * QA 2026-09-16 (matrix row AST-04) — the chat surface drafted `send_invoice`
 * for "Create and send an invoice for job <jobId> totaling $250" with the
 * JOB's UUID in payload.invoiceId; approve succeeded; execution failed with
 * "Invoice not found". Two seams conspired: SendInvoiceTaskHandler promoted a
 * literal UUID without checking what it named (pinned in
 * test/ai/tasks/voice-send-invoice.test.ts), and this route's
 * `dropUnverifiedIds` scrub keeps any id that appears in the operator's text
 * — which the job id did — while deleting any id that does not, which is what
 * a repo-resolved invoice id would be unless the handler marks it verified.
 *
 * This file pins the SURFACE outcome, which is what the operator sees: a
 * proposal that approves also executes, or it does not approve at all.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express, { type Request, type Response, type NextFunction } from 'express';
import request from 'supertest';
import { createAssistantRouter } from '../../src/routes/assistant';
import { InMemoryProposalRepository, missingFieldsFor } from '../../src/proposals/proposal';
import { approveProposal } from '../../src/proposals/actions';
import { InMemoryInvoiceRepository } from '../../src/invoices/invoice';
import { buildInvoice } from '../factories/invoice.factory';
import { buildJob } from '../factories/job.factory';
import { InMemoryJobRepository } from '../../src/jobs/job';
import type { AuthenticatedRequest } from '../../src/middleware/auth';
import type { LLMGateway, LLMResponse } from '../../src/ai/gateway/gateway';
import {
  setSupervisorPresenceLoader,
  _resetSupervisorPresenceCache,
} from '../../src/ai/supervisor-presence';

const TEST_TENANT = '11111111-1111-4111-8111-111111111111';
const TEST_USER = '22222222-2222-4222-8222-222222222222';
const JOB_ID = 'c73844bd-4928-4d1f-b8c5-f669ceb10018';
const INVOICE_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const CUSTOMER_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const PHRASE = `Create and send an invoice for job ${JOB_ID} totaling $250.`;

function gatewayReplying(content: string): LLMGateway {
  return {
    complete: vi.fn(
      async () =>
        ({
          content,
          model: 'mock',
          provider: 'mock',
          tokenUsage: { input: 1, output: 1, total: 2 },
          latencyMs: 1,
        }) satisfies LLMResponse,
    ),
  } as unknown as LLMGateway;
}

/**
 * One gateway for the whole turn: the intent classifier call gets the
 * classifier reply, the invoice drafting call (InvoiceTaskHandler, whose
 * system prompt opens "You are an invoice generation assistant") gets a
 * drafted invoice.
 */
function gatewayForTurn(classifier: string, invoiceDraft: string): LLMGateway {
  return {
    complete: vi.fn(async (req: { messages: Array<{ role: string; content: string }> }) => {
      const system = req.messages.find((m) => m.role === 'system')?.content ?? '';
      const content = system.startsWith('You are an invoice generation assistant') ? invoiceDraft : classifier;
      return {
        content,
        model: 'mock',
        provider: 'mock',
        tokenUsage: { input: 1, output: 1, total: 2 },
        latencyMs: 1,
      } satisfies LLMResponse;
    }),
  } as unknown as LLMGateway;
}

function classifierReply(intentType: string, entities: Record<string, unknown>): string {
  return JSON.stringify({ intentType, confidence: 0.95, reasoning: 'test', extractedEntities: entities });
}

function buildApp(opts: {
  gateway: LLMGateway;
  proposalRepo: InMemoryProposalRepository;
  invoiceRepo: InMemoryInvoiceRepository;
  jobRepo?: InMemoryJobRepository;
}) {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as AuthenticatedRequest).auth = {
      userId: TEST_USER,
      sessionId: 'sess-ast04',
      tenantId: TEST_TENANT,
      role: 'owner',
    };
    next();
  });
  app.use(
    '/api/assistant',
    createAssistantRouter({
      gateway: opts.gateway,
      proposalRepo: opts.proposalRepo,
      invoiceRepo: opts.invoiceRepo,
      ...(opts.jobRepo ? { jobRepo: opts.jobRepo } : {}),
      tenantTimezoneResolver: async () => 'America/Phoenix',
    }),
  );
  return app;
}

const chat = (app: ReturnType<typeof buildApp>, content: string) =>
  request(app)
    .post('/api/assistant/chat')
    .send({ messages: [{ role: 'user', content }], conversationId: '33333333-3333-4333-8333-333333333333' });

beforeEach(() => {
  setSupervisorPresenceLoader(async () => true);
});
afterEach(() => {
  _resetSupervisorPresenceCache();
  vi.restoreAllMocks();
});

describe('POST /api/assistant/chat — send_invoice for a job UUID (AST-04)', () => {
  it('the job has ONE invoice: the draft carries that invoice through the verified-id scrub, and approve succeeds', async () => {
    const proposalRepo = new InMemoryProposalRepository();
    const invoiceRepo = new InMemoryInvoiceRepository();
    // An ISSUED invoice (status open): the factory default is draft, which
    // send_invoice may not act on (D-023 keeps issuance a separate tap).
    await invoiceRepo.create(buildInvoice({ id: INVOICE_ID, tenantId: TEST_TENANT, jobId: JOB_ID, status: 'open' }));
    const app = buildApp({
      gateway: gatewayReplying(classifierReply('send_invoice', { jobReference: JOB_ID, sendChannel: 'sms' })),
      proposalRepo,
      invoiceRepo,
    });

    const res = await chat(app, PHRASE);
    expect(res.status).toBe(200);

    const [persisted] = await proposalRepo.findByTenant(TEST_TENANT);
    expect(persisted, 'a proposal should have been drafted').toBeTruthy();
    expect(persisted.proposalType).toBe('send_invoice');
    expect((persisted.payload as Record<string, unknown>).invoiceId).toBe(INVOICE_ID);
    expect(missingFieldsFor(persisted)).toEqual([]);

    const approved = await approveProposal(proposalRepo, TEST_TENANT, persisted.id, TEST_USER, 'owner');
    expect(approved.status).toBe('approved');
  });

  // #1393 — the operator asked to CREATE the invoice. With none on the job,
  // gating a send on an invoice that does not exist is a dead end (the live
  // AST-04 card asked for an "Invoice # or ID" prefilled with the job UUID).
  // The honest action is to draft the invoice from the job; sending is the
  // next step, after the operator approves the draft.
  it('the job has NO invoice: drafts the invoice from the job instead of gating a send on a nonexistent invoice', async () => {
    const proposalRepo = new InMemoryProposalRepository();
    const invoiceRepo = new InMemoryInvoiceRepository(); // empty — nothing to send
    const jobRepo = new InMemoryJobRepository();
    await jobRepo.create(buildJob({ id: JOB_ID, tenantId: TEST_TENANT, customerId: CUSTOMER_ID }));
    const app = buildApp({
      gateway: gatewayForTurn(
        classifierReply('send_invoice', { jobReference: JOB_ID, amount: 25000 }),
        JSON.stringify({
          lineItems: [{ description: 'Service', quantity: 1, unitPrice: 25000 }],
          confidence_score: 0.9,
        }),
      ),
      proposalRepo,
      invoiceRepo,
      jobRepo,
    });

    const res = await chat(app, PHRASE);
    expect(res.status).toBe(200);

    const persisted = await proposalRepo.findByTenant(TEST_TENANT);
    expect(persisted.map((p) => p.proposalType)).toEqual(['draft_invoice']);
    const payload = persisted[0].payload as Record<string, unknown>;
    expect(payload.jobId).toBe(JOB_ID);
    expect(payload.customerId).toBe(CUSTOMER_ID);
    expect(payload.invoiceId).toBeUndefined();
    expect(missingFieldsFor(persisted[0])).not.toContain('invoiceId');
    // The card is the draft, and the reply says sending comes after approval.
    expect(res.body.message.proposal.proposalType).toBe('draft_invoice');
    expect(res.body.message.content).toMatch(/send/i);
  });

  // #1393 — without create wording the ask really is "send the existing one",
  // so the gate stays. But the card's "Invoice # or ID" box was prefilled with
  // the JOB's UUID: an id that is provably not an invoice, one tap from being
  // submitted as one.
  it('plain send for a job with no invoice stays gated, and never prefills the job id into the invoice-id field', async () => {
    const proposalRepo = new InMemoryProposalRepository();
    const invoiceRepo = new InMemoryInvoiceRepository();
    const app = buildApp({
      gateway: gatewayReplying(classifierReply('send_invoice', { jobReference: JOB_ID, sendChannel: 'sms' })),
      proposalRepo,
      invoiceRepo,
    });

    const res = await chat(app, `Text the customer the invoice for job ${JOB_ID}.`);
    expect(res.status).toBe(200);

    const card = res.body.message.proposal;
    expect(card.proposalType).toBe('send_invoice');
    const invoiceField = (card.editFields as Array<{ key: string; value: string }>).find(
      (f) => f.key === 'invoiceId',
    );
    expect(invoiceField, 'the gated invoiceId keeps its Edit control').toBeTruthy();
    expect(invoiceField!.value).toBe('');
  });
});
