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

function classifierReply(intentType: string, entities: Record<string, unknown>): string {
  return JSON.stringify({ intentType, confidence: 0.95, reasoning: 'test', extractedEntities: entities });
}

function buildApp(opts: {
  gateway: LLMGateway;
  proposalRepo: InMemoryProposalRepository;
  invoiceRepo: InMemoryInvoiceRepository;
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

  it('the job has NO invoice: the draft never carries the job id as invoiceId, gates on invoiceId, and approve refuses', async () => {
    const proposalRepo = new InMemoryProposalRepository();
    const invoiceRepo = new InMemoryInvoiceRepository(); // empty — nothing to send
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
    const payload = persisted.payload as Record<string, unknown>;
    // The live failure: the JOB's UUID sat in invoiceId and sailed through approval.
    expect(payload.invoiceId).toBeUndefined();
    expect(payload.invoiceReference).toBe(JOB_ID);
    expect(missingFieldsFor(persisted)).toContain('invoiceId');

    await expect(
      approveProposal(proposalRepo, TEST_TENANT, persisted.id, TEST_USER, 'owner'),
    ).rejects.toMatchObject({ details: { missingFields: ['invoiceId'] } });
  });
});
